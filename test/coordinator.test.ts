import assert from "node:assert/strict";
import test from "node:test";
import { Coordinator, type ClientEvent } from "../src/coordinator.ts";
import { loadConfig } from "../src/config.ts";
import { fixture } from "./helpers.ts";
import { saveConnection, validateConnection } from "../src/connections.ts";
import { Logger } from "../src/logging.ts";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  ConversationStore,
  DurableQueue,
  ModelSelectionStore,
} from "../src/queue.ts";
import { join } from "node:path";
import { ApprovalStore } from "../src/approval-store.ts";
import {
  componentIdentity,
  deploymentId,
  internalHeaders,
} from "../src/state.ts";

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

function waitingResponse(): ServerResponse & EventEmitter {
  return Object.assign(new EventEmitter(), {
    writableEnded: false,
  }) as ServerResponse & EventEmitter;
}

async function coordinatorFixture(
  t: test.TestContext,
): Promise<{ coordinator: Coordinator; events: ClientEvent[] }> {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    events: ClientEvent[] = [];
  const coordinator = new Coordinator(paths, config);
  await coordinator.queue.load();
  await coordinator.conversation.load();
  const internals = coordinator as any;
  internals.events.on("event", (event: ClientEvent) => events.push(event));
  return { coordinator, events };
}

async function coordinatorGet(
  coordinator: Coordinator,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const request = Readable.from([]) as unknown as IncomingMessage;
  request.url = path;
  request.method = "GET";
  request.headers = {};
  let status = 200,
    text = "";
  const response = {
    setHeader() {},
    writeHead(value: number) {
      status = value;
      return response;
    },
    end(value?: string) {
      text = value ?? "";
      return response;
    },
  } as unknown as ServerResponse;
  await (
    coordinator as unknown as {
      route(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).route(request, response);
  return { status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

async function coordinatorPost(
  coordinator: Coordinator,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const request = Readable.from([
    JSON.stringify(body),
  ]) as unknown as IncomingMessage;
  request.url = path;
  request.method = "POST";
  request.headers = { "content-type": "application/json", ...headers };
  let status = 200,
    text = "";
  const response = {
    setHeader() {},
    writeHead(value: number) {
      status = value;
      return response;
    },
    end(value?: string) {
      text = value ?? "";
      return response;
    },
  } as unknown as ServerResponse;
  await (
    coordinator as unknown as {
      route(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).route(request, response);
  return { status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

/* @covers LOG-D079FCFE
Given the coordinator accepts, claims, completes, or releases conversation work
	When it emits diagnostics for that transition
		Then it includes the conversation and message IDs without conversation text
*/
test("[LOG-D079FCFE] coordinator logs queue transitions without conversation text", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    lines: string[] = [],
    coordinator = new Coordinator(
      paths,
      config,
      {},
      new Logger({
        component: "coordinator",
        deploymentId: "test",
        level: "trace",
        format: "json",
        sink: (line) => lines.push(line),
      }),
    );
  await Promise.all([
    coordinator.queue.load(),
    coordinator.conversation.load(),
    coordinator.modelSelection.load(),
  ]);
  const token = await componentIdentity(paths);
  (coordinator as unknown as { token: string }).token = token;
  await coordinator.modelSelection.set({
    connection: "shared",
    provider: "anthropic",
    model: "claude",
    piVersion: "1",
    piImage: "image",
  });
  const secretText = "private conversation text",
    first = await coordinator.queue.enqueue(secretText),
    headers = internalHeaders("runner", token, deploymentId(paths));

  const claimed = await coordinatorPost(
    coordinator,
    "/integral/internal/claim",
    {},
    headers,
  );
  assert.equal(claimed.status, 200);
  await coordinatorPost(
    coordinator,
    `/integral/internal/work/${first.id}/complete`,
    { text: "private assistant text" },
    headers,
  );
  const second = await coordinator.queue.enqueue("another private message");
  await coordinatorPost(coordinator, "/integral/internal/claim", {}, headers);
  await coordinatorPost(
    coordinator,
    `/integral/internal/work/${second.id}/release`,
    { reason: "private failure reason" },
    headers,
  );

  const events = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  for (const [eventName, messageId] of [
    ["queue.message_claimed", first.id],
    ["queue.message_completed", first.id],
    ["queue.message_released", second.id],
  ]) {
    const event = events.find((candidate) => candidate.event === eventName);
    assert.equal(event?.message_id, messageId);
    assert.equal(event?.conversation_id, "terminal");
  }
  assert.doesNotMatch(lines.join(""), /private conversation text/);
  assert.doesNotMatch(lines.join(""), /private assistant text/);
  assert.doesNotMatch(lines.join(""), /another private message/);
  assert.doesNotMatch(lines.join(""), /private failure reason/);
});

/* @covers DISCORD-6640EECF
Given a task carries a Discord origin route
	When the task succeeds or is cancelled
		Then Integral does not emit an automatic Discord outcome notification
			And retains the complete outcome in the durable task record
	When the task fails and Integral emits its automatic Discord outcome notification
		Then Integral identifies the task by its `Task: <title>.` prompt title when present
			Or by a concise prompt description when no title is present
			And never includes the internal task, execution, or schedule ID
			And includes the failure timing and concise redacted recorded reason when available
			And includes retry guidance when available
			And sends the notification only to the stored Discord DM route
			And records a successfully delivered notification in the same Discord conversation's history
			And does not display the notification in the default terminal conversation or another channel
*/
test("[SCHEDULE-42E63F16] [DISCORD-6640EECF] Discord host commands use shared model, queue, task, and approval state", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    coordinator = new Coordinator(paths, config),
    directory = join(paths.channels, "discord-test"),
    queue = new DurableQueue(join(directory, "queue.json")),
    conversation = new ConversationStore(join(directory, "conversation.jsonl")),
    modelSelection = new ModelSelectionStore(join(directory, "model.json")),
    discordReplies: string[] = [],
    scope = {
      id: "discord:100000000000000004",
      queue,
      conversation,
      modelSelection,
      discord: {
        listener: {
          async typing() {},
          async reply(text: string) {
            discordReplies.push(text);
          },
        },
        ingress: {},
        userId: "100000000000000003",
        channelId: "100000000000000004",
      },
    };
  await Promise.all([
    coordinator.queue.load(),
    coordinator.conversation.load(),
    coordinator.modelSelection.load(),
    queue.load(),
    conversation.load(),
    modelSelection.load(),
    coordinator.tasks.load(),
    coordinator.approvals.load(),
  ]);
  (coordinator as any).scopes.set(scope.id, scope);
  const terminal = await coordinator.queue.enqueue("terminal message"),
    discord = await queue.enqueue("discord message");
  await coordinator.conversation.append({
    type: "user",
    messageId: terminal.id,
    text: terminal.text,
  });
  await conversation.append({
    type: "user",
    messageId: discord.id,
    text: discord.text,
  });

  const listing = String(
    await (coordinator as any).discordCommand(scope, "queue", "ls", {}),
  );
  assert.match(listing, new RegExp(`terminal  ${terminal.id}`));
  assert.match(listing, new RegExp(`${scope.id}  ${discord.id}`));
  await (coordinator as any).discordCommand(scope, "queue", "edit", {
    id: terminal.id,
    text: "edited from Discord",
  });
  assert.equal(coordinator.queue.snapshot()[0]?.text, "edited from Discord");

  await coordinator.tasks.accept({
    executionId: "execution-1",
    scheduleId: "schedule-1",
    scheduleRevision: 1,
    triggerType: "once",
    scheduledFor: "2026-08-23T10:00:00.000Z",
    prompt: "prepare report",
    state: "accepted",
    dispatchAttempts: 1,
    createdAt: "2026-08-23T09:00:00.000Z",
    profile: {
      connection: "shared",
      provider: "anthropic",
      model: "claude",
      piVersion: "1",
      piImage: "image",
    },
  });
  const tasks = String(
    await (coordinator as any).discordCommand(scope, "tasks", "ls", {}),
  );
  assert.match(tasks, /queued {2}execution-1.*prepare report/);
  const shownTask = String(
    await (coordinator as any).discordCommand(scope, "tasks", "show", {
      id: "execution-1",
    }),
  );
  assert.match(shownTask, /"executionId": "execution-1"/);
  const cancelledTask = String(
    await (coordinator as any).discordCommand(scope, "tasks", "cancel", {
      id: "execution-1",
    }),
  );
  assert.match(cancelledTask, /^cancelled {2}execution-1/);

  const origin = {
    provider: "discord" as const,
    conversationId: scope.id,
    externalId: "message-1",
    userId: scope.discord.userId,
    channelId: scope.discord.channelId,
  };
  await coordinator.tasks.accept({
    executionId: "execution-succeeded",
    scheduleId: "schedule-recurring",
    scheduleRevision: 2,
    triggerType: "recurring",
    scheduledFor: "2026-08-23T10:30:00.000Z",
    prompt: "Task: Successful report. prepare the report",
    state: "accepted",
    dispatchAttempts: 1,
    createdAt: "2026-08-23T10:00:00.000Z",
    profile: {
      connection: "shared",
      provider: "anthropic",
      model: "claude",
      piVersion: "1",
      piImage: "image",
    },
    origin,
  });
  const successfulClaim = await coordinator.tasks.claim(),
    successful = await coordinator.tasks.start(
      successfulClaim!.executionId,
      successfulClaim!.claimId!,
    );
  await coordinator.tasks.declareOutcome(
    successful.executionId,
    successful.attempts[0]!.attemptId,
    "complete",
    "report complete",
  );
  await coordinator.tasks.complete(
    successful.executionId,
    successful.attempts[0]!.attemptId,
    "report complete",
    0,
  );
  await coordinator.tasks.accept({
    executionId: "execution-cancelled",
    scheduleId: "schedule-once",
    scheduleRevision: 1,
    triggerType: "once",
    scheduledFor: "2026-08-23T10:45:00.000Z",
    prompt: "Task: Cancelled report. prepare the report",
    state: "accepted",
    dispatchAttempts: 1,
    createdAt: "2026-08-23T10:00:00.000Z",
    profile: {
      connection: "shared",
      provider: "anthropic",
      model: "claude",
      piVersion: "1",
      piImage: "image",
    },
    origin,
  });
  await coordinator.tasks.cancel("execution-cancelled");
  const repliesBeforeOutcomes = discordReplies.length;
  await coordinator.flushTaskOutbox();
  assert.equal(discordReplies.length, repliesBeforeOutcomes);

  await coordinator.tasks.accept({
    executionId: "execution-failed",
    scheduleId: "schedule-recurring",
    scheduleRevision: 2,
    triggerType: "recurring",
    scheduledFor: "2026-08-23T11:00:00.000Z",
    prompt: "Task: Weekly source audit. prepare another report",
    state: "accepted",
    dispatchAttempts: 1,
    createdAt: "2026-08-23T10:00:00.000Z",
    profile: {
      connection: "shared",
      provider: "anthropic",
      model: "claude",
      piVersion: "1",
      piImage: "image",
    },
    origin,
  });
  const claim = await coordinator.tasks.claim(),
    running = await coordinator.tasks.start(
      claim!.executionId,
      claim!.claimId!,
    );
  await coordinator.tasks.fail(
    running.executionId,
    running.attempts[0]!.attemptId,
    "execution-failed request failed at https://private-token@example.test/api",
    1,
  );
  await coordinator.flushTaskOutbox();
  const failureNotice = discordReplies.find((text) =>
    text.includes("Weekly source audit"),
  );
  assert.match(failureNotice ?? "", /request failed/);
  assert.match(failureNotice ?? "", /failed at \d{4}-\d{2}-\d{2}T/);
  assert.match(
    failureNotice ?? "",
    /https:\/\/\[redacted\]@example\.test\/api/,
  );
  assert.match(failureNotice ?? "", /before the next scheduled occurrence/);
  assert.doesNotMatch(failureNotice ?? "", /execution-failed/);
  assert.doesNotMatch(failureNotice ?? "", /schedule-recurring/);
  const delivered = discordReplies.filter((text) =>
    text.includes("Weekly source audit"),
  ).length;
  assert.equal(delivered, 1);
  assert.ok(
    coordinator.tasks
      .outbox()
      .find((entry) => entry.executionId === "execution-failed")
      ?.notificationDeliveredAt,
  );
  await coordinator.flushTaskOutbox();
  assert.equal(
    discordReplies.filter((text) => text.includes("Weekly source audit"))
      .length,
    delivered,
  );

  await coordinator.tasks.accept({
    executionId: "execution-untitled",
    scheduleId: "schedule-recurring",
    scheduleRevision: 2,
    triggerType: "recurring",
    scheduledFor: "2026-08-23T12:00:00.000Z",
    prompt: "Prepare an untitled report. Include the current findings.",
    state: "accepted",
    dispatchAttempts: 1,
    createdAt: "2026-08-23T11:00:00.000Z",
    profile: {
      connection: "shared",
      provider: "anthropic",
      model: "claude",
      piVersion: "1",
      piImage: "image",
    },
    origin,
  });
  const untitledClaim = await coordinator.tasks.claim(),
    untitled = await coordinator.tasks.start(
      untitledClaim!.executionId,
      untitledClaim!.claimId!,
    );
  await coordinator.tasks.fail(
    untitled.executionId,
    untitled.attempts[0]!.attemptId,
    "report source unavailable",
    1,
  );
  await coordinator.flushTaskOutbox();
  const untitledNotice = discordReplies.find((text) =>
    text.startsWith("Prepare an untitled report failed at "),
  );
  assert.match(untitledNotice ?? "", /report source unavailable/);
  assert.doesNotMatch(untitledNotice ?? "", /execution-untitled/);

  const selection = {
    connection: "shared",
    provider: "anthropic",
    model: "claude",
    piVersion: "1",
    piImage: "image",
  };
  await (coordinator as any).setSharedModelSelection(selection);
  assert.deepEqual(coordinator.modelSelection.get(), selection);
  assert.deepEqual(modelSelection.get(), selection);

  const approval = await coordinator.approvals.create({
    request: {
      kind: "container-packages",
      operation: "install",
      packages: ["jq"],
      expectedRevision: 1,
    },
    sessionId: "session",
    selection,
    route: {
      provider: "discord",
      conversationId: scope.id,
      externalId: "message",
      userId: scope.discord.userId,
      channelId: scope.discord.channelId,
    },
  });
  const approvals = String(
    await (coordinator as any).discordCommand(scope, "approvals", "ls", {}),
  );
  assert.match(approvals, new RegExp(approval.id));
  const restoredApprovals = new ApprovalStore(paths);
  await restoredApprovals.load();
  assert.deepEqual(restoredApprovals.get(approval.id).origin.route, {
    provider: "discord",
    conversationId: scope.id,
    externalId: "message",
    userId: scope.discord.userId,
    channelId: scope.discord.channelId,
  });
  await (coordinator as any).discordCommand(scope, "approvals", "deny", {
    id: approval.id,
  });
  const denied = coordinator.approvals.snapshot()[0]!;
  assert.equal(denied.status, "denied");
  assert.equal(
    denied.decision?.terminalId,
    `discord:${scope.discord.userId}:${scope.discord.channelId}`,
  );
  assert.ok(discordReplies.some((text) => text.includes(approval.id)));
});

test("[SCHEDULE-F13C33A0] coordinator exposes complete durable task inspection", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    coordinator = new Coordinator(paths, config);
  await coordinator.tasks.load();
  await coordinator.tasks.accept({
    executionId: "execution-1",
    scheduleId: "schedule-1",
    scheduleRevision: 1,
    triggerType: "once",
    scheduledFor: "2026-08-23T10:00:00.000Z",
    prompt: "prepare report",
    profile: {
      connection: "work",
      provider: "anthropic",
      model: "claude",
      piVersion: "1",
      piImage: "image",
    },
    state: "accepted",
    dispatchAttempts: 1,
    createdAt: "2026-08-23T09:00:00.000Z",
  });

  const listing = await coordinatorGet(coordinator, "/integral/tasks");
  assert.equal(listing.status, 200);
  assert.equal(
    (listing.body as Array<{ executionId: string }>)[0]?.executionId,
    "execution-1",
  );
  const shown = await coordinatorGet(
    coordinator,
    "/integral/tasks/execution-1",
  );
  assert.equal(shown.status, 200);
  assert.deepEqual(
    Object.fromEntries(
      ["executionId", "scheduleId", "state", "attempts"].map((key) => [
        key,
        (shown.body as Record<string, unknown>)[key],
      ]),
    ),
    {
      executionId: "execution-1",
      scheduleId: "schedule-1",
      state: "queued",
      attempts: [],
    },
  );
  const missing = await coordinatorGet(coordinator, "/integral/tasks/missing");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "task not found: missing" });
});

/* @covers CHAT-54B8A1C3
Given one `integral talk` terminal is attached to the deployment conversation
	When the user starts another `integral talk` with the same `$INTEGRAL_HOME`
		Then the second terminal attaches to the same logical conversation
			And receives the same ordered conversation record
			And receives the same queue contents and order
			And observes the same selected model connection and model
			And observes the same Pi session and in-flight message
			And does not start another logical conversation or Pi container
*/
/* @covers CHAT-93E7D20B
Given every terminal has detached
	And the integral coordinator still owns the conversation
	When the user runs `integral talk` with the same `$INTEGRAL_HOME`
		Then the terminal receives a snapshot containing the existing conversation record and queue
			And omits session records from rendered conversation text
			And continues following new events without a snapshot-to-live gap
			And does not create a blank logical conversation
*/
test("[CHAT-54B8A1C3] [CHAT-93E7D20B] every attachment is a view over one coordinator-owned conversation and queue snapshot", async (t) => {
  const { coordinator } = await coordinatorFixture(t);
  const item = await coordinator.queue.enqueue("hello");
  await coordinator.conversation.append({
    type: "user",
    messageId: item.id,
    text: item.text,
  });
  const a = (coordinator as any).snapshot(),
    b = (coordinator as any).snapshot();
  assert.deepEqual(a.conversation, b.conversation);
  assert.equal(a.queue[0].id, item.id);
  assert.equal(b.queue[0].id, item.id);
});

/* @covers CHAT-D7E2F609
Given two or more terminals are attached to the same conversation
	When any terminal submits a message
		Then every attached terminal displays that same persisted user message once
	When Pi completes a response
		Then the coordinator persists the complete assistant response
			And every attached terminal displays that same response once
	When queue or session state changes
		Then every attached terminal observes the same resulting state
			And renders queue edits and deletions as host-side notices
			And renders session start and end events without exposing the session token
	When the selected model connection or model changes
		Then every attached terminal observes the same resulting selection
			And identifies its connection, provider, and model without exposing credentials
*/
/* @covers QUEUE-5B7C2E91
Given the integral coordinator is healthy
	When an attached terminal submits a non-empty message
		Then the coordinator assigns the message a stable opaque ID
			And formats each new ID as a canonical uppercase base-36 Snowflake
			And keeps newly assigned IDs unique across coordinator restarts and clock rollback
			And writes the message durably before acknowledging it
			And assigns it an order after all previously acknowledged messages
			And records its creation time, queued state, and zero delivery attempts
			And broadcasts the queued message and its ID to every attached terminal
	When a client submits an empty or whitespace-only message
		Then the coordinator rejects it without changing the queue or conversation
*/
test("[CHAT-D7E2F609] [QUEUE-5B7C2E91] queue changes broadcast one identical persisted event to every listener", async (t) => {
  const { coordinator, events } = await coordinatorFixture(t);
  const seenA: ClientEvent[] = [],
    seenB: ClientEvent[] = [],
    internals = coordinator as any;
  internals.events.on("event", (e: ClientEvent) => seenA.push(e));
  internals.events.on("event", (e: ClientEvent) => seenB.push(e));
  const item = await coordinator.queue.enqueue("shared");
  assert.equal(events[0]?.type, "queue.queued");
  assert.equal((events[0]?.data as any).message.id, item.id);
  assert.deepEqual(seenA, seenB);
});

test("[CHAT-888AFAE0] [CHAT-D7E2F609] user broadcasts identify their originating terminal without persisting it", async (t) => {
  const { coordinator, events } = await coordinatorFixture(t),
    internals = coordinator as any,
    item = await internals.submitMessage("hello", "terminal-a"),
    persisted = coordinator.conversation.snapshot().at(-1),
    broadcast = events.find((event) => event.type === "conversation.user");

  assert.equal(persisted?.messageId, item.id);
  assert.equal("terminalId" in persisted!, false);
  assert.equal((broadcast?.data as any).terminalId, "terminal-a");
  assert.equal((broadcast?.data as any).messageId, item.id);
});

test("[CHAT-6E91B4C7] [CHAT-C53A90D2] model choices are validated, persisted, broadcast, and locked during an in-flight turn", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    choices = [
      {
        connection: "work",
        provider: "openai-codex",
        model: "gpt-5.5",
        piVersion: "1.2.3",
        piImage: "sha256:new",
      },
      {
        connection: "personal",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        piVersion: "1.2.3",
        piImage: "sha256:new",
      },
    ],
    discoveries = { count: 0 },
    coordinator = new Coordinator(paths, config, {
      async listModelChoices() {
        discoveries.count++;
        return { choices, piVersion: "1.2.3" };
      },
    }),
    events: ClientEvent[] = [],
    internals = coordinator as any;
  internals.events.on("event", (event: ClientEvent) => events.push(event));
  const menu = await coordinator.modelMenu();
  assert.deepEqual(menu, {
    choices,
    current: null,
    piVersion: "1.2.3",
  });
  const selected = choices[0]!;
  await assert.rejects(
    coordinator.selectConversationModel("missing", "missing"),
    /no longer available/,
  );
  assert.deepEqual(
    await coordinator.selectConversationModel(
      selected.connection,
      selected.model,
    ),
    selected,
  );
  assert.deepEqual(internals.snapshot().modelSelection, selected);
  assert.equal(events.at(-1)?.type, "conversation.selection");
  assert.equal(discoveries.count, 1);

  await saveConnection(
    paths,
    validateConnection({
      name: "new-model-connection",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    "secret",
  );
  await coordinator.modelMenu();
  assert.equal(discoveries.count, 2);

  await coordinator.queue.enqueue("busy");
  await coordinator.queue.claim();
  await assert.rejects(
    coordinator.selectConversationModel(
      choices[1]!.connection,
      choices[1]!.model,
    ),
    /turn is in flight/,
  );
  assert.deepEqual(coordinator.modelSelection.get(), selected);

  const restored = new Coordinator(paths, config, {
    async listModelChoices() {
      return { choices, piVersion: "1.2.3" };
    },
  });
  await restored.modelSelection.load();
  assert.deepEqual(restored.modelSelection.get(), selected);
});

test("[BOX-40521095] package changes rebuild the selected exact Pi image and persist its identity", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    builds: Array<{
      version: string;
      packages: readonly string[];
      rebuild: boolean;
    }> = [],
    coordinator = new Coordinator(paths, config, {
      ensureImage(_config, version, options) {
        builds.push({
          version,
          packages: options.systemPackages,
          rebuild: options.rebuild,
        });
        return `sha256:packages-${builds.length}`;
      },
    });
  await coordinator.modelSelection.set({
    connection: "work",
    provider: "openai-codex",
    model: "gpt-5.5",
    piVersion: "9.8.7",
    piImage: "sha256:base",
  });
  assert.deepEqual(await coordinator.containerPackageInventory(), {
    revision: 0,
    packages: ["ca-certificates", "gh", "git"],
    piVersion: "9.8.7",
    piImage: "sha256:base",
  });
  const installed = await coordinator.changeContainerPackages({
    operation: "install",
    packages: ["jq"],
    expectedRevision: 0,
    actor: "pi:session-1",
    approvalId: "approval-install",
  });
  assert.deepEqual(installed, {
    revision: 1,
    packages: ["ca-certificates", "gh", "git", "jq"],
    piVersion: "9.8.7",
    piImage: "sha256:packages-1",
  });
  assert.deepEqual(builds, [
    {
      version: "9.8.7",
      packages: ["ca-certificates", "gh", "git", "jq"],
      rebuild: true,
    },
  ]);
  assert.equal(coordinator.modelSelection.get()?.piImage, "sha256:packages-1");
  const upgraded = await coordinator.changeContainerPackages({
    operation: "upgrade",
    packages: ["jq"],
    expectedRevision: 1,
    actor: "pi:session-1",
    approvalId: "approval-upgrade",
  });
  assert.equal(upgraded.revision, 2);
  assert.equal(upgraded.piImage, "sha256:packages-2");
  assert.equal(builds.length, 2);
  const recovered = await coordinator.changeContainerPackages({
    operation: "upgrade",
    packages: ["jq"],
    expectedRevision: 1,
    actor: "approval:approval-upgrade",
    approvalId: "approval-upgrade",
  });
  assert.equal(recovered.revision, 2);
  assert.equal(builds.length, 3);
  assert.equal(builds[2]?.rebuild, false);
});

/* @covers DISCORD-A9DA6034
Given the Discord listener and gateway are running
	When the gateway becomes degraded with a recorded failure reason
		Then the gateway reports the health incident to the coordinator
			And the coordinator sends one plain-language alert directly to the configured Discord DM
			And the alert identifies the gateway and a bounded redacted reason
			And the alert explains that new messages remain queued
			And the coordinator records the delivered alert in the Discord conversation history
			And the notification does not enter or depend on the conversation queue
	When the same degraded gateway state is observed again
		Then the coordinator does not send a duplicate alert
	When the gateway returns to ready after a delivered incident
		Then the coordinator sends one direct recovery notification
			And records the delivered recovery in the Discord conversation history
			And permits a later gateway incident to produce a new alert
*/
test("[DISCORD-A9DA6034] gateway health incidents notify Discord once and recover durably", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    directory = join(paths.channels, "discord-health"),
    queue = new DurableQueue(join(directory, "queue.json")),
    conversation = new ConversationStore(join(directory, "conversation.jsonl")),
    modelSelection = new ModelSelectionStore(join(directory, "model.json")),
    discordReplies: string[] = [],
    scope = {
      id: "discord:100000000000000004",
      queue,
      conversation,
      modelSelection,
      discord: {
        listener: {
          async typing() {},
          async reply(text: string) {
            discordReplies.push(text);
          },
        },
        ingress: {},
        userId: "100000000000000003",
        channelId: "100000000000000004",
      },
    };
  await saveConnection(
    paths,
    validateConnection({
      name: "anthropic",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    "actual-secret",
  );
  await Promise.all([queue.load(), conversation.load(), modelSelection.load()]);

  const first = new Coordinator(paths, config) as any;
  first.discordScope = scope;
  await first.notifyGatewayHealth(
    "degraded",
    "OAuth refresh failed for anthropic using actual-secret\nprivate stack",
  );
  await first.notifyGatewayHealth(
    "degraded",
    "OAuth refresh failed for anthropic using actual-secret\nprivate stack",
  );

  assert.equal(discordReplies.length, 1);
  assert.match(discordReplies[0]!, /gateway is degraded/i);
  assert.match(discordReplies[0]!, /messages remain safely queued/i);
  assert.doesNotMatch(discordReplies[0]!, /actual-secret|private stack/);
  assert.equal(queue.snapshot().length, 0);
  assert.equal(conversation.snapshot().length, 1);

  const restarted = new Coordinator(paths, config) as any;
  restarted.discordScope = scope;
  await restarted.notifyGatewayHealth(
    "degraded",
    "OAuth refresh failed for anthropic using actual-secret\nprivate stack",
  );
  await restarted.notifyGatewayHealth("ready");
  await restarted.notifyGatewayHealth("ready");
  await restarted.notifyGatewayHealth("degraded", "another safe failure");

  assert.equal(discordReplies.length, 3);
  assert.match(discordReplies[1]!, /gateway has recovered/i);
  assert.match(discordReplies[2]!, /another safe failure/);
  assert.deepEqual(
    conversation.snapshot().map((event) => event.type),
    ["notification", "notification", "notification"],
  );
});

test("a live Pi package request waits for an attached human and returns the durable result", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    builds: string[] = [],
    coordinator = new Coordinator(paths, config, {
      ensureImage: () => {
        builds.push("build");
        return "sha256:approved-image";
      },
    }),
    selection = {
      connection: "work",
      provider: "openai-codex",
      model: "gpt-5.5",
      piVersion: "1.2.3",
      piImage: "sha256:base",
    },
    response = waitingResponse();
  await coordinator.modelSelection.set(selection);
  const waiting = coordinator.requestContainerPackageApproval(
    {
      operation: "install",
      packages: ["jq"],
      expectedRevision: 0,
      sessionId: "session-live",
      runId: "run-live",
    },
    response,
  );
  await until(() => (coordinator as any).approvalWaiters.size === 1);
  const pending = coordinator.approvals.snapshot()[0]!;
  assert.equal(pending.status, "pending");
  assert.equal(builds.length, 0);
  assert.equal(coordinator.queue.snapshot().length, 0);
  await assert.rejects(
    coordinator.decideApproval(pending.id, "approved", "forged-terminal"),
    /attached human terminal/,
  );
  assert.equal(builds.length, 0);
  (coordinator as any).attachments.add("human-a");
  const decided = await coordinator.decideApproval(
    pending.id,
    "approved",
    "human-a",
  );
  assert.equal(decided.status, "succeeded");
  assert.equal((await waiting).status, "succeeded");
  assert.equal(coordinator.queue.snapshot().length, 0);
  assert.equal(
    coordinator.modelSelection.get()?.piImage,
    "sha256:approved-image",
  );
  assert.equal(builds.length, 1);
});

test("a trusted local operator can decide an approval without a talk attachment", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    coordinator = new Coordinator(paths, config),
    response = waitingResponse();
  await coordinator.modelSelection.set({
    connection: "work",
    provider: "openai-codex",
    model: "gpt-5.5",
    piVersion: "1.2.3",
    piImage: "sha256:base",
  });
  const waiting = coordinator.requestContainerPackageApproval(
    {
      operation: "install",
      packages: ["jq"],
      expectedRevision: 0,
      sessionId: "session-operator",
    },
    response,
  );
  await until(() => (coordinator as any).approvalWaiters.size === 1);
  const approval = coordinator.approvals.snapshot()[0]!;
  const denied = await coordinator.decideApproval(
    approval.id,
    "denied",
    "",
    true,
  );
  assert.equal(denied.status, "denied");
  assert.equal(denied.decision?.terminalId, "operator");
  assert.equal((await waiting).status, "denied");
});

test("denial is durable and never executes the package request", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {});
  let builds = 0;
  const coordinator = new Coordinator(paths, config, {
      ensureImage: () => {
        builds += 1;
        return "sha256:unexpected";
      },
    }),
    response = waitingResponse();
  await coordinator.modelSelection.set({
    connection: "work",
    provider: "openai-codex",
    model: "gpt-5.5",
    piVersion: "1.2.3",
    piImage: "sha256:base",
  });
  const waiting = coordinator.requestContainerPackageApproval(
    {
      operation: "upgrade",
      packages: ["git"],
      expectedRevision: 0,
      sessionId: "session-denied",
    },
    response,
  );
  await until(() => (coordinator as any).approvalWaiters.size === 1);
  const approvalId = coordinator.approvals.snapshot()[0]!.id;
  (coordinator as any).attachments.add("human-denier");
  assert.equal(
    (await coordinator.decideApproval(approvalId, "denied", "human-denier"))
      .status,
    "denied",
  );
  assert.equal((await waiting).status, "denied");
  assert.equal(builds, 0);
});

/* @covers REPO-7B0E2F4A
Given every governed repository has a host-managed write policy of `direct`, `approval-required`, or `denied`
	And Pi cannot change that policy
	When Pi calls `repo_push`
		Then integral derives the repository ID and policy from the authenticated session
			And never trusts a policy, host path, approval status, or repository identity supplied by Pi
	When Pi calls `repo_push` for an `approval-required` repository
		Then integral receives and validates the proposed commit through the ordinary quarantine boundary
			And stores the valid proposal under an approval-specific ref without advancing the canonical branch
			And binds the approval to the repository ID, current canonical base commit, proposed commit, complete tree digest, changed paths, originating session and run, and repository lifecycle revision
			And shows the exact commit diff and safe validation summary to the approving human
			And does not expose unvalidated Git objects to the canonical repository
	When a human approves that exact repository proposal
		Then integral revalidates the quarantined objects, complete proposed tree, repository lifecycle revision, and canonical base commit
			And invokes the repository's idempotent approved-mutation executor for that exact proposal
			And refuses any file, commit, tree, ref, or policy change made after approval was requested
	When the canonical branch or lifecycle revision changed after the proposal was created
		Then integral records a stale approval outcome without advancing the canonical branch
			And lets Pi fetch, rebase, and submit a new proposal requiring a new approval
	When a human denies the proposal or its approval expires
		Then integral leaves the canonical branch unchanged
			And retains only the bounded proposal and audit material required by policy
	When Pi calls `repo_push` for a `denied` repository
		Then integral rejects the request without accepting a proposal or changing repository state
	When Pi calls a read-only repository operation
		Then integral permits it according to ordinary session and repository policy without mutation approval
	When a trusted local operator edits an `approval-required` image-recipe repository through `integral image edit`
		Then integral treats the local CLI invocation as direct human authority for that repository
			And validates and durably commits the exact change without creating an approval request
			And records the operator, prior commit, landed commit, tree digest, and changed paths in host audit history
*/
test("[BOX-6A91C3E7] [REPO-7B0E2F4A] an exact image recipe proposal builds and activates only after approval", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    calls: string[] = [],
    coordinator = new Coordinator(paths, config, {
      async stageImageProposal() {
        calls.push("stage");
        return {
          baseCommit: "a".repeat(40),
          proposedCommit: "b".repeat(40),
          proposalRef: "refs/integral/proposals/proposal-1",
          treeDigest: "c".repeat(40),
          changedPaths: ["Dockerfile"],
          diff: "+RUN npm install --global cowsay@latest",
        };
      },
      async buildImageRecipe(_paths, _config, commit) {
        calls.push(`build:${commit}`);
        return {
          recipeCommit: commit,
          image: "sha256:approved-recipe",
          piVersion: "0.85.0",
          packages: ["cowsay=1.6.0"],
        };
      },
      async activateImageProposal(_paths, proposal) {
        calls.push(`activate:${proposal.proposedCommit}`);
      },
      async imageRecipeHead() {
        return "a".repeat(40);
      },
      async imageRecipeTreeDigest() {
        return "c".repeat(40);
      },
    }),
    response = waitingResponse();
  await coordinator.modelSelection.set({
    connection: "work",
    provider: "openai-codex",
    model: "gpt-5.5",
    piVersion: "0.84.1",
    piImage: "sha256:prior-image",
  });
  const waiting = coordinator.requestImageRecipeApproval(
    {
      operation: "proposal",
      sessionId: "session-image",
      runId: "run-image",
      proposed: "b".repeat(40),
      bundle: Buffer.from("bundle"),
    },
    response,
  );
  await until(() => (coordinator as any).approvalWaiters.size === 1);
  const pending = coordinator.approvals.snapshot()[0]!;
  assert.deepEqual(calls, ["stage"]);
  assert.match(String(pending.details?.diff), /cowsay@latest/);
  (coordinator as any).attachments.add("human-image");
  assert.equal(
    (await coordinator.decideApproval(pending.id, "approved", "human-image"))
      .status,
    "succeeded",
  );
  assert.equal((await waiting).status, "succeeded");
  assert.deepEqual(calls, [
    "stage",
    `build:${"b".repeat(40)}`,
    `activate:${"b".repeat(40)}`,
  ]);
  assert.equal(
    coordinator.modelSelection.get()?.piImage,
    "sha256:approved-recipe",
  );
  assert.equal(coordinator.modelSelection.get()?.piVersion, "0.85.0");
});

test("[BOX-6A91C3E7] a fresh unchanged-recipe rebuild is approval-gated without advancing Git", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    calls: string[] = [],
    commit = "d".repeat(40),
    coordinator = new Coordinator(paths, config, {
      async imageRecipeHead() {
        return commit;
      },
      async imageRecipeTreeDigest() {
        return "e".repeat(40);
      },
      async buildImageRecipe() {
        calls.push("build");
        return {
          recipeCommit: commit,
          image: "sha256:fresh",
          piVersion: "0.86.0",
          packages: [],
        };
      },
      async activateImageProposal() {
        calls.push("unexpected-activation");
      },
    }),
    response = waitingResponse();
  await coordinator.modelSelection.set({
    connection: "work",
    provider: "openai-codex",
    model: "gpt-5.5",
    piVersion: "0.85.0",
    piImage: "sha256:prior",
  });
  const waiting = coordinator.requestImageRecipeApproval(
    { operation: "rebuild", sessionId: "session-rebuild" },
    response,
  );
  await until(() => (coordinator as any).approvalWaiters.size === 1);
  assert.deepEqual(calls, []);
  const approval = coordinator.approvals.snapshot()[0]!;
  assert.equal(approval.details?.operation, "rebuild");
  assert.equal(approval.details?.floatingResolution, true);
  (coordinator as any).attachments.add("human-rebuild");
  await coordinator.decideApproval(approval.id, "approved", "human-rebuild");
  assert.equal((await waiting).status, "succeeded");
  assert.deepEqual(calls, ["build"]);
});

test("an orphaned approval survives restart and queues one lineage-aware continuation", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    selection = {
      connection: "work",
      provider: "openai-codex",
      model: "gpt-5.5",
      piVersion: "1.2.3",
      piImage: "sha256:base",
    },
    first = new Coordinator(paths, config),
    response = waitingResponse();
  await first.modelSelection.set(selection);
  const disconnected = first
    .requestContainerPackageApproval(
      {
        operation: "install",
        packages: ["jq"],
        expectedRevision: 0,
        sessionId: "session-ended",
        runId: "run-ended",
      },
      response,
    )
    .catch((error: unknown) => error);
  await until(() => (first as any).approvalWaiters.size === 1);
  const approvalId = first.approvals.snapshot()[0]!.id;
  response.emit("close");
  assert.match(String(await disconnected), /approval remains pending/);

  const restored = new Coordinator(paths, config, {
    ensureImage: () => "sha256:replacement-image",
  });
  await restored.modelSelection.load();
  await restored.queue.load();
  await restored.approvals.load();
  assert.equal(restored.approvals.get(approvalId).status, "pending");
  (restored as any).attachments.add("human-after-restart");
  assert.equal(
    (
      await restored.decideApproval(
        approvalId,
        "approved",
        "human-after-restart",
      )
    ).status,
    "succeeded",
  );
  const continuation = restored.queue.snapshot()[0]!;
  assert.equal(continuation.approvalContinuation?.approvalId, approvalId);
  assert.equal(
    continuation.approvalContinuation?.originSessionId,
    "session-ended",
  );
  assert.equal(continuation.approvalContinuation?.originRunId, "run-ended");
  assert.match(continuation.text, /resolved as succeeded/);
  await assert.rejects(
    restored.decideApproval(approvalId, "denied", "human-after-restart"),
    /already succeeded/,
  );
});

/* @covers QUEUE-31A6D84F
Given one message is in flight with Pi
	And one or more later messages remain queued rather than being delivered through a surface-specific steering behavior
	When the in-flight turn completes
		Then the coordinator durably marks the in-flight message complete
			And claims the oldest remaining queued message
			And sends only that message to Pi
			And increments a message's delivery-attempt count each time it is claimed
			And preserves acknowledged queue order regardless of submitting terminal
*/
test("[QUEUE-31A6D84F] [CHAT-D7E2F609] one in-flight claim completes to one persisted assistant event before next work", async (t) => {
  const { coordinator } = await coordinatorFixture(t);
  const first = await coordinator.queue.enqueue("one"),
    second = await coordinator.queue.enqueue("two");
  await coordinator.conversation.append({
    type: "user",
    messageId: first.id,
    text: first.text,
  });
  assert.equal((await coordinator.queue.claim())?.id, first.id);
  assert.equal(await coordinator.queue.claim(), undefined);
  await coordinator.conversation.append({
    type: "assistant",
    messageId: first.id,
    text: "answer",
  });
  await coordinator.queue.complete(first.id);
  assert.equal((await coordinator.queue.claim())?.id, second.id);
  assert.deepEqual(
    coordinator.conversation.snapshot().map((e) => e.text),
    ["one", "answer"],
  );
});

/* @covers CHAT-1C4A8B7E
Given one or more terminals are attached to the conversation
	When one terminal enters `/exit`, sends EOF, or is interrupted
		Then integral detaches only that terminal
			And returns control to that terminal's shell
			And does not end the logical conversation
			And does not discard queued messages or persisted conversation events
			And does not disturb other attached terminals
*/
/* @covers QUEUE-8E42F5B1
Given one or more messages are durably queued
	When one terminal detaches
		Then every queued message remains stored
			And processing continues independently of that terminal
	When every terminal detaches
		Then every queued message remains stored
			And the coordinator continues offering work to the runner
*/
test("[CHAT-1C4A8B7E] [QUEUE-8E42F5B1] attached-terminal count can fall to zero without touching queue or conversation state", async (t) => {
  const { coordinator } = await coordinatorFixture(t);
  await coordinator.queue.enqueue("after detach");
  (coordinator as any).attached = 0;
  assert.equal(coordinator.queue.snapshot()[0]?.text, "after detach");
  assert.equal((coordinator as any).snapshot().attached, 0);
});

/* @covers SERVER-8A31D6C4
Given no server component is running for the deployment
	When the user starts `integral server start --component coordinator`
		Then that process starts only the coordinator listener
	When the user starts `integral server start --component runner`
		Then that process starts only the runner listener
	When the user starts `integral server start --component gateway`
		Then that process starts only the gateway listener
	When the user starts `integral server start --component scheduler`
		Then that process starts only the scheduler listener
	When all four component processes are healthy
		Then the deployment offers the same behavior as combined mode
*/
test("[SERVER-8A31D6C4] coordinator lifecycle can run against controlled listener and interval boundaries", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    calls: string[] = [],
    timer = {};
  let deferred!: () => void;
  const coordinator = new Coordinator(paths, config, {
    servers: {
      async listen(_server, port, address) {
        calls.push(`listen:${address}:${port}`);
      },
      async close() {
        calls.push("close");
      },
    },
    intervals: {
      setInterval(_callback, milliseconds) {
        calls.push(`interval:${milliseconds}`);
        return timer;
      },
      clearInterval(handle) {
        assert.equal(handle, timer);
        calls.push("clear");
      },
    },
    defer(callback) {
      calls.push("defer");
      deferred = callback;
      return callback;
    },
    cancelDeferred() {},
    async listModelChoices() {
      calls.push("catalog");
      return { choices: [] };
    },
  });
  await coordinator.start();
  deferred();
  await (coordinator as any).modelCatalog();
  await coordinator.stop();
  assert.deepEqual(calls, [
    `listen:127.0.0.1:${config.server.coordinatorPort}`,
    "interval:500",
    "defer",
    "catalog",
    "clear",
    "close",
  ]);
});

/* @covers SERVER-CBD35885
Given a coordinator refresh or gateway connection reload is still running
	When another periodic interval becomes due
		Then Integral does not start overlapping maintenance for that component
			And records how many intervals were coalesced when the active maintenance finishes
			And a failed maintenance pass is reported without stopping later passes
*/
/* @covers LOG-D079FCFE
Given periodic coordinator or gateway maintenance cannot keep up with its configured interval
	When one or more interval invocations are coalesced or a pass fails
		Then Integral emits one diagnostic for the completed or failed pass
			And includes its elapsed time and coalesced interval count
*/
test("[SERVER-CBD35885] [LOG-D079FCFE] coordinator refresh is single-flight and reports coalesced intervals", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    lines: string[] = [],
    coordinator = new Coordinator(
      paths,
      config,
      {},
      new Logger({
        component: "coordinator",
        deploymentId: "test",
        level: "trace",
        format: "json",
        sink: (line) => lines.push(line),
      }),
    );
  let release!: () => void,
    generationRuns = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  (coordinator as any).adoptGeneration = async () => {
    generationRuns++;
    await pending;
  };
  (coordinator as any).adoptExternalModelSelection = async () => undefined;
  (coordinator as any).flushTaskOutbox = async () => undefined;
  (coordinator as any).expireApprovals = async () => undefined;

  const first = (coordinator as any).refresh() as Promise<void>;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = (coordinator as any).refresh() as Promise<void>;
  assert.equal(generationRuns, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(generationRuns, 1);
  const event = lines
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.event === "coordinator.refresh_coalesced");
  assert.equal(event.coalesced_intervals, 1);
  assert.equal(typeof event.elapsed_ms, "number");

  let laterRuns = 0;
  (coordinator as any).adoptGeneration = async () => {
    laterRuns++;
    if (laterRuns === 1) throw new Error("maintenance failed");
  };
  await assert.rejects(
    (coordinator as any).refresh() as Promise<void>,
    /maintenance failed/,
  );
  await ((coordinator as any).refresh() as Promise<void>);
  assert.equal(laterRuns, 2);
  assert.ok(
    lines
      .map((line) => JSON.parse(line))
      .some(
        (candidate) =>
          candidate.event === "coordinator.refresh_failed" &&
          candidate.coalesced_intervals === 0,
      ),
  );
});

/* @covers SERVER-EC7ACFFC
Given coordinator startup begins a model catalog refresh
	When registry access, image preparation, or model discovery is slow
		Then the coordinator binds its listener without waiting for the refresh
			And continues the refresh in the background
			And serves the completed catalog to later model requests
*/
/* @covers LOG-28BE37DE
Given the coordinator refreshes the model catalog during or after startup
	When it resolves the Pi runtime, resolves the managed image, or discovers models
		Then it emits an informational progress event naming the active stage
			And reports catalog readiness with the discovered model count
	When catalog refresh fails
		Then it emits a warning with the failure reason
			And does not expose model credentials
*/
test("[SERVER-EC7ACFFC] [LOG-28BE37DE] coordinator becomes ready while catalog discovery reports progress in the background", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    calls: string[] = [],
    lines: string[] = [];
  let complete!: (catalog: { choices: []; piVersion: string }) => void,
    catalogStarted!: () => void,
    deferred!: () => void;
  const pending = new Promise<{ choices: []; piVersion: string }>((resolve) => {
      complete = resolve;
    }),
    started = new Promise<void>((resolve) => {
      catalogStarted = resolve;
    }),
    coordinator = new Coordinator(
      paths,
      config,
      {
        servers: {
          async listen() {
            calls.push("listen");
          },
          async close() {},
        },
        intervals: {
          setInterval() {
            return {};
          },
          clearInterval() {},
        },
        defer(callback) {
          deferred = callback;
          return callback;
        },
        cancelDeferred() {},
        async listModelChoices(_paths, _config, progress) {
          calls.push("catalog:start");
          catalogStarted();
          progress?.("runtime.resolve", "checking the Pi runtime");
          return pending;
        },
      },
      new Logger({
        component: "coordinator",
        deploymentId: "test",
        level: "info",
        format: "json",
        sink: (line) => lines.push(line),
      }),
    );

  await coordinator.start();
  deferred();
  await started;
  assert.deepEqual(calls, ["listen", "catalog:start"]);
  assert.ok(
    lines.some(
      (line) =>
        JSON.parse(line).event === "model_catalog.progress" &&
        JSON.parse(line).stage === "runtime.resolve",
    ),
  );

  complete({ choices: [], piVersion: "1.2.3" });
  await (coordinator as any).modelCatalog();
  assert.ok(
    lines.some((line) => JSON.parse(line).event === "model_catalog.ready"),
  );
  await coordinator.stop();
});

test("[LOG-28BE37DE] coordinator warns when background catalog refresh fails", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    lines: string[] = [];
  let deferred!: () => void;
  const coordinator = new Coordinator(
    paths,
    config,
    {
      servers: {
        async listen() {},
        async close() {},
      },
      intervals: {
        setInterval() {
          return {};
        },
        clearInterval() {},
      },
      defer(callback) {
        deferred = callback;
        return callback;
      },
      cancelDeferred() {},
      async listModelChoices() {
        throw new Error("registry lookup timed out");
      },
    },
    new Logger({
      component: "coordinator",
      deploymentId: "test",
      level: "info",
      format: "json",
      sink: (line) => lines.push(line),
    }),
  );

  await coordinator.start();
  deferred();
  const refresh = (coordinator as any).modelCatalog() as Promise<unknown>;
  await assert.rejects(refresh, /timed out/);

  const failed = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.event === "model_catalog.failed");
  assert.equal(failed?.level, "warn");
  assert.equal(failed?.message, "registry lookup timed out");
  await coordinator.stop();
});

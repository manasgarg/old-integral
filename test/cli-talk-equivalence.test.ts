import assert from "node:assert/strict";
import test from "node:test";
import { readFile, realpath } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { main, modelCommand, talkCommand } from "../src/cli.ts";
import type { TalkTerminal } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import {
  listConnections,
  saveConnection,
  validateConnection,
} from "../src/connections.ts";
import { Coordinator, type ClientEvent } from "../src/coordinator.ts";
import { ApprovalStore } from "../src/approval-store.ts";
import {
  pathsFor,
  type IntegralPaths,
} from "../src/platform/deployment-paths.ts";
import {
  ConversationStore,
  DurableQueue,
  ModelSelectionStore,
} from "../src/queue.ts";
import { nodeHttpServerRuntime } from "../src/platform/timers-and-servers.ts";
import {
  deploymentId,
  writeComponentState,
} from "../src/platform/component-identity.ts";
import { DurableTaskQueue } from "../src/task-queue.ts";
import { fixture } from "./helpers.ts";

// These tests drive both command surfaces against one real in-process
// coordinator over its HTTP API. Model discovery and image builds are the only
// injected fakes; no PTY, Docker, Pi, or model provider is involved.

const MODEL_CHOICES = [
  {
    connection: "work",
    provider: "openai-codex",
    model: "gpt-5.5",
    piVersion: "1.2.3",
    piImage: "sha256:base",
  },
  {
    connection: "personal",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    piVersion: "1.2.3",
    piImage: "sha256:base",
  },
];

interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Harness {
  paths: IntegralPaths;
  coordinator: Coordinator;
  endpoint: string;
  imageBuilds: string[][];
  attachedEvents(): number;
  shell(args: string[]): Promise<ShellResult>;
  shellModel(args: string[], answers?: string[]): Promise<ScriptedModelRun>;
}

interface ScriptedModelRun {
  code: number;
  stdout: string;
  prompts: string[];
}

async function startHarness(t: test.TestContext): Promise<Harness> {
  const temporary = await fixture(t),
    paths = pathsFor(await realpath(temporary.root)),
    config = await loadConfig(paths, {}),
    imageBuilds: string[][] = [],
    events: ClientEvent[] = [];
  const coordinator = new Coordinator(paths, config, {
    servers: {
      async listen(server) {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
      },
      close: nodeHttpServerRuntime.close,
    },
    intervals: { setInterval: () => undefined, clearInterval() {} },
    defer: () => undefined,
    cancelDeferred() {},
    async listModelChoices() {
      return { choices: structuredClone(MODEL_CHOICES), piVersion: "1.2.3" };
    },
    ensureImage(_config, _version, options) {
      imageBuilds.push([...options.systemPackages]);
      return "sha256:approved-image";
    },
  });
  const server = await coordinator.start();
  t.after(() => coordinator.stop());
  coordinator.events.on("event", (event: ClientEvent) => events.push(event));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeComponentState(paths, {
    component: "coordinator",
    deploymentId: deploymentId(paths),
    endpoint,
    pid: process.pid,
    status: "ready",
    fingerprint: config.fingerprint,
    connectionGeneration: 0,
    startedAt: new Date(0).toISOString(),
  });
  return {
    paths,
    coordinator,
    endpoint,
    imageBuilds,
    attachedEvents: () =>
      events.filter((event) => event.type === "chat.attached").length,
    shell: (args) => shell(args, paths),
    async shellModel(args, answers = []) {
      let stdout = "";
      const prompts: string[] = [];
      const code = await modelCommand(args, {
        resolvePaths: () => paths,
        writeOutput(text) {
          stdout += text;
        },
        createTerminal: () => ({
          async question(prompt) {
            prompts.push(prompt);
            const answer = answers.shift();
            if (answer === undefined)
              throw new Error(`unexpected model prompt: ${prompt}`);
            return answer;
          },
          close() {},
        }),
      });
      return { code, stdout, prompts };
    },
  };
}

// Runs the standalone CLI through its real entry point with production
// dependencies. Only process output is captured.
async function shell(
  args: string[],
  paths: IntegralPaths,
): Promise<ShellResult> {
  let stdout = "",
    stderr = "";
  const out = process.stdout.write,
    err = process.stderr.write,
    home = process.env.INTEGRAL_HOME;
  process.env.INTEGRAL_HOME = paths.root;
  process.stdout.write = (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  };
  try {
    return { code: await main(args), stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    if (home === undefined) delete process.env.INTEGRAL_HOME;
    else process.env.INTEGRAL_HOME = home;
  }
}

interface TalkSegment {
  prompt: string;
  line: string;
  stdout: string;
  stderr: string;
}

interface TalkRun {
  code: number;
  segments: TalkSegment[];
  events: string;
  requests: string[];
  attachmentId: string;
  output(line: string, occurrence?: number): TalkSegment;
}

type TalkStep = string | (() => Promise<string>);

// Attaches `integral talk` through its injected terminal interface. Each step
// supplies the next line; function steps may run shell commands first, so both
// surfaces observe the same live coordinator while the talk session is attached.
async function runTalk(h: Harness, steps: TalkStep[]): Promise<TalkRun> {
  const segments: TalkSegment[] = [
      { prompt: "", line: "<startup>", stdout: "", stderr: "" },
    ],
    requests: string[] = [];
  let events = "",
    attachmentId = "";
  const current = () => segments.at(-1)!;
  const terminal: TalkTerminal = {
    colors: false,
    async question(prompt) {
      const step = steps.shift();
      if (step === undefined) throw new Error("EOF");
      const line = typeof step === "string" ? step : await step();
      segments.push({ prompt, line, stdout: "", stderr: "" });
      return line;
    },
    writeEvent(text) {
      events += text;
    },
    setWorking() {},
    close() {},
  };
  const code = await talkCommand([], {
    resolvePaths: () => h.paths,
    createTerminal: () => terminal,
    createTerminalId: () => "terminal-equivalence",
    writeOutput(text) {
      current().stdout += text;
    },
    writeError(text) {
      current().stderr += text;
    },
    async fetch(input, init) {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const response = await globalThis.fetch(input, init);
      if (url.pathname === "/integral/events")
        attachmentId = response.headers.get("x-integral-attachment-id") ?? "";
      return response;
    },
  });
  return {
    code,
    segments,
    events,
    requests,
    attachmentId,
    output(line, occurrence = 0) {
      const found = segments.filter((segment) => segment.line === line)[
        occurrence
      ];
      assert.ok(found, `talk line was not entered: ${line} #${occurrence}`);
      return found;
    },
  };
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function attachedTerminals(endpoint: string): Promise<number> {
  const response = await fetch(new URL("/integral/status", endpoint));
  return ((await response.json()) as { attached: number }).attached;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

async function durableSelection(paths: IntegralPaths) {
  const store = new ModelSelectionStore(paths.modelSelection);
  await store.load();
  return store.get();
}

function assertNoSlashCommandsReachedPi(h: Harness): void {
  for (const item of h.coordinator.queue.snapshot())
    assert.doesNotMatch(item.text, /^\//, "a slash command was queued for Pi");
  for (const event of h.coordinator.conversation.snapshot())
    assert.doesNotMatch(
      event.text ?? "",
      /^\//,
      "a slash command was recorded",
    );
}

function task(executionId: string, prompt: string) {
  return {
    executionId,
    scheduleId: `schedule-${executionId}`,
    scheduleRevision: 1,
    triggerType: "once" as const,
    scheduledFor: "2026-08-23T10:00:00.000Z",
    prompt,
    profile: MODEL_CHOICES[0]!,
    state: "accepted" as const,
    dispatchAttempts: 1,
    createdAt: "2026-08-23T09:00:00.000Z",
  };
}

/* @covers CLI-7A87D55B
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When the user invokes `integral status` or enters `/status` in `integral talk`
		Then integral reports the same conversation and component status from either surface
*/
/* @covers CLI-E3D01B8A
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When the user invokes `integral model [<pattern>...]` or enters `/model [<pattern>...]` in `integral talk`
		Then integral uses the same model chooser and changes the same durable conversation selection from either surface
*/
test("[CLI-7A87D55B] [CLI-E3D01B8A] [CLI-D1B5816E] status and model selection match between the shell and an attached talk session", async (t) => {
  const h = await startHarness(t);

  const shellSelected = await h.shellModel(["personal"]);
  assert.equal(shellSelected.code, 0);
  assert.equal(
    shellSelected.stdout.split("\n").at(-2),
    "Selected personal (anthropic) / claude-sonnet-4-6",
  );
  assert.deepEqual(shellSelected.prompts, []);
  assert.equal((await durableSelection(h.paths))?.connection, "personal");

  const shellResults: Record<string, ShellResult> = {};
  let shellChooser: ScriptedModelRun | undefined,
    shellLockError = "";
  const run = await runTalk(h, [
    async () => {
      shellResults.status = await h.shell(["status"]);
      return "/status";
    },
    async () => {
      shellChooser = await h.shellModel([], [""]);
      return "/model";
    },
    "",
    "/model codex",
    async () => {
      assert.equal((await durableSelection(h.paths))?.connection, "work");
      shellResults.statusAfter = await h.shell(["status"]);
      shellResults.json = await h.shell(["status", "--json"]);
      return "/status";
    },
    async () => {
      const busy = await postJson(`${h.endpoint}/integral/messages`, {
        text: "busy work",
        terminalId: "another-terminal",
      });
      assert.equal(busy.status, 201);
      await h.coordinator.queue.claim();
      await assert.rejects(h.shellModel(["personal"]), (error: Error) => {
        shellLockError = error.message;
        return true;
      });
      return "/model personal";
    },
    "/status",
    "/exit",
  ]);

  assert.equal(run.code, 0);
  assert.equal(shellResults.status!.code, 0);
  assert.equal(run.output("/status").stdout, shellResults.status!.stdout);
  assert.match(
    shellResults.status!.stdout,
    /^model: personal \(anthropic\) \/ claude-sonnet-4-6$/m,
  );
  assert.match(shellResults.status!.stdout, /^terminals: 1 attached$/m);

  assert.equal(shellChooser?.code, 0);
  assert.deepEqual(shellChooser?.prompts, ["Model [current]: "]);
  assert.equal(run.output("").prompt, "Model [current]: ");
  assert.equal(run.output("/model").stdout, shellChooser?.stdout);
  assert.match(run.output("/model").stdout, /claude-sonnet-4-6 \[current\]/);

  assert.equal(
    run.output("/model codex").stdout.split("\n").at(-2),
    "Selected work (openai-codex) / gpt-5.5",
  );
  assert.equal(
    run.output("/status", 1).stdout,
    shellResults.statusAfter!.stdout,
  );
  assert.match(
    shellResults.statusAfter!.stdout,
    /^model: work \(openai-codex\) \/ gpt-5\.5$/m,
  );
  const json = JSON.parse(shellResults.json!.stdout) as Record<string, unknown>;
  assert.equal(json.attached, 1);
  assert.deepEqual(json.selection, MODEL_CHOICES[0]);

  assert.equal(
    shellLockError,
    "cannot change model selection while a Pi turn is in flight",
  );
  assert.equal(
    run.output("/model personal").stderr,
    `integral: ${shellLockError}\n`,
  );
  assert.match(
    run.output("/status", 2).stdout,
    /queue: 0 queued, in-flight (?!none)\w+/,
  );
  assert.equal(run.output("/status", 2).stderr, "");
  assert.deepEqual(await durableSelection(h.paths), MODEL_CHOICES[0]);
  assert.match(run.events, /model: work \(openai-codex\) \/ gpt-5\.5/);

  assert.equal(h.attachedEvents(), 1);
  assert.equal(
    run.requests.filter((request) => request === "GET /integral/events").length,
    1,
  );
  assertNoSlashCommandsReachedPi(h);
});

/* @covers CLI-DF545C68
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When the user invokes `integral connection catalog` or enters `/connection catalog` in `integral talk`
		Then integral shows the same public connection types and authentication methods from either surface
	When the user invokes `integral connection ls` or enters `/connection ls` in `integral talk`
		Then integral shows the same connection names, types, authentication methods, and states from either surface
			And neither surface prints secret values
*/
test("[CLI-DF545C68] connection catalog and listing match between the shell and talk without printing secrets", async (t) => {
  const h = await startHarness(t),
    secret = "sk-equivalence-secret-value-0123456789";
  await saveConnection(
    h.paths,
    validateConnection({
      name: "personal",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    secret,
  );
  await saveConnection(
    h.paths,
    validateConnection({
      name: "docs",
      kind: "http",
      auth: "none",
      url: "https://docs.example.test",
    }),
  );
  assert.equal((await h.shellModel(["personal"])).code, 0);

  const shellResults: Record<string, ShellResult> = {};
  const run = await runTalk(h, [
    async () => {
      shellResults.catalog = await h.shell(["connection", "catalog"]);
      return "/connection catalog";
    },
    async () => {
      shellResults.ls = await h.shell(["connection", "ls"]);
      shellResults.json = await h.shell(["connection", "ls", "--json"]);
      return "/connection ls";
    },
    "/exit",
  ]);

  assert.equal(run.code, 0);
  assert.equal(shellResults.catalog!.code, 0);
  assert.equal(
    run.output("/connection catalog").stdout,
    shellResults.catalog!.stdout,
  );
  assert.match(shellResults.catalog!.stdout, /^anthropic\tmodel\t.*key/m);
  assert.equal(shellResults.ls!.code, 0);
  assert.equal(run.output("/connection ls").stdout, shellResults.ls!.stdout);
  assert.match(shellResults.ls!.stdout, /^docs\thttp\tnone\tactive\t/m);
  assert.match(shellResults.ls!.stdout, /^personal\tanthropic\tkey\tactive\t/m);
  for (const text of [
    ...Object.values(shellResults).flatMap((result) => [
      result.stdout,
      result.stderr,
    ]),
    ...run.segments.flatMap((segment) => [segment.stdout, segment.stderr]),
    run.events,
  ])
    assert.doesNotMatch(text, new RegExp(secret));
  assert.equal(h.attachedEvents(), 1);
  assertNoSlashCommandsReachedPi(h);
});

/* @covers CLI-FCE41B12
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When the user invokes `integral queue ls`, `integral queue edit <id> <text>`, or `integral queue delete <id>`
		And the user could instead enter the corresponding `/queue` command in `integral talk`
		Then integral reads or changes the same durable queue from either surface
	When the user invokes `integral task ls`, `integral task show <id>`, or `integral task cancel <id>`
		And the user could instead enter the corresponding `/tasks` command in `integral talk`
		Then integral reads or changes the same durable task queue from either surface
*/
/* @covers CLI-D1B5816E
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When a shared operation succeeds or fails
		Then both surfaces report the same essential result or actionable error
			And the shell form exits without attaching a talk session
			And the slash form keeps the current talk session attached
			And the slash form handles the operation on the host without sending it to Pi
*/
test("[CLI-FCE41B12] [CLI-D1B5816E] queue and task operations change the same durable queues from the shell and talk", async (t) => {
  const h = await startHarness(t);
  assert.equal((await h.shellModel(["work"])).code, 0);
  const ids: string[] = [];
  for (const text of ["first", "second", "third", "fourth"]) {
    const queued = await postJson(`${h.endpoint}/integral/messages`, {
      text,
      terminalId: "another-terminal",
    });
    assert.equal(queued.status, 201);
    ids.push(String(queued.body.id));
  }
  const [id1, id2, id3, id4] = ids as [string, string, string, string];
  await h.coordinator.tasks.accept(task("execution-1", "prepare report"));
  await h.coordinator.tasks.accept(task("execution-2", "archive report"));

  const shellResults: Record<string, ShellResult> = {};
  const run = await runTalk(h, [
    async () => {
      shellResults.queue = await h.shell(["queue", "ls"]);
      return "/queue ls";
    },
    async () => {
      shellResults.edit = await h.shell([
        "queue",
        "edit",
        id1,
        "edited",
        "from",
        "shell",
      ]);
      return `/queue edit ${id2} edited from talk`;
    },
    async () => {
      shellResults.delete = await h.shell(["queue", "delete", id3]);
      return `/queue delete ${id4}`;
    },
    async () => {
      shellResults.queueAfter = await h.shell(["queue", "ls"]);
      return "/queue ls";
    },
    async () => {
      shellResults.editMissing = await h.shell([
        "queue",
        "edit",
        "missing",
        "text",
      ]);
      return "/queue edit missing text";
    },
    "/queue ls",
    async () => {
      shellResults.tasks = await h.shell(["task", "ls"]);
      return "/tasks";
    },
    "/tasks ls",
    async () => {
      shellResults.show = await h.shell(["task", "show", "execution-1"]);
      return "/tasks show execution-1";
    },
    async () => {
      shellResults.cancel = await h.shell(["task", "cancel", "execution-1"]);
      return "/tasks cancel execution-2";
    },
    async () => {
      shellResults.tasksAfter = await h.shell(["task", "ls"]);
      shellResults.status = await h.shell(["status"]);
      return "/tasks ls";
    },
    async () => {
      shellResults.showMissing = await h.shell(["task", "show", "missing"]);
      return "/tasks show missing";
    },
    async () => {
      shellResults.cancelMissing = await h.shell(["task", "cancel", "missing"]);
      return "/tasks cancel missing";
    },
    "  hello Pi  ",
    "/exit",
  ]);

  assert.equal(run.code, 0);
  assert.equal(shellResults.queue!.code, 0);
  assert.equal(run.output("/queue ls").stdout, shellResults.queue!.stdout);
  assert.equal(
    shellResults.queue!.stdout,
    `queued\t${id1}\tfirst\nqueued\t${id2}\tsecond\nqueued\t${id3}\tthird\nqueued\t${id4}\tfourth\n`,
  );
  assert.equal(shellResults.edit!.stdout, `Edited ${id1}.\n`);
  assert.equal(
    run.output(`/queue edit ${id2} edited from talk`).stdout,
    `Edited ${id2}.\n`,
  );
  assert.equal(shellResults.delete!.stdout, `Deleted ${id3}.\n`);
  assert.equal(run.output(`/queue delete ${id4}`).stdout, `Deleted ${id4}.\n`);
  assert.equal(
    run.output("/queue ls", 1).stdout,
    shellResults.queueAfter!.stdout,
  );
  assert.equal(
    shellResults.queueAfter!.stdout,
    `queued\t${id1}\tedited from shell\nqueued\t${id2}\tedited from talk\n`,
  );
  assert.notEqual(shellResults.editMissing!.code, 0);
  assert.equal(
    shellResults.editMissing!.stderr,
    "integral: message missing is not queued\n",
  );
  assert.equal(
    run.output("/queue edit missing text").stderr,
    shellResults.editMissing!.stderr,
  );
  assert.equal(
    run.output("/queue ls", 2).stdout,
    shellResults.queueAfter!.stdout,
  );

  assert.equal(shellResults.tasks!.code, 0);
  assert.equal(run.output("/tasks").stdout, shellResults.tasks!.stdout);
  assert.equal(run.output("/tasks ls").stdout, shellResults.tasks!.stdout);
  assert.match(
    shellResults.tasks!.stdout,
    /^queued\texecution-1\t2026-08-23T10:00:00\.000Z\tprepare report$/m,
  );
  assert.equal(
    run.output("/tasks show execution-1").stdout,
    shellResults.show!.stdout,
  );
  assert.match(
    shellResults.show!.stdout,
    /^scheduleId: schedule-execution-1$/m,
  );
  assert.match(shellResults.cancel!.stdout, /^executionId: execution-1$/m);
  assert.match(shellResults.cancel!.stdout, /^state: cancelled$/m);
  const talkCancel = run.output("/tasks cancel execution-2").stdout;
  assert.match(talkCancel, /^executionId: execution-2$/m);
  assert.match(talkCancel, /^state: cancelled$/m);
  assert.equal(
    run.output("/tasks ls", 1).stdout,
    shellResults.tasksAfter!.stdout,
  );
  assert.match(shellResults.tasksAfter!.stdout, /^cancelled\texecution-1\t/m);
  assert.match(shellResults.tasksAfter!.stdout, /^cancelled\texecution-2\t/m);
  for (const [line, result, message] of [
    [
      "/tasks show missing",
      shellResults.showMissing!,
      "task not found: missing",
    ],
    [
      "/tasks cancel missing",
      shellResults.cancelMissing!,
      "task not found: missing",
    ],
  ] as const) {
    assert.notEqual(result.code, 0);
    assert.equal(result.stderr, `integral: ${message}\n`);
    assert.equal(run.output(line).stderr, result.stderr);
    assert.equal(run.output(line).stdout, "");
  }

  const queue = new DurableQueue(h.paths.queue),
    conversation = new ConversationStore(h.paths.conversation),
    tasks = new DurableTaskQueue(h.paths);
  await Promise.all([queue.load(), conversation.load(), tasks.load()]);
  assert.deepEqual(
    queue.snapshot().map((item) => [item.id, item.text]),
    [
      [id1, "edited from shell"],
      [id2, "edited from talk"],
      [queue.snapshot()[2]!.id, "hello Pi"],
    ],
  );
  assert.deepEqual(
    conversation
      .snapshot()
      .filter((event) => event.type === "user")
      .map((event) => event.text),
    ["edited from shell", "edited from talk", "hello Pi"],
  );
  assert.deepEqual(
    tasks.snapshot().map((item) => [item.executionId, item.state]),
    [
      ["execution-1", "cancelled"],
      ["execution-2", "cancelled"],
    ],
  );

  assert.match(shellResults.status!.stdout, /^terminals: 1 attached$/m);
  assert.equal(h.attachedEvents(), 1);
  assert.deepEqual(
    run.requests.filter((request) => request === "GET /integral/events"),
    ["GET /integral/events"],
  );
  assert.deepEqual(
    run.requests.filter((request) =>
      request.startsWith("POST /integral/messages"),
    ),
    ["POST /integral/messages"],
  );
  assertNoSlashCommandsReachedPi(h);
});

/* @covers CLI-8066D182
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When the user invokes `integral approval ls` or enters `/approvals` in `integral talk`
		Then integral lists the same durable approval requests from either surface
	When the user invokes `integral approval approve <id>` or `integral approval deny <id>`
		And the user could instead enter the corresponding `/approve <id>` or `/deny <id>` command in `integral talk`
		Then integral decides the same durable approval request from either surface
			And applies the same validation, revalidation, authorization, persistence, and redaction rules
			And attributes the shell form to the trusted local operator
			And attributes the slash form to the attached human terminal
*/
test("[CLI-8066D182] [CLI-D1B5816E] approval decisions share durable rules and attribute the shell to the operator and talk to its terminal", async (t) => {
  const h = await startHarness(t);
  assert.equal((await h.shellModel(["work"])).code, 0);
  const selection = h.coordinator.modelSelection.get()!,
    approvals: string[] = [];
  for (const name of ["jq", "curl", "git", "make", "zip"])
    approvals.push(
      (
        await h.coordinator.approvals.create({
          request: {
            kind: "container-packages",
            operation: "install",
            packages: [name],
            expectedRevision: 0,
          },
          sessionId: "session-equivalence",
          selection,
        })
      ).id,
    );
  const [a1, a2, a3, a4, a5] = approvals as [
    string,
    string,
    string,
    string,
    string,
  ];

  const shellResults: Record<string, ShellResult> = {};
  let forged: { status: number; body: Record<string, unknown> } | undefined;
  const run = await runTalk(h, [
    async () => {
      shellResults.ls = await h.shell(["approval", "ls"]);
      shellResults.json = await h.shell(["approval", "ls", "--json"]);
      return "/approvals";
    },
    `/approve ${a1}`,
    async () => {
      shellResults.approve = await h.shell(["approval", "approve", a2]);
      return `/deny ${a3}`;
    },
    async () => {
      shellResults.deny = await h.shell(["approval", "deny", a4]);
      shellResults.lsAfter = await h.shell(["approval", "ls"]);
      return "/approvals";
    },
    async () => {
      shellResults.repeat = await h.shell(["approval", "deny", a3]);
      return `/deny ${a3}`;
    },
    async () => {
      shellResults.missing = await h.shell(["approval", "approve", "missing"]);
      return "/approve missing";
    },
    async () => {
      forged = await postJson(
        `${h.endpoint}/integral/approvals/${a5}/approve`,
        { attachmentId: "forged-terminal" },
      );
      return "/approvals";
    },
    "/exit",
  ]);

  assert.equal(run.code, 0);
  assert.ok(run.attachmentId);
  assert.notEqual(run.attachmentId, "operator");

  assert.equal(shellResults.ls!.code, 0);
  assert.equal(run.output("/approvals").stdout, shellResults.ls!.stdout);
  for (const [id, name] of [
    [a1, "jq"],
    [a5, "zip"],
  ])
    assert.match(
      shellResults.ls!.stdout,
      new RegExp(
        `^approval ${id} \\[pending\\] install Debian packages: ${name}$`,
        "m",
      ),
    );
  const listed = JSON.parse(shellResults.json!.stdout) as Array<
    Record<string, unknown>
  >;
  assert.equal(listed.length, 5);
  for (const approval of listed) {
    assert.equal("origin" in approval, false);
    assert.equal("request" in approval, false);
  }

  assert.match(
    run.output(`/approve ${a1}`).stdout,
    new RegExp(`^approval ${a1} \\[succeeded\\]`),
  );
  assert.match(
    shellResults.approve!.stdout,
    new RegExp(`^approval ${a2} \\[stale\\]`),
  );
  assert.match(
    run.output(`/deny ${a3}`).stdout,
    new RegExp(`^approval ${a3} \\[denied\\]`),
  );
  assert.match(
    shellResults.deny!.stdout,
    new RegExp(`^approval ${a4} \\[denied\\]`),
  );
  assert.equal(
    run.output("/approvals", 1).stdout,
    shellResults.lsAfter!.stdout,
  );

  assert.notEqual(shellResults.repeat!.code, 0);
  assert.equal(
    shellResults.repeat!.stderr,
    `integral: approval ${a3} is already denied\n`,
  );
  assert.equal(
    run.output(`/deny ${a3}`, 1).stderr,
    shellResults.repeat!.stderr,
  );
  assert.notEqual(shellResults.missing!.code, 0);
  assert.equal(
    shellResults.missing!.stderr,
    "integral: approval missing was not found\n",
  );
  assert.equal(
    run.output("/approve missing").stderr,
    shellResults.missing!.stderr,
  );
  assert.equal(forged?.status, 403);
  assert.deepEqual(forged?.body, {
    error: "approval requires an attached human terminal",
  });
  assert.match(
    run.output("/approvals", 2).stdout,
    new RegExp(`^approval ${a5} \\[pending\\]`, "m"),
  );

  await until(async () => (await attachedTerminals(h.endpoint)) === 0);
  const detached = await postJson(
    `${h.endpoint}/integral/approvals/${a5}/approve`,
    { attachmentId: run.attachmentId },
  );
  assert.equal(detached.status, 403);
  const operator = await h.shell(["approval", "deny", a5]);
  assert.equal(operator.code, 0);
  assert.match(operator.stdout, new RegExp(`^approval ${a5} \\[denied\\]`));

  const restored = new ApprovalStore(h.paths);
  await restored.load();
  const decisions = Object.fromEntries(
    approvals.map((id) => {
      const record = restored.get(id);
      return [id, [record.status, record.decision?.terminalId]];
    }),
  );
  assert.deepEqual(decisions, {
    [a1]: ["succeeded", run.attachmentId],
    [a2]: ["stale", "operator"],
    [a3]: ["denied", run.attachmentId],
    [a4]: ["denied", "operator"],
    [a5]: ["denied", "operator"],
  });
  assert.match(restored.get(a2).execution?.error ?? "", /stale/);
  const audit = (await readFile(h.paths.approvalAudit, "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          approvalId: string;
          decision?: { terminalId: string };
        },
    );
  for (const id of approvals)
    assert.equal(
      audit.filter((entry) => entry.approvalId === id).at(-1)?.decision
        ?.terminalId,
      decisions[id]![1],
    );
  assert.equal(h.imageBuilds.length, 1);
  assert.ok(h.imageBuilds[0]!.includes("jq"));
  assert.equal(h.imageBuilds[0]!.includes("curl"), false);
  assert.equal(h.attachedEvents(), 1);
  assertNoSlashCommandsReachedPi(h);
});

/* @covers CLI-6453A00A
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When integral shows top-level CLI help or local talk help
		Then it identifies the equivalent spelling for every shared operation on the other surface
Given an operation is specific to host administration, scripting, or an attached terminal
	When integral shows top-level CLI help or local talk help
		Then `server`, `talk`, `schedule`, `image`, `config`, and `version` remain CLI-only
			And connection setup, credential rotation, and removal remain CLI-only
			And structured-output flags remain CLI-only
			And `/exit` remains talk-only
			And integral does not treat an arbitrary top-level CLI command as a local talk command
*/
test("[CLI-6453A00A] [CLI-D1B5816E] help names equivalent spellings and talk rejects CLI-only commands and structured output", async (t) => {
  const h = await startHarness(t);
  await saveConnection(
    h.paths,
    validateConnection({
      name: "docs",
      kind: "http",
      auth: "none",
      url: "https://docs.example.test",
    }),
  );
  assert.equal((await h.shellModel(["work"])).code, 0);
  const unsupported = [
      "/server status",
      "/talk",
      "/schedule ls",
      "/image edit",
      "/config show",
      "/version",
      "/connection add docs --auth none",
      "/connection rm docs",
      "/status --json",
      "/approvals --json",
      "/connection ls --json",
      "/queue",
    ],
    structured = ["/queue ls --json", "/tasks ls --json", "/tasks --json"];
  const run = await runTalk(h, [
    "/help",
    ...unsupported,
    ...structured,
    "/status",
    "/exit",
  ]);
  const top = await h.shell(["--help"]),
    talkHelp = await h.shell(["talk", "--help"]),
    help = run.output("/help").stdout;

  assert.equal(run.code, 0);
  assert.equal(top.code, 0);
  assert.ok(talkHelp.stdout.endsWith(help));
  const topLine = (command: string) =>
      top.stdout.split("\n").find((line) => line.startsWith(`  ${command} `)) ??
      "",
    talkLine = (command: string) =>
      help.split("\n").find((line) => line.startsWith(`${command} `)) ?? "";
  for (const [command, talkSpelling] of [
    ["status", "/status"],
    ["model", "/model"],
    ["queue", "/queue"],
    ["task", "/tasks"],
    ["approval", "/approvals, /approve, /deny"],
    ["connection", "/connection catalog or ls"],
  ])
    assert.match(
      topLine(command!),
      new RegExp(`\\(in talk: ${talkSpelling}\\)`),
    );
  for (const [talkCommandText, shellSpelling] of [
    ["/status", "(integral status)"],
    ["/model [<pattern>...]", "(integral model [<pattern>...])"],
    ["/connection catalog", "(integral connection catalog)"],
    ["/connection ls", "(integral connection ls)"],
    ["/queue ls", "(integral queue ls)"],
    ["/queue edit <id> <text>", "(integral queue edit ...)"],
    ["/queue delete <id>", "(integral queue delete ...)"],
    ["/tasks [ls]", "(integral task ls)"],
    ["/tasks show <id>", "(integral task show <id>)"],
    ["/tasks cancel <id>", "(integral task cancel <id>)"],
    ["/approvals", "(integral approval ls)"],
    ["/approve <id>", "(integral approval approve <id>)"],
    ["/deny <id>", "(integral approval deny <id>)"],
  ])
    assert.ok(
      talkLine(talkCommandText!).endsWith(shellSpelling!),
      `${talkCommandText} help must name ${shellSpelling}`,
    );

  for (const command of [
    "server",
    "talk",
    "schedule",
    "image",
    "config",
    "version",
  ]) {
    assert.ok(topLine(command), `top help lists ${command}`);
    assert.doesNotMatch(topLine(command), /in talk/);
  }
  assert.match(
    help,
    /Host administration remains in the shell: integral server, talk, schedule, image, config, version, and connection add \(including credential rotation\) or rm\./,
  );
  assert.match(help, /Structured --json output is CLI-only\./);
  assert.match(talkLine("/exit"), /detach this terminal/);
  assert.doesNotMatch(top.stdout, /exit/);
  const exit = await h.shell(["exit"]);
  assert.notEqual(exit.code, 0);
  assert.equal(exit.stderr, "integral: unknown command: exit\n");

  for (const line of unsupported) {
    assert.equal(
      run.output(line).stderr,
      "Unknown local command. Enter /help.\n",
      line,
    );
    assert.equal(run.output(line).stdout, "", line);
  }
  for (const line of structured) {
    assert.equal(
      run.output(line).stderr,
      "integral: structured output flags are available only in the CLI\n",
      line,
    );
    assert.equal(run.output(line).stdout, "", line);
  }
  const shellJson = await h.shell(["status", "--json"]);
  assert.equal(shellJson.code, 0);
  assert.equal(
    (JSON.parse(shellJson.stdout) as { attached: number }).attached,
    0,
  );
  assert.match(run.output("/status").stdout, /^terminals: 1 attached$/m);
  assert.deepEqual(
    (await listConnections(h.paths)).map((connection) => connection.name),
    ["docs"],
  );
  assert.deepEqual(h.coordinator.queue.snapshot(), []);
  assert.equal(h.attachedEvents(), 1);
  assertNoSlashCommandsReachedPi(h);
});

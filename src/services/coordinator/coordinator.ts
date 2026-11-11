import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { EffectiveConfig } from "../../stores/config.ts";
import type { IntegralPaths } from "../../platform/deployment-paths.ts";
import { MessageQueue } from "../../stores/message-queue.ts";
import {
  ConversationStore,
  ModelSelectionStore,
} from "../../stores/conversation-store.ts";
import {
  listModelChoices,
  type ModelCatalog,
  type ModelCatalogProgress,
} from "../../integrations/pi/model-catalog.ts";
import {
  matchModelChoices,
  sameSelection,
  type ModelChoice,
  type ModelSelection,
} from "../../domain/model-selection.ts";
import {
  componentIdentity,
  deploymentId,
  readComponentRecord,
  updateComponentRecord,
  verifyInternal,
} from "../../platform/component-identity.ts";
import { atomicWrite, readText } from "../../platform/files.ts";
import { join } from "node:path";
import { IntegralError } from "../../platform/errors.ts";
import {
  nodeHttpServers,
  nodeIntervalTimers,
  type HttpServers,
  type IntervalTimers,
} from "../../platform/timers-and-servers.ts";
import { internalFetch } from "../../platform/internal-http-client.ts";
import {
  TaskQueue,
  type ScheduledTask,
  type TaskOutboxEntry,
} from "../../stores/task-queue.ts";
import type { ScheduledOccurrence } from "../../stores/occurrence-store.ts";
import type { Component } from "../../platform/constants.ts";
import type { Logger } from "../../platform/logging.ts";
import { readJsonObject, writeJson } from "../../platform/json-http.ts";
import { ClientEventStream, type ClientEvent } from "./event-stream.ts";
export type { ClientEvent } from "./event-stream.ts";
import {
  activeModelConnectionNames,
  clearConnectionDegraded,
  credentialSecretValues,
  credentialFor,
  loadConnections,
  markConnectionDegraded,
} from "../../stores/connection-store.ts";
import { redactText } from "../../stores/run-history/redaction.ts";
import {
  DiscordIngressStore,
  DiscordJsListener,
  type DiscordListener,
  type DiscordListenerCallbacks,
  type DiscordMessage,
} from "../../integrations/discord.ts";

interface ConversationScope {
  id: string;
  queue: MessageQueue;
  conversation: ConversationStore;
  modelSelection: ModelSelectionStore;
  discord?: {
    listener: DiscordListener;
    ingress: DiscordIngressStore;
    userId: string;
    channelId: string;
  };
}

interface DeliveredGatewayHealth {
  status: "ready" | "degraded";
  reason?: string;
  deliveredAt: string;
}

function sameGatewayHealth(
  previous: DeliveredGatewayHealth | undefined,
  status: "ready" | "degraded",
  reason?: string,
): boolean {
  return previous?.status === status && previous.reason === reason;
}

function modelConnectionFilter(value: unknown): Set<string> | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((connection) => typeof connection !== "string")
  )
    throw new IntegralError("modelConnections must be an array of names", 400);
  return new Set(value);
}

function taskDescription(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  const titled = /^Task:\s*(.+?)(?:\.\s|$)/i.exec(normalized)?.[1]?.trim();
  if (titled) return titled;
  const sentence = /^(.+?)(?:\.\s|$)/.exec(normalized)?.[1] ?? normalized;
  return sentence.slice(0, 160) || "Scheduled task";
}

function omitInternalTaskIdentifiers(
  text: string,
  entry: TaskOutboxEntry,
): string {
  let sanitized = text.replace(
    /\b[A-F0-9]{64}\b/g,
    "[internal identifier omitted]",
  );

  for (const identifier of [entry.taskId, entry.executionId, entry.scheduleId])
    if (identifier)
      sanitized = sanitized.replaceAll(
        identifier,
        "[internal identifier omitted]",
      );

  return sanitized;
}

export interface CoordinatorDependencies {
  servers: HttpServers;
  intervals: IntervalTimers;
  internalFetch: typeof internalFetch;
  defer(callback: () => void): unknown;
  cancelDeferred(handle: unknown): void;
  now(): number;
  listModelChoices(
    paths: IntegralPaths,
    progress?: ModelCatalogProgress,
  ): Promise<ModelCatalog>;
  createDiscordListener(
    connection: import("../../stores/connection-store.ts").Connection,
    token: string,
    callbacks: DiscordListenerCallbacks,
  ): DiscordListener;
}

const productionDependencies: CoordinatorDependencies = {
  servers: nodeHttpServers,
  intervals: nodeIntervalTimers,
  internalFetch,
  defer: (callback) => setTimeout(callback, 0),
  cancelDeferred: (handle) =>
    clearTimeout(handle as NodeJS.Timeout | undefined),
  now: Date.now,
  listModelChoices: (paths, progress) => listModelChoices(paths, {}, progress),
  createDiscordListener: (connection, token, callbacks) =>
    new DiscordJsListener(connection, token, callbacks),
};

export class Coordinator {
  readonly queue: MessageQueue;
  readonly conversation: ConversationStore;
  readonly modelSelection: ModelSelectionStore;
  readonly tasks: TaskQueue;

  private readonly eventStream = new ClientEventStream();
  readonly events = this.eventStream.events;
  private server: http.Server | undefined;

  private token = "";
  private refreshTimer: unknown;
  private refreshWork: Promise<void> | undefined;
  private refreshCoalesced = 0;
  private outboxFlush: Promise<void> | undefined;
  private catalogRefresh: unknown;
  private workChain: Promise<unknown> = Promise.resolve();
  private connectionGeneration: number | undefined;
  private readonly modelCatalogs = new Map<string, ModelCatalog>();
  private activeModelConnections: string | undefined;
  private readonly modelCatalogLoads = new Map<string, Promise<ModelCatalog>>();
  private readonly dependencies: CoordinatorDependencies;
  private readonly scopes = new Map<string, ConversationScope>();
  private discordScope: ConversationScope | undefined;

  constructor(
    private readonly paths: IntegralPaths,
    private readonly config: EffectiveConfig,
    overrides: Partial<CoordinatorDependencies> = {},
    private readonly logger?: Logger,
  ) {
    this.dependencies = { ...productionDependencies, ...overrides };
    this.queue = new MessageQueue(paths.queue, (event) =>
      this.broadcast(`queue.${event.type}`, event),
    );
    this.conversation = new ConversationStore(paths.conversation);
    this.modelSelection = new ModelSelectionStore(paths.modelSelection);

    this.scopes.set("terminal", {
      id: "terminal",
      queue: this.queue,
      conversation: this.conversation,
      modelSelection: this.modelSelection,
    });

    this.tasks = new TaskQueue(paths);
  }

  async start(): Promise<http.Server> {
    await this.queue.load();
    await this.conversation.load();
    await this.modelSelection.load();
    await this.tasks.load();

    this.token = await componentIdentity(this.paths);
    const server = http.createServer((req, res) => void this.route(req, res));
    this.server = server;

    await this.dependencies.servers.listen(
      server,
      this.config.server.coordinatorPort,
      "127.0.0.1",
    );

    await this.startDiscord().catch((error: unknown) =>
      this.logger?.event(
        "warn",
        "discord.start_failed",
        error instanceof Error ? error.message : String(error),
      ),
    );

    this.refreshTimer = this.dependencies.intervals.setInterval(
      () => void this.refresh().catch(() => undefined),
      500,
    );

    this.catalogRefresh = this.dependencies.defer(() => {
      this.catalogRefresh = undefined;
      void this.modelCatalog().catch(() => undefined);
    });

    return server;
  }

  private async startDiscord(): Promise<void> {
    const loaded = await loadConnections(this.paths);
    const connections = loaded.connections.filter(
      (connection) =>
        connection.kind === "channel" && connection.provider === "discord",
    );

    if (connections.length > 1)
      throw new IntegralError(
        "only one Discord channel connection may be active",
      );

    const connection = connections[0];
    if (!connection?.channelId) return;

    const token = (await credentialFor(this.paths, connection.name))?.trim();
    if (!token) return;

    const directory = join(
        this.paths.channels,
        `discord-${connection.channelId}`,
      ),
      scope: ConversationScope = {
        id: `discord:${connection.channelId}`,
        queue: new MessageQueue(join(directory, "queue.json")),
        conversation: new ConversationStore(
          join(directory, "conversation.jsonl"),
        ),
        modelSelection: new ModelSelectionStore(join(directory, "model.json")),
      },
      ingress = new DiscordIngressStore(join(directory, "ingress.json"));

    await Promise.all([
      scope.queue.load(),
      scope.conversation.load(),
      scope.modelSelection.load(),
      ingress.load(),
    ]);

    if (!scope.modelSelection.get() && this.modelSelection.get())
      await scope.modelSelection.set(this.modelSelection.get()!);

    const listener = this.dependencies.createDiscordListener(
      connection,
      token,
      {
        recoveryPosition: () => ingress.position(),
        accept: (message) => this.submitDiscord(scope, ingress, message),
        unsupported: async () => {
          await listener.reply("I can currently process text messages only.");
        },
        command: (name, subcommand, options) =>
          this.discordCommand(name, subcommand, options),
        failure: (error) =>
          void markConnectionDegraded(this.paths, connection.name, "listener")
            .catch(() => undefined)
            .finally(() =>
              this.logger?.event(
                "warn",
                "discord.listener_failed",
                error.message,
              ),
            ),
      },
    );

    scope.discord = {
      listener,
      ingress,
      userId: connection.userId!,
      channelId: connection.channelId,
    };
    this.discordScope = scope;
    this.scopes.set(scope.id, scope);

    try {
      await listener.start();
      await clearConnectionDegraded(this.paths, connection.name);
    } catch (error) {
      await markConnectionDegraded(this.paths, connection.name, "listener");
      throw error;
    }
  }

  private async discordCommand(
    name: string,
    subcommand: string | undefined,
    options: Record<string, string>,
  ): Promise<string> {
    if (name === "help")
      return [
        "/help — show this help",
        "/status — show deployment and conversation status",
        "/model [search] — show or select the shared model",
        "/queue ls|edit|delete — manage queued conversation messages",
        "/tasks ls|show|cancel — inspect or cancel durable tasks",
      ].join("\n");

    if (name === "status") {
      const selection = this.modelSelection.get(),
        [gateway, runner, scheduler] = await Promise.all([
          readComponentRecord(this.paths, "gateway"),
          readComponentRecord(this.paths, "runner"),
          readComponentRecord(this.paths, "scheduler"),
        ]),
        conversations = [...this.scopes.values()].map((candidate) => {
          const queue = candidate.queue.snapshot(),
            session = candidate.conversation
              .snapshot()
              .filter((event) => event.type === "session")
              .at(-1);
          return `${candidate.id}: ${queue.filter((item) => item.status === "queued").length} queued, ${queue.find((item) => item.status === "in-flight")?.id ?? "idle"}, session ${session?.text === "started" ? session.sessionId : "none"}`;
        });

      return [
        `Discord listener: connected`,
        `Gateway: ${gateway?.status ?? "unavailable"}; runner: ${runner?.status ?? "unavailable"}; scheduler: ${scheduler?.status ?? "unavailable"}`,
        `Model: ${selection ? `${selection.connection}/${selection.model}` : "not selected"}`,
        ...conversations,
        `Tasks: ${this.tasks.snapshot().filter((task) => !["completed", "failed", "cancelled"].includes(task.state)).length} active`,
      ].join("\n");
    }

    if (name === "model") {
      const catalog = await this.modelCatalog(),
        search = options.search?.trim(),
        matches = matchModelChoices(
          catalog.choices,
          search ? search.split(/\s+/) : [],
        );

      if (search && matches.length === 1) {
        await this.selectConversationModel(
          matches[0]!.connection,
          matches[0]!.model,
        );
        return `Selected ${matches[0]!.connection}/${matches[0]!.model}.`;
      }

      const current = this.modelSelection.get(),
        heading = current
          ? `Current: ${current.connection}/${current.model}`
          : "Current: not selected";

      if (!matches.length)
        return `${heading}\nNo models matched; narrow or change the search.`;
      return `${heading}\n${matches.map((choice) => `${choice.connection}/${choice.model}`).join("\n")}${search && matches.length > 1 ? "\nMore than one model matched; narrow the search." : ""}`;
    }

    if (name === "queue") {
      if (!subcommand || subcommand === "ls") {
        const items = [...this.scopes.values()].flatMap((candidate) =>
          candidate.queue
            .snapshot()
            .map((item) => ({ ...item, conversationId: candidate.id })),
        );

        return items.length
          ? items
              .map(
                (item) =>
                  `${item.conversationId}  ${item.id}  ${item.status}  ${item.text}`,
              )
              .join("\n")
          : "All conversation queues are empty.";
      }

      if (!options.id)
        throw new IntegralError("A queue message ID is required.");
      const owner = [...this.scopes.values()].find((candidate) =>
        candidate.queue.snapshot().some((item) => item.id === options.id),
      );
      if (!owner) throw new IntegralError("Queue message not found.", 404);

      if (subcommand === "edit") {
        if (!options.text)
          throw new IntegralError("Replacement text is required.");
        await owner.queue.edit(options.id, options.text);
        await owner.conversation.editUser(options.id, options.text);
        return `Updated queue message ${options.id}.`;
      }

      if (subcommand === "delete") {
        await owner.queue.delete(options.id);
        await owner.conversation.deleteUser(options.id);
        return `Deleted queue message ${options.id}.`;
      }
    }

    if (name === "tasks") {
      const tasks = this.tasks.snapshot(),
        render = (task: ScheduledTask) =>
          `${task.state}  ${task.executionId}  ${task.scheduledFor}  ${task.prompt}`;

      if (!subcommand || subcommand === "ls")
        return tasks.length
          ? tasks.map(render).join("\n")
          : "There are no tasks.";

      if (!options.id) throw new IntegralError("A task ID is required.");
      const task = tasks.find(
        (candidate) => candidate.executionId === options.id,
      );
      if (!task) throw new IntegralError("Task not found.", 404);
      if (subcommand === "show") return JSON.stringify(task, null, 2);
      if (subcommand === "cancel")
        return render(await this.tasks.cancel(options.id));
    }

    throw new IntegralError("Unsupported Discord command.", 400);
  }

  private async deliverDiscord(
    scope: ConversationScope,
    text: string,
  ): Promise<boolean> {
    const listener = scope.discord?.listener;
    if (!listener) return false;
    await listener.typing(false).catch(() => undefined);

    try {
      await listener.reply(text);
      return true;
    } catch (error) {
      this.logger?.event(
        "warn",
        "discord.delivery_failed",
        error instanceof Error ? error.message : String(error),
        { conversation_id: scope.id },
      );
      return false;
    }
  }

  private async notifyGatewayHealth(
    status: "ready" | "degraded",
    error?: string,
  ): Promise<boolean> {
    const scope = this.discordScope;
    if (!scope?.discord) return false;

    const file = join(this.paths.state, "discord-gateway-health.json"),
      raw = await readText(file);

    let previous: DeliveredGatewayHealth | undefined;
    if (raw)
      try {
        const parsed = JSON.parse(raw) as Partial<DeliveredGatewayHealth>;
        if (
          (parsed.status === "ready" || parsed.status === "degraded") &&
          typeof parsed.deliveredAt === "string" &&
          (parsed.reason === undefined || typeof parsed.reason === "string")
        )
          previous = parsed as DeliveredGatewayHealth;
      } catch {
        /* Replace malformed notification state after the next delivery. */
      }

    const secrets = await credentialSecretValues(this.paths),
      reason =
        status === "degraded"
          ? redactText(
              error?.split(/\r?\n/, 1)[0] ?? "No reason was recorded",
              secrets,
            )
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 300)
          : undefined;

    if (sameGatewayHealth(previous, status, reason)) return true;
    if (!previous && status === "ready") {
      await atomicWrite(
        file,
        `${JSON.stringify({ status, deliveredAt: new Date(this.dependencies.now()).toISOString() })}\n`,
      );
      return true;
    }

    const text =
      status === "degraded"
        ? `Integral cannot currently process new messages because its gateway is degraded. Reason: ${reason}. New messages remain safely queued. Run \`integral connection ls\` to see the affected connection.`
        : "Integral's gateway has recovered. Queued messages can resume processing.";
    if (!(await this.deliverDiscord(scope, text))) return false;
    await scope.conversation.append({ type: "notification", text });
    await atomicWrite(
      file,
      `${JSON.stringify({ status, ...(reason ? { reason } : {}), deliveredAt: new Date(this.dependencies.now()).toISOString() })}\n`,
    );
    this.logger?.event(
      "info",
      status === "degraded"
        ? "gateway.health_notification_delivered"
        : "gateway.recovery_notification_delivered",
      "delivered gateway health notification",
      { conversation_id: scope.id, gateway_status: status },
    );
    return true;
  }

  private async submitDiscord(
    scope: ConversationScope,
    ingress: DiscordIngressStore,
    message: DiscordMessage,
  ): Promise<boolean> {
    return this.exclusiveWork(async () => {
      if (ingress.has(message.id)) return false;

      const origin = {
          provider: "discord" as const,
          externalId: message.id,
          userId: message.userId,
          channelId: message.channelId,
        },
        item = await scope.queue.enqueue(message.text, origin),
        alreadyRecorded = scope.conversation
          .snapshot()
          .some((event) => event.origin?.externalId === message.id);

      if (!alreadyRecorded)
        await scope.conversation.append({
          type: "user",
          messageId: item.id,
          text: item.text,
          origin,
        });

      await ingress.record(message.id);
      this.logger?.event(
        "info",
        "discord.message_accepted",
        "accepted Discord conversation message",
        { message_id: item.id, conversation_id: scope.id },
      );

      await scope.discord?.listener.typing(true).catch(() => undefined);

      if (!scope.modelSelection.get()) {
        await this.deliverDiscord(
          scope,
          "Select a model with /model before I can process this message.",
        );
        return true;
      }

      if (
        scope.queue
          .snapshot()
          .some((candidate) => candidate.status === "in-flight")
      ) {
        await scope.queue.markSteering(item.id);

        const response = await this.dependencies
          .internalFetch(
            this.paths,
            "coordinator",
            "runner",
            "/integral/internal/steer",
            {
              method: "POST",
              body: JSON.stringify({
                conversationId: scope.id,
                messageId: item.id,
                text: item.text,
              }),
            },
          )
          .catch(() => undefined);
        if (!response?.ok) await scope.queue.release(item.id);
      }

      return true;
    });
  }

  private async refresh(): Promise<void> {
    if (this.refreshWork) {
      this.refreshCoalesced++;
      return this.refreshWork;
    }

    const started = this.dependencies.now(),
      work = Promise.all([
        this.adoptGeneration(),
        this.adoptExternalModelSelection(),
        this.flushTaskOutbox(),
      ]).then(() => undefined);

    this.refreshWork = work;
    let failed = false;

    try {
      await work;
    } catch (error) {
      failed = true;
      this.logger?.event(
        "warn",
        "coordinator.refresh_failed",
        error instanceof Error ? error.message : String(error),
        {
          elapsed_ms: this.dependencies.now() - started,
          coalesced_intervals: this.refreshCoalesced,
        },
      );
      throw error;
    } finally {
      this.refreshWork = undefined;
      const coalesced = this.refreshCoalesced;
      this.refreshCoalesced = 0;

      if (coalesced && !failed) {
        this.logger?.event(
          "warn",
          "coordinator.refresh_coalesced",
          "coordinator maintenance exceeded its interval",
          {
            elapsed_ms: this.dependencies.now() - started,
            coalesced_intervals: coalesced,
          },
        );
      }
    }
  }

  private async adoptExternalModelSelection(): Promise<void> {
    const previous = this.modelSelection.get();
    await this.modelSelection.load();
    const current = this.modelSelection.get();

    if (!sameSelection(previous, current) && current) {
      await this.setSharedModelSelection(current);
      this.modelCatalogs.clear();
      this.modelCatalogLoads.clear();
      this.broadcast("conversation.selection", current);
    }
  }

  async flushTaskOutbox(): Promise<void> {
    if (this.outboxFlush) return this.outboxFlush;

    const work = this.flushTaskOutboxOnce();
    this.outboxFlush = work;
    try {
      await work;
    } finally {
      this.outboxFlush = undefined;
    }
  }

  private async flushTaskOutboxOnce(): Promise<void> {
    const outbox = this.tasks.outbox();
    if (!outbox.length) return;

    const secrets = await credentialSecretValues(this.paths);

    for (const entry of outbox) {
      if (
        entry.outcome === "failed" &&
        entry.origin &&
        !entry.notificationDeliveredAt
      ) {
        const scope = this.scopes.get(entry.origin.conversationId);
        if (scope?.discord) {
          const task = this.tasks
              .snapshot()
              .find((candidate) => candidate.executionId === entry.executionId),
            description = taskDescription(task?.prompt ?? "Scheduled task"),
            reason = entry.error
              ? redactText(entry.error, secrets)
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 300)
              : "No failure reason was recorded",
            failedAt = task?.completedAt ?? entry.createdAt,
            retryGuidance =
              task?.triggerType === "recurring"
                ? " Correct the problem before the next scheduled occurrence."
                : "",
            text = omitInternalTaskIdentifiers(
              `${description} failed at ${failedAt}: ${reason}.${retryGuidance}`,
              entry,
            );

          if (!(await this.deliverDiscord(scope, text))) continue;
          await scope.conversation.append({ type: "notification", text });
          await this.tasks.markOutboxNotificationDelivered(entry.executionId);
          this.logger?.event(
            "info",
            "task.notification_delivered",
            "delivered task outcome notification",
            {
              execution_id: entry.executionId,
              schedule_id: entry.scheduleId,
              conversation_id: scope.id,
              outcome: entry.outcome,
            },
          );
        }
      }

      const response = await this.dependencies
        .internalFetch(
          this.paths,
          "coordinator",
          "scheduler",
          `/integral/internal/occurrences/${entry.executionId}/ack`,
          { method: "POST", body: JSON.stringify(entry) },
        )
        .catch(() => undefined);

      if (response?.ok) {
        await this.tasks.acknowledgeOutbox(entry.executionId);
        this.logger?.event(
          "debug",
          "task.outbox_acknowledged",
          "scheduler acknowledged task outcome",
          {
            execution_id: entry.executionId,
            schedule_id: entry.scheduleId,
            outcome: entry.outcome,
          },
        );
      } else
        this.logger?.event(
          "warn",
          "task.outbox_ack_failed",
          "scheduler did not acknowledge task outcome",
          {
            execution_id: entry.executionId,
            schedule_id: entry.scheduleId,
            outcome: entry.outcome,
            status: response?.status ?? "unavailable",
          },
        );
    }
  }

  private async adoptGeneration(): Promise<void> {
    const generation = Number(
      (
        await readText(join(this.paths.state, "connection-generation"))
      )?.trim() || "0",
    );

    const changed = this.connectionGeneration !== generation;
    this.connectionGeneration = generation;

    await updateComponentRecord(this.paths, "coordinator", {
      connectionGeneration: generation,
      status: "ready",
    });

    if (changed) void this.modelCatalog(generation).catch(() => undefined);
  }

  private broadcast(type: string, data: unknown): ClientEvent {
    return this.eventStream.broadcast(type, data);
  }

  private snapshot(
    scope: ConversationScope = this.scopes.get("terminal")!,
  ): Record<string, unknown> {
    return {
      deploymentId: deploymentId(this.paths),
      conversation: scope.conversation.snapshot(),
      queue: scope.queue.snapshot(),
      tasks: this.tasks.snapshot(),
      modelSelection: scope.modelSelection.get() ?? null,
      eventSequence: this.eventStream.sequence,
      attached: this.eventStream.attached,
    };
  }

  private internal(
    req: IncomingMessage,
    expected: Component | Component[] = "runner",
  ): boolean {
    return verifyInternal(
      req.headers,
      expected,
      this.token,
      deploymentId(this.paths),
    );
  }

  async modelMenu(): Promise<{
    choices: ModelChoice[];
    current: ModelChoice | null;
    piVersion?: string;
  }> {
    const catalog = await this.modelCatalog();
    return {
      choices: catalog.choices,
      current: this.modelSelection.get() ?? null,
      ...(catalog.piVersion ? { piVersion: catalog.piVersion } : {}),
    };
  }

  async selectConversationModel(
    connection: string,
    model: string,
  ): Promise<ModelChoice> {
    return this.exclusiveWork(async () => {
      if (
        [...this.scopes.values()].some((scope) =>
          scope.queue.snapshot().some((item) => item.status === "in-flight"),
        )
      )
        throw new IntegralError(
          "cannot change model selection while a Pi turn is in flight",
          409,
        );

      const catalog = await this.modelCatalog(),
        choice = catalog.choices.find(
          (candidate) =>
            candidate.connection === connection && candidate.model === model,
        );
      if (!choice)
        throw new IntegralError(
          "selected model connection or model is no longer available",
          409,
        );

      const previous = this.modelSelection.get();
      if (!sameSelection(previous, choice)) {
        await this.setSharedModelSelection(choice);
        this.broadcast("conversation.selection", choice);
      }

      return choice;
    });
  }

  private async setSharedModelSelection(
    selection: ModelSelection,
  ): Promise<void> {
    await Promise.all(
      [...this.scopes.values()].map((scope) =>
        scope.modelSelection.set(selection),
      ),
    );
  }

  private async modelCatalog(generation?: number): Promise<ModelCatalog> {
    // A connection that recovers or degrades changes the choices without
    // changing the connection generation, so it discards every cached catalog.
    const active = (await activeModelConnectionNames(this.paths))
      .sort()
      .join(",");
    if (active !== this.activeModelConnections) {
      this.modelCatalogs.clear();
      this.activeModelConnections = active;
    }

    const currentGeneration = generation ?? (await this.readGeneration()),
      key = `${this.config.fingerprint}:${currentGeneration}`,
      cached = this.modelCatalogs.get(key);

    this.connectionGeneration = currentGeneration;
    if (cached) return cached;
    const existing = this.modelCatalogLoads.get(key);
    if (existing) return existing;

    this.logger?.event(
      "info",
      "model_catalog.refresh",
      "refreshing the model catalog",
      { connection_generation: currentGeneration },
    );

    const loading = this.dependencies
      .listModelChoices(this.paths, (stage, message, context) =>
        this.logger?.event("info", "model_catalog.progress", message, {
          stage,
          ...context,
        }),
      )
      .then((catalog) => {
        this.modelCatalogs.set(key, catalog);
        while (this.modelCatalogs.size > 4)
          this.modelCatalogs.delete(this.modelCatalogs.keys().next().value!);
        this.logger?.event(
          "info",
          "model_catalog.ready",
          "model catalog is ready",
          {
            connection_generation: currentGeneration,
            model_count: catalog.choices.length,
            ...(catalog.piVersion ? { pi_version: catalog.piVersion } : {}),
          },
        );
        return catalog;
      })
      .catch((error: unknown) => {
        this.logger?.event(
          "warn",
          "model_catalog.failed",
          error instanceof Error ? error.message : String(error),
          { connection_generation: currentGeneration },
        );
        throw error;
      })
      .finally(() => this.modelCatalogLoads.delete(key));

    this.modelCatalogLoads.set(key, loading);
    return loading;
  }

  private async readGeneration(): Promise<number> {
    return Number(
      (
        await readText(join(this.paths.state, "connection-generation"))
      )?.trim() || "0",
    );
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://coordinator");

      if (url.pathname === "/integral/health" && req.method === "GET") {
        const [gateway, runner, scheduler] = await Promise.all([
          readComponentRecord(this.paths, "gateway"),
          readComponentRecord(this.paths, "runner"),
          readComponentRecord(this.paths, "scheduler"),
        ]);
        json(res, 200, {
          component: "coordinator",
          deploymentId: deploymentId(this.paths),
          status:
            gateway?.status === "ready" &&
            runner?.status === "ready" &&
            scheduler?.status === "ready"
              ? "ready"
              : "degraded",
          dependencies: {
            gateway: gateway?.status ?? "unavailable",
            runner: runner?.status ?? "unavailable",
            scheduler: scheduler?.status ?? "unavailable",
          },
        });
        return;
      }

      if (url.pathname === "/integral/snapshot" && req.method === "GET") {
        const conversationId = url.searchParams.get("conversationId");
        if (conversationId && !this.internal(req, "gateway"))
          return unauthorized(res);
        const scope = conversationId
          ? this.scopes.get(conversationId)
          : this.scopes.get("terminal");
        if (!scope) throw new IntegralError("unknown conversation", 404);

        json(res, 200, this.snapshot(scope));
        return;
      }

      if (url.pathname === "/integral/events" && req.method === "GET") {
        this.stream(req, res);
        return;
      }

      if (url.pathname === "/integral/models" && req.method === "GET") {
        json(res, 200, await this.modelMenu());
        return;
      }

      if (url.pathname === "/integral/selection" && req.method === "PUT") {
        const body = await bodyJson(req),
          connection = stringValue(body.connection),
          model = stringValue(body.model);

        const selection = await this.selectConversationModel(connection, model);
        json(res, 200, selection);
        return;
      }

      if (url.pathname === "/integral/messages" && req.method === "POST") {
        if (!this.modelSelection.get())
          throw new IntegralError(
            "select a model before submitting a message",
            409,
          );

        const body = await bodyJson(req),
          text = stringValue(body.text),
          terminalId = stringValue(body.terminalId);
        const item = await this.submitMessage(text, terminalId);
        json(res, 201, item);
        return;
      }

      const queueMatch = url.pathname.match(/^\/integral\/queue\/([^/]+)$/);
      if (queueMatch && req.method === "PATCH") {
        const body = await bodyJson(req),
          item = await this.queue.edit(queueMatch[1]!, stringValue(body.text));
        await this.conversation.editUser(item.id, item.text);
        json(res, 200, item);
        return;
      }

      if (queueMatch && req.method === "DELETE") {
        await this.queue.delete(queueMatch[1]!);
        await this.conversation.deleteUser(queueMatch[1]!);
        res.writeHead(204).end();
        return;
      }

      const taskIngress = url.pathname.match(
        /^\/integral\/internal\/tasks\/([^/]+)$/,
      );

      if (taskIngress && req.method === "PUT") {
        if (!this.internal(req, "scheduler")) return unauthorized(res);

        const body = (await bodyJson(req)) as unknown as ScheduledOccurrence;
        if (body.executionId !== taskIngress[1])
          throw new IntegralError("task execution ID does not match path", 400);

        const task = await this.tasks.accept(body);
        json(res, 200, task);
        return;
      }

      if (
        url.pathname === "/integral/internal/tasks/claim" &&
        req.method === "POST"
      ) {
        if (!this.internal(req)) return unauthorized(res);

        const body = await bodyJson(req),
          modelConnections = modelConnectionFilter(body.modelConnections),
          selection = this.modelSelection.get();

        // Scheduled work runs on the shared model selection as it stands now.
        // A degraded selected connection leaves tasks queued without an
        // attempt; no selection at all fails each task before its container
        // starts, so the reason is recorded and retried with backoff.
        if (
          selection &&
          modelConnections?.has(selection.connection) === false
        ) {
          json(res, 200, { selection });
          return;
        }

        json(res, 200, {
          task: await this.tasks.claim(),
          selection: selection ?? null,
        });
        return;
      }

      const taskDeclaration = url.pathname.match(
        /^\/integral\/internal\/tasks\/([^/]+)\/declare$/,
      );

      if (taskDeclaration && req.method === "POST") {
        if (!this.internal(req, "gateway")) return unauthorized(res);

        const body = await bodyJson(req),
          outcome = stringValue(body.outcome);
        if (outcome !== "complete" && outcome !== "failed")
          throw new IntegralError("invalid task outcome declaration", 400);

        json(
          res,
          200,
          await this.tasks.declareOutcome(
            taskDeclaration[1]!,
            stringValue(body.attemptId),
            outcome,
            stringValue(body.message),
          ),
        );
        return;
      }

      const taskOutcome = url.pathname.match(
        /^\/integral\/internal\/tasks\/([^/]+)\/(start|defer|complete|fail|finalize)$/,
      );

      if (taskOutcome && req.method === "POST") {
        if (!this.internal(req)) return unauthorized(res);

        const body = await bodyJson(req),
          task =
            taskOutcome[2] === "start"
              ? await this.tasks.start(
                  taskOutcome[1]!,
                  stringValue(body.claimId),
                )
              : taskOutcome[2] === "defer"
                ? await this.tasks.releaseClaim(
                    taskOutcome[1]!,
                    stringValue(body.claimId),
                    stringValue(body.error, "task provisioning failed"),
                  )
                : taskOutcome[2] === "complete"
                  ? await this.tasks.complete(
                      taskOutcome[1]!,
                      stringValue(body.attemptId),
                      stringValue(body.result),
                      numberValue(body.exitCode),
                    )
                  : taskOutcome[2] === "finalize"
                    ? await this.tasks.finalize(
                        taskOutcome[1]!,
                        stringValue(body.attemptId),
                        numberValue(body.exitCode),
                      )
                    : await this.tasks.fail(
                        taskOutcome[1]!,
                        stringValue(body.attemptId),
                        stringValue(body.error, "task failed"),
                        optionalNumber(body.exitCode),
                      );

        json(res, 200, task);
        return;
      }

      const taskCancel = url.pathname.match(
        /^\/integral\/tasks\/([^/]+)\/cancel$/,
      );

      if (taskCancel && req.method === "POST") {
        json(
          res,
          200,
          await this.tasks.cancel(decodeURIComponent(taskCancel[1]!)),
        );
        return;
      }

      if (url.pathname === "/integral/tasks" && req.method === "GET") {
        json(res, 200, this.tasks.snapshot());
        return;
      }

      const taskInspection = url.pathname.match(/^\/integral\/tasks\/([^/]+)$/);
      if (taskInspection && req.method === "GET") {
        const executionId = decodeURIComponent(taskInspection[1]!),
          task = this.tasks
            .snapshot()
            .find((candidate) => candidate.executionId === executionId);
        if (!task)
          throw new IntegralError(`task not found: ${executionId}`, 404);

        json(res, 200, task);
        return;
      }

      if (
        url.pathname === "/integral/internal/claim" &&
        req.method === "POST"
      ) {
        if (!this.internal(req)) return unauthorized(res);

        const body = await bodyJson(req),
          modelConnections = modelConnectionFilter(body.modelConnections);

        const result = await this.exclusiveWork(async () => {
          for (const scope of this.scopes.values()) {
            const selection = scope.modelSelection.get();
            if (!selection) continue;
            if (modelConnections && !modelConnections.has(selection.connection))
              continue;
            const item = await scope.queue.claim();
            if (item) return { item, selection, scope };
          }
          const scope = this.scopes.get("terminal")!;
          return { item: undefined, selection: undefined, scope };
        });

        if (result.item)
          this.logger?.event(
            "info",
            "queue.message_claimed",
            "runner claimed conversation message",
            {
              message_id: result.item.id,
              conversation_id: result.scope.id,
              attempt: result.item.attempts,
            },
          );

        json(res, 200, {
          message: result.item,
          selection: result.selection ?? null,
          conversationId: result.scope.id,
          context: result.scope.conversation.context(
            this.config.conversation.contextMaxMessages,
            this.config.conversation.contextMaxChars,
          ),
        });
        return;
      }

      if (
        url.pathname === "/integral/internal/channel-notification" &&
        req.method === "POST"
      ) {
        if (!this.internal(req, "gateway")) return unauthorized(res);

        const body = await bodyJson(req),
          scope = this.scopes.get(stringValue(body.conversationId));

        if (
          !scope?.discord ||
          scope.discord.userId !== stringValue(body.userId) ||
          scope.discord.channelId !== stringValue(body.channelId)
        )
          throw new IntegralError(
            "unknown conversation notification route",
            404,
          );

        const text = stringValue(body.text);
        if (!text)
          throw new IntegralError("notification text is required", 400);

        if (!(await this.deliverDiscord(scope, text)))
          throw new IntegralError("Discord notification delivery failed", 503);
        await scope.conversation.append({ type: "notification", text });
        res.writeHead(204).end();
        return;
      }

      if (
        url.pathname === "/integral/internal/gateway-health-notification" &&
        req.method === "POST"
      ) {
        if (!this.internal(req, "gateway")) return unauthorized(res);

        const body = await bodyJson(req),
          status = stringValue(body.status),
          error = stringValue(body.error);

        if (status !== "ready" && status !== "degraded")
          throw new IntegralError("invalid gateway health status", 400);
        if (!(await this.notifyGatewayHealth(status, error || undefined)))
          throw new IntegralError(
            "Discord gateway health notification delivery failed",
            503,
          );

        res.writeHead(204).end();
        return;
      }

      if (
        url.pathname === "/integral/internal/session" &&
        req.method === "POST"
      ) {
        if (!this.internal(req)) return unauthorized(res);

        const body = await bodyJson(req),
          sessionId = stringValue(body.sessionId),
          state = stringValue(body.state),
          scope = this.scopes.get(stringValue(body.conversationId, "terminal"));

        if (!sessionId || !["started", "ended"].includes(state))
          throw new IntegralError("invalid session event", 400);
        if (!scope) throw new IntegralError("unknown conversation", 404);

        const event = await scope.conversation.append({
          type: "session",
          sessionId,
          text: state,
          ...(stringValue(body.parentSessionId)
            ? { parentSessionId: stringValue(body.parentSessionId) }
            : {}),
        });

        if (scope.id === "terminal")
          this.broadcast("conversation.session", event);
        res.writeHead(204).end();
        return;
      }

      const workMatch = url.pathname.match(
        /^\/integral\/internal\/work\/([^/]+)\/(complete|release)$/,
      );

      if (workMatch && req.method === "POST") {
        if (!this.internal(req)) return unauthorized(res);

        const [, id, action] = workMatch;
        const body = await bodyJson(req);
        const scope = this.scopes.get(
          stringValue(body.conversationId, "terminal"),
        );
        if (!scope) throw new IntegralError("unknown conversation", 404);

        if (action === "complete") {
          const event = await scope.conversation.append({
            type: "assistant",
            messageId: id!,
            text: stringValue(body.text),
          });

          await scope.queue.complete(id!);
          const steered = Array.isArray(body.steeredMessageIds)
            ? body.steeredMessageIds.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
          for (const steeredId of steered)
            await scope.queue.complete(steeredId);

          this.logger?.event(
            "info",
            "queue.message_completed",
            "completed conversation message",
            {
              message_id: id!,
              conversation_id: scope.id,
              steered_message_count: steered.length,
            },
          );

          if (scope.id === "terminal")
            this.broadcast("conversation.assistant", event);
          else await this.deliverDiscord(scope, event.text ?? "");
        } else {
          await scope.queue.release(
            id!,
            stringValue(body.reason, "interrupted"),
          );

          const steered = Array.isArray(body.steeredMessageIds)
            ? body.steeredMessageIds.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
          for (const steeredId of steered) await scope.queue.release(steeredId);

          this.logger?.event(
            "warn",
            "queue.message_released",
            "returned interrupted conversation message to the queue",
            {
              message_id: id!,
              conversation_id: scope.id,
              steered_message_count: steered.length,
            },
          );

          const event = await scope.conversation.append({
            type: "error",
            messageId: id!,
            text: stringValue(body.reason, "turn interrupted"),
          });

          if (scope.id === "terminal")
            this.broadcast("conversation.error", event);
          else
            await this.deliverDiscord(
              scope,
              "I couldn't complete that request. It remains queued when retrying is safe; check /status and try again.",
            );
        }

        res.writeHead(204).end();
        return;
      }

      if (url.pathname === "/integral/status" && req.method === "GET") {
        const [gateway, runner, scheduler] = await Promise.all([
          readComponentRecord(this.paths, "gateway"),
          readComponentRecord(this.paths, "runner"),
          readComponentRecord(this.paths, "scheduler"),
        ]);

        const queue = this.queue.snapshot();
        const sessionEvent = this.conversation
          .snapshot()
          .filter((e) => e.type === "session")
          .at(-1);

        json(res, 200, {
          gateway: gateway?.status ?? "unavailable",
          runner: runner?.status ?? "unavailable",
          scheduler: scheduler?.status ?? "unavailable",
          container: sessionEvent?.text === "started" ? "healthy" : "stopped",
          session:
            sessionEvent?.text === "started" ? sessionEvent.sessionId : null,
          selection: this.modelSelection.get() ?? null,
          queueDepth: queue.filter((m) => m.status === "queued").length,
          inFlight: queue.find((m) => m.status === "in-flight")?.id ?? null,
          attached: this.eventStream.attached,
          taskQueueDepth: this.tasks
            .snapshot()
            .filter((task) => ["queued", "retry-wait"].includes(task.state))
            .length,
          taskInFlight:
            this.tasks.snapshot().find((task) => task.state === "running")
              ?.id ?? null,
        });
        return;
      }

      res.writeHead(404).end("not found\n");
    } catch (error) {
      const status = error instanceof IntegralError ? error.exitCode : 500;
      json(res, status >= 400 && status < 600 ? status : 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private exclusiveWork<T>(work: () => Promise<T>): Promise<T> {
    const result = this.workChain.then(work, work);
    this.workChain = result.catch(() => undefined);
    return result;
  }

  private async submitMessage(text: string, terminalId: string) {
    const item = await this.queue.enqueue(text),
      event = await this.conversation.append({
        type: "user",
        messageId: item.id,
        text: item.text,
      });

    this.broadcast("conversation.user", { ...event, terminalId });
    return item;
  }

  private stream(req: IncomingMessage, res: ServerResponse): void {
    this.eventStream.attach(req, res, () => this.snapshot());
  }

  async stop(): Promise<void> {
    if (this.catalogRefresh !== undefined) {
      this.dependencies.cancelDeferred(this.catalogRefresh);
      this.catalogRefresh = undefined;
    }

    this.dependencies.intervals.clearInterval(this.refreshTimer);
    this.eventStream.clear();

    await this.discordScope?.discord?.listener.stop();

    const server = this.server;
    this.server = undefined;
    if (server) await this.dependencies.servers.close(server);
  }
}

async function bodyJson(
  req: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<Record<string, unknown>> {
  return await readJsonObject(req, { maxBytes });
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new IntegralError("expected an integer", 400);
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : numberValue(value);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  writeJson(res, status, value);
}

function unauthorized(res: ServerResponse): void {
  json(res, 401, { error: "unauthorized component request" });
}

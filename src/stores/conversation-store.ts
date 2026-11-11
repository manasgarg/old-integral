import { appendFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite, ensureDir, readText } from "../platform/files.ts";
import type { ModelSelection } from "../domain/model-selection.ts";
import type { MessageOrigin } from "./message-queue.ts";

export interface ConversationEvent {
  sequence: number;
  type: "user" | "assistant" | "error" | "session" | "notification";
  messageId?: string;
  text?: string;
  sessionId?: string;
  parentSessionId?: string;
  timestamp: string;
  origin?: MessageOrigin;
}

export class ConversationStore {
  private events: ConversationEvent[] = [];

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    const raw = await readText(this.file);
    if (!raw) return;
    this.events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ConversationEvent);
  }

  snapshot(): ConversationEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  async append(
    event: Omit<ConversationEvent, "sequence" | "timestamp">,
  ): Promise<ConversationEvent> {
    const full: ConversationEvent = {
      ...event,
      sequence: (this.events.at(-1)?.sequence ?? 0) + 1,
      timestamp: new Date().toISOString(),
    };

    await ensureDir(dirname(this.file));
    await appendFile(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 });

    const handle = await open(this.file, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    this.events.push(full);
    return { ...full };
  }

  async editUser(messageId: string, text: string): Promise<void> {
    const event = this.events.find(
      (item) => item.type === "user" && item.messageId === messageId,
    );
    if (!event) return;
    event.text = text;
    await this.rewrite();
  }

  async deleteUser(messageId: string): Promise<void> {
    const index = this.events.findIndex(
      (item) => item.type === "user" && item.messageId === messageId,
    );
    if (index < 0) return;
    this.events.splice(index, 1);
    for (let i = 0; i < this.events.length; i++)
      this.events[i]!.sequence = i + 1;
    await this.rewrite();
  }

  private async rewrite(): Promise<void> {
    await atomicWrite(
      this.file,
      this.events.map((event) => JSON.stringify(event)).join("\n") +
        (this.events.length ? "\n" : ""),
    );
  }

  context(maxMessages: number, maxChars: number): ConversationEvent[] {
    if (maxMessages === 0 || maxChars === 0) return [];

    const selected: ConversationEvent[] = [];
    let chars = 0;

    for (const event of this.events
      .filter((item) => item.type === "user" || item.type === "assistant")
      .toReversed()) {
      const length = event.text?.length ?? 0;
      if (selected.length >= maxMessages || chars + length > maxChars) break;
      chars += length;
      selected.unshift({ ...event });
    }

    return selected;
  }
}

export class ModelSelectionStore {
  private selection: ModelSelection | undefined;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    const raw = await readText(this.file);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<ModelSelection>;

    if (
      typeof parsed.connection !== "string" ||
      typeof parsed.provider !== "string" ||
      typeof parsed.model !== "string" ||
      !parsed.connection ||
      !parsed.provider ||
      !parsed.model
    ) {
      this.selection = undefined;
      return;
    }

    this.selection = {
      connection: parsed.connection,
      provider: parsed.provider,
      model: parsed.model,
    };
  }

  get(): ModelSelection | undefined {
    return this.selection ? { ...this.selection } : undefined;
  }

  async set(selection: ModelSelection): Promise<void> {
    const { connection, provider, model } = selection;
    await atomicWrite(
      this.file,
      `${JSON.stringify({ connection, provider, model })}\n`,
    );
    this.selection = { connection, provider, model };
  }
}

import { createHash } from "node:crypto";
import { atomicWrite, readText } from "../platform/files.ts";
import { IntegralError } from "../platform/errors.ts";
import { SerialExecutor } from "../platform/serial-executor.ts";

export type QueueStatus = "queued" | "in-flight" | "steering";

export interface MessageOrigin {
  provider: "discord";
  externalId: string;
  userId: string;
  channelId: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  order: number;
  status: QueueStatus;
  attempts: number;
  createdAt: string;
  origin?: MessageOrigin;
}

interface QueueFile {
  nextOrder: number;
  items: QueuedMessage[];
  snowflake?: SnowflakeState;
}

export const SNOWFLAKE_EPOCH = Date.UTC(2026, 0, 1);
const MAX_SNOWFLAKE_TIME = (1n << 41n) - 1n;
const MAX_WORKER_ID = (1 << 10) - 1;
const MAX_SEQUENCE = (1 << 12) - 1;

export interface SnowflakeState {
  timestamp: number;
  sequence: number;
}

export function createSnowflakeId(
  timestamp: number,
  workerId: number,
  previous?: SnowflakeState,
): { id: string; state: SnowflakeState } {
  if (!Number.isSafeInteger(timestamp))
    throw new RangeError("Snowflake timestamp must be an integer");
  if (!Number.isInteger(workerId) || workerId < 0 || workerId > MAX_WORKER_ID)
    throw new RangeError("Snowflake worker ID must fit in 10 bits");

  let effectiveTimestamp = Math.max(
      timestamp,
      previous?.timestamp ?? timestamp,
    ),
    sequence =
      previous && effectiveTimestamp === previous.timestamp
        ? previous.sequence + 1
        : 0;

  if (sequence > MAX_SEQUENCE) {
    effectiveTimestamp++;
    sequence = 0;
  }

  const elapsed = BigInt(effectiveTimestamp - SNOWFLAKE_EPOCH);
  if (elapsed < 0n || elapsed > MAX_SNOWFLAKE_TIME)
    throw new RangeError("Snowflake timestamp is outside the supported epoch");

  const value = (elapsed << 22n) | (BigInt(workerId) << 12n) | BigInt(sequence);
  return {
    id: value.toString(36).toUpperCase(),
    state: { timestamp: effectiveTimestamp, sequence },
  };
}

function snowflakeWorkerId(file: string): number {
  return (
    createHash("sha256").update(file).digest().readUInt16BE(0) & MAX_WORKER_ID
  );
}

export class MessageQueue {
  private data: QueueFile = { nextOrder: 1, items: [] };
  private readonly operations = new SerialExecutor();
  private readonly workerId: number;

  constructor(
    private readonly file: string,
    private readonly onChange: (event: QueueEvent) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.workerId = snowflakeWorkerId(file);
  }

  async load(): Promise<void> {
    const raw = await readText(this.file);
    if (!raw) return;
    const parsed = JSON.parse(raw) as QueueFile;
    if (
      !Number.isSafeInteger(parsed.nextOrder) ||
      !Array.isArray(parsed.items) ||
      (parsed.snowflake !== undefined &&
        (!Number.isSafeInteger(parsed.snowflake.timestamp) ||
          !Number.isInteger(parsed.snowflake.sequence) ||
          parsed.snowflake.sequence < 0 ||
          parsed.snowflake.sequence > MAX_SEQUENCE))
    )
      throw new IntegralError(`invalid queue file: ${this.file}`);

    this.data = parsed;
    for (const item of this.data.items)
      if (item.status === "in-flight" || item.status === "steering")
        item.status = "queued";

    await this.persist();
  }

  private async persist(): Promise<void> {
    await atomicWrite(this.file, `${JSON.stringify(this.data)}\n`);
  }

  snapshot(): QueuedMessage[] {
    return this.data.items
      .map((item) => ({ ...item }))
      .sort((a, b) => a.order - b.order);
  }

  async enqueue(text: string, origin?: MessageOrigin): Promise<QueuedMessage> {
    return this.operations.run(async () => {
      if (!text.trim()) throw new IntegralError("message must not be empty");

      if (origin) {
        const existing = this.data.items.find(
          (item) =>
            item.origin?.provider === origin.provider &&
            item.origin.externalId === origin.externalId,
        );
        if (existing) return structuredClone(existing);
      }

      const priorSnowflake = this.data.snowflake
          ? { ...this.data.snowflake }
          : undefined,
        generated = createSnowflakeId(
          this.now(),
          this.workerId,
          priorSnowflake,
        );
      this.data.snowflake = generated.state;

      const item: QueuedMessage = {
        id: generated.id,
        text,
        order: this.data.nextOrder++,
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString(),
        ...(origin ? { origin: structuredClone(origin) } : {}),
      };

      this.data.items.push(item);
      try {
        await this.persist();
      } catch (error) {
        this.data.items.pop();
        this.data.nextOrder--;
        if (priorSnowflake) this.data.snowflake = priorSnowflake;
        else delete this.data.snowflake;
        throw error;
      }

      this.onChange({ type: "queued", message: { ...item } });
      return { ...item };
    });
  }

  async edit(id: string, text: string): Promise<QueuedMessage> {
    return this.operations.run(async () => {
      if (!text.trim()) throw new IntegralError("message must not be empty");

      const item = this.find(id);
      if (item.status !== "queued")
        throw new IntegralError(`message ${id} is in flight`);

      const previous = item.text;
      item.text = text;
      try {
        await this.persist();
      } catch (error) {
        item.text = previous;
        throw error;
      }

      this.onChange({ type: "edited", message: { ...item } });
      return { ...item };
    });
  }

  async delete(id: string): Promise<void> {
    return this.operations.run(async () => {
      const item = this.find(id);
      if (item.status !== "queued")
        throw new IntegralError(`message ${id} is in flight`);

      const index = this.data.items.indexOf(item);
      this.data.items.splice(index, 1);
      try {
        await this.persist();
      } catch (error) {
        this.data.items.splice(index, 0, item);
        throw error;
      }

      this.onChange({ type: "deleted", messageId: id });
    });
  }

  async claim(): Promise<QueuedMessage | undefined> {
    return this.operations.run(async () => {
      if (this.data.items.some((item) => item.status === "in-flight"))
        return undefined;

      const item = this.data.items
        .filter((m) => m.status === "queued")
        .sort((a, b) => a.order - b.order)[0];
      if (!item) return undefined;

      item.status = "in-flight";
      item.attempts++;
      try {
        await this.persist();
      } catch (error) {
        item.status = "queued";
        item.attempts--;
        throw error;
      }

      this.onChange({ type: "claimed", message: { ...item } });
      return { ...item };
    });
  }

  async complete(id: string): Promise<void> {
    return this.operations.run(async () => {
      const item = this.find(id);
      if (item.status !== "in-flight" && item.status !== "steering")
        throw new IntegralError(`message ${id} is not in flight`);

      const index = this.data.items.indexOf(item);
      this.data.items.splice(index, 1);
      try {
        await this.persist();
      } catch (error) {
        this.data.items.splice(index, 0, item);
        throw error;
      }

      this.onChange({ type: "completed", messageId: id });
    });
  }

  async markSteering(id: string): Promise<void> {
    return this.operations.run(async () => {
      const item = this.find(id);
      if (item.status !== "queued")
        throw new IntegralError(`message ${id} is not queued`);

      item.status = "steering";
      item.attempts++;
      try {
        await this.persist();
      } catch (error) {
        item.status = "queued";
        item.attempts--;
        throw error;
      }

      this.onChange({ type: "steered", message: { ...item } });
    });
  }

  async release(id: string, reason?: string): Promise<void> {
    return this.operations.run(async () => {
      const item = this.find(id),
        previous = item.status;

      item.status = "queued";
      try {
        await this.persist();
      } catch (error) {
        item.status = previous;
        throw error;
      }

      this.onChange(
        reason === undefined
          ? { type: "released", message: { ...item } }
          : { type: "released", message: { ...item }, reason },
      );
    });
  }

  private find(id: string): QueuedMessage {
    const item = this.data.items.find((m) => m.id === id);
    if (!item) throw new IntegralError(`message ${id} is not queued`);
    return item;
  }
}

export type QueueEvent =
  | {
      type: "queued" | "edited" | "claimed" | "steered";
      message: QueuedMessage;
    }
  | { type: "released"; message: QueuedMessage; reason?: string }
  | { type: "deleted" | "completed"; messageId: string };

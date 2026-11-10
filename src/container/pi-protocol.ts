export type PiProtocolEvent = Record<string, unknown>;

export type PiProtocolResult =
  | { type: "text"; text: string }
  | { type: "complete" }
  | { type: "rejected"; error: string }
  | { type: "ignored" };

export function interpretPiProtocol(line: string): PiProtocolResult {
  let event: PiProtocolEvent;
  try {
    event = JSON.parse(line) as PiProtocolEvent;
  } catch {
    return { type: "ignored" };
  }
  return interpretPiEvent(event);
}

export function interpretPiEvent(event: PiProtocolEvent): PiProtocolResult {
  if (
    event.type === "response" &&
    event.command === "prompt" &&
    event.success === false
  )
    return {
      type: "rejected",
      error:
        typeof event.error === "string"
          ? `Pi rejected prompt: ${event.error}`
          : "Pi rejected prompt",
    };
  if (event.type === "message_update") {
    const delta = event.assistantMessageEvent as
      Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.delta === "string")
      return { type: "text", text: delta.delta };
  }
  if (
    event.type === "agent_end" &&
    event.willRetry !== true &&
    Array.isArray(event.messages)
  ) {
    const messages = event.messages as unknown[];
    const failed = messages.findLast(
      (message): message is Record<string, unknown> =>
        isRecord(message) &&
        message.role === "assistant" &&
        message.stopReason === "error",
    );
    if (failed && typeof failed.errorMessage === "string")
      return {
        type: "rejected",
        error: `Pi provider failed: ${failed.errorMessage}`,
      };
  }
  return event.type === "agent_end" && event.willRetry !== true
    ? { type: "complete" }
    : { type: "ignored" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

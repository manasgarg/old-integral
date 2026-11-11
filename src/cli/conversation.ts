import { IntegralError } from "../platform/errors.ts";
import {
  componentEndpoint,
  verifiedFetch,
} from "../platform/internal-http-client.ts";
import type { ModelSelection } from "../domain/model-selection.ts";
import type { IntegralPaths } from "../platform/deployment-paths.ts";
import { resolvePaths } from "../platform/deployment-paths.ts";
import { fetchJson } from "./coordinator-client.ts";

const STATUS_HELP = `Usage: integral status [--json]

Show the shared conversation and component status. In integral talk, use /status.
`;

export interface ConversationCommandDependencies {
  resolvePaths(): IntegralPaths;
  componentEndpoint: typeof componentEndpoint;
  verifiedFetch: typeof verifiedFetch;
  fetch: typeof globalThis.fetch;
  writeOutput(text: string): void;
}

export interface ConversationOperationDependencies {
  fetch: typeof globalThis.fetch;
  writeOutput(text: string): void;
}

const productionDependencies: ConversationCommandDependencies = {
  resolvePaths,
  componentEndpoint,
  verifiedFetch,
  fetch: globalThis.fetch,
  writeOutput: (text) => process.stdout.write(text),
};

export async function healthyCoordinator(
  dependencies: Pick<
    ConversationCommandDependencies,
    "resolvePaths" | "componentEndpoint" | "verifiedFetch"
  >,
): Promise<string> {
  const paths = dependencies.resolvePaths();

  try {
    const endpoint = await dependencies.componentEndpoint(paths, "coordinator");
    await dependencies.verifiedFetch(paths, "coordinator", "/integral/health");
    return endpoint;
  } catch {
    throw new IntegralError(
      "coordinator is not reachable; start it with integral server start",
    );
  }
}

interface ConversationStatus {
  gateway: string;
  runner: string;
  scheduler: string;
  container: string;
  session: string | null;
  selection: ModelSelection | null;
  queueDepth: number;
  inFlight: string | null;
  attached: number;
  taskQueueDepth: number;
  taskInFlight: string | null;
}

function renderStatus(status: ConversationStatus): string {
  const selection = status.selection
    ? `${status.selection.connection} (${status.selection.provider}) / ${status.selection.model}`
    : "selection required";

  return [
    `gateway: ${status.gateway}`,
    `runner: ${status.runner}`,
    `scheduler: ${status.scheduler}`,
    `container: ${status.container}`,
    `model: ${selection}`,
    `session: ${status.session ?? "none"}`,
    `queue: ${status.queueDepth} queued, in-flight ${status.inFlight ?? "none"}`,
    `terminals: ${status.attached} attached`,
    `tasks: ${status.taskQueueDepth} queued, in-flight ${status.taskInFlight ?? "none"}`,
    "",
  ].join("\n");
}

export async function runStatusCommand(
  args: string[],
  endpoint: string,
  dependencies: ConversationOperationDependencies,
): Promise<number> {
  const status = (await fetchJson(
    new URL("/integral/status", endpoint),
    dependencies.fetch,
  )) as ConversationStatus;

  dependencies.writeOutput(
    args.includes("--json")
      ? `${JSON.stringify(status, null, 2)}\n`
      : renderStatus(status),
  );
  return 0;
}

export async function statusCommand(
  args: string[],
  overrides: Partial<ConversationCommandDependencies> = {},
): Promise<number> {
  const dependencies = { ...productionDependencies, ...overrides };

  if (args.includes("--help") || args.includes("-h")) {
    dependencies.writeOutput(STATUS_HELP);
    return 0;
  }

  return runStatusCommand(
    args,
    await healthyCoordinator(dependencies),
    dependencies,
  );
}

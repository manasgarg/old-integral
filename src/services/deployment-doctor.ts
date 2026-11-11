import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { messageOf } from "../platform/errors.ts";
import { pathsFor, type IntegralPaths } from "../platform/deployment-paths.ts";
import { loadConfig } from "../stores/config.ts";
import { loadConnections } from "../stores/connection-store.ts";
import {
  ConversationStore,
  ModelSelectionStore,
} from "../stores/conversation-store.ts";
import {
  CURRENT_DEPLOYMENT_FORMAT,
  readDeploymentFormat,
} from "../stores/deployment-format.ts";
import { MessageQueue } from "../stores/message-queue.ts";
import { OccurrenceStore } from "../stores/occurrence-store.ts";
import { listResourceRecords } from "../stores/resource-store.ts";
import { ScheduleStore } from "../stores/schedule-store.ts";
import { TaskQueue } from "../stores/task-queue.ts";
import { DiscordIngressStore } from "../integrations/discord.ts";

/** One durable store doctor reads, by the name it reports. */
export interface DeploymentStoreCheck {
  store: string;
  check: (paths: IntegralPaths) => Promise<void>;
}

export interface DeploymentDoctorFinding {
  store: string;
  reason: string;
}

export interface DeploymentDoctorReport {
  /** Undefined when the deployment has no data yet. */
  deploymentFormat: number | undefined;
  currentFormat: number;
  checkedStores: string[];
  findings: DeploymentDoctorFinding[];
  healthy: boolean;
}

/**
 * Parts of `data/` that hold user content, secrets, or reinstallable
 * downloads rather than records integral's stores parse. Doctor does not copy
 * them into its scratch deployment.
 */
const UNCHECKED_DATA = new Set([
  "pi-runtime",
  "runs",
  "repositories",
  "repository-recovery",
  "stores",
  "store-snapshots",
  "credentials",
  "ca",
]);

const REASON_LIMIT = 300;

// Parse errors quote the start of the bad input, which may hold a secret.
// Doctor reports where a store failed, never what the store contains.
function boundedReason(error: unknown): string {
  const reason = messageOf(error)
    .replace(/"(?:[^"\\]|\\.)*"(?= is not valid JSON)/g, "(content omitted)")
    .replace(/\s+/g, " ")
    .trim();
  return reason.length > REASON_LIMIT
    ? `${reason.slice(0, REASON_LIMIT)}…`
    : reason;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function channelChecks(
  paths: IntegralPaths,
): Promise<DeploymentStoreCheck[]> {
  let channels: string[];
  try {
    channels = (await readdir(paths.channels, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  return channels.flatMap((channel) => {
    const directory = (scratch: IntegralPaths) =>
      join(scratch.channels, channel);
    return [
      {
        store: `channel ${channel} queue`,
        check: async (scratch) =>
          new MessageQueue(join(directory(scratch), "queue.json")).load(),
      },
      {
        store: `channel ${channel} conversation`,
        check: async (scratch) =>
          new ConversationStore(
            join(directory(scratch), "conversation.jsonl"),
          ).load(),
      },
      {
        store: `channel ${channel} model selection`,
        check: async (scratch) =>
          new ModelSelectionStore(
            join(directory(scratch), "model.json"),
          ).load(),
      },
      {
        store: `channel ${channel} Discord ingress`,
        check: async (scratch) =>
          new DiscordIngressStore(
            join(directory(scratch), "ingress.json"),
          ).load(),
      },
    ];
  });
}

/** Every durable store this release reads, in the order doctor reports them. */
export async function deploymentStoreChecks(
  paths: IntegralPaths,
): Promise<DeploymentStoreCheck[]> {
  return [
    { store: "configuration", check: async (p) => void (await loadConfig(p)) },
    {
      store: "connections",
      check: async (p) => {
        const { errors } = await loadConnections(p);
        if (errors.length) throw new Error(errors.join("; "));
      },
    },
    {
      store: "conversation",
      check: async (p) => new ConversationStore(p.conversation).load(),
    },
    {
      store: "model selection",
      check: async (p) => new ModelSelectionStore(p.modelSelection).load(),
    },
    {
      store: "message queue",
      check: async (p) => new MessageQueue(p.queue).load(),
    },
    { store: "task queue", check: async (p) => new TaskQueue(p).load() },
    { store: "schedules", check: async (p) => new ScheduleStore(p).load() },
    {
      store: "schedule occurrences",
      check: async (p) => new OccurrenceStore(p).load(),
    },
    {
      store: "resources",
      check: async (p) => void (await listResourceRecords(p)),
    },
    ...(await channelChecks(paths)),
  ];
}

/**
 * Copy the parts of a deployment that stores parse into a scratch home.
 * Several store loaders repair or initialize files as they load, so doctor
 * runs them on this copy and never on the deployment itself.
 */
async function copyCheckedParts(
  paths: IntegralPaths,
  scratch: IntegralPaths,
): Promise<void> {
  if (await exists(paths.config))
    await cp(paths.config, scratch.config, { recursive: true });

  await cp(paths.data, scratch.data, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const part = relative(paths.data, source).split(sep)[0];
      return !part || !UNCHECKED_DATA.has(part);
    },
  });
}

/** Read every durable store with this release's code. Never changes the deployment. */
export async function doctorDeployment(
  paths: IntegralPaths,
  checks?: DeploymentStoreCheck[],
): Promise<DeploymentDoctorReport> {
  const found = await readDeploymentFormat(paths),
    deploymentFormat = found.kind === "new" ? undefined : found.format;

  if (deploymentFormat !== CURRENT_DEPLOYMENT_FORMAT)
    return {
      deploymentFormat,
      currentFormat: CURRENT_DEPLOYMENT_FORMAT,
      checkedStores: [],
      findings: [],
      healthy: false,
    };

  const scratchRoot = await mkdtemp(join(tmpdir(), "integral-doctor-"));
  try {
    const scratch = pathsFor(scratchRoot);
    await copyCheckedParts(paths, scratch);

    const findings: DeploymentDoctorFinding[] = [],
      selected = checks ?? (await deploymentStoreChecks(paths));
    for (const { store, check } of selected)
      try {
        await check(scratch);
      } catch (error) {
        findings.push({ store, reason: boundedReason(error) });
      }

    return {
      deploymentFormat,
      currentFormat: CURRENT_DEPLOYMENT_FORMAT,
      checkedStores: selected.map(({ store }) => store),
      findings,
      healthy: findings.length === 0,
    };
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

export function renderDoctorReport(report: DeploymentDoctorReport): string {
  const lines = [
    `deployment format: ${report.deploymentFormat ?? "none (no deployment data)"}`,
    `current format: ${report.currentFormat}`,
  ];

  if (report.deploymentFormat !== report.currentFormat) {
    lines.push(
      report.deploymentFormat === undefined
        ? "there is no deployment here to check"
        : report.deploymentFormat < report.currentFormat
          ? "the deployment needs `integral migrate` before its stores can be checked"
          : "the deployment was written by a newer release; its stores were not checked",
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(`checked ${report.checkedStores.length} stores`);
  for (const finding of report.findings)
    lines.push(`problem: ${finding.store}: ${finding.reason}`);
  lines.push(
    report.healthy ? "deployment is healthy" : "deployment has problems",
  );
  return `${lines.join("\n")}\n`;
}

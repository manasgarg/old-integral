import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IntegralPaths } from "../platform/deployment-paths.ts";
import { atomicWrite, readText } from "../platform/files.ts";
import { ScheduleStore } from "./schedule-store.ts";

/**
 * One step that rewrites a deployment's files from format `from` to
 * `from + 1`. `apply` must finish correctly when it runs again after a crash
 * stopped it partway, because the format only advances once it returns.
 */
export interface DeploymentMigration {
  from: number;
  name: string;
  apply(paths: IntegralPaths): Promise<void>;
}

export const MIGRATION_ACTOR = "integral migrate";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Removes `profile` from every record in `file`'s `key` array. */
async function removeRecordProfiles(file: string, key: string): Promise<void> {
  const raw = await readText(file);
  if (!raw) return;

  const data = JSON.parse(raw) as Record<string, unknown>,
    records = data[key];
  if (!Array.isArray(records)) return;

  let changed = false;
  for (const record of records as Array<Record<string, unknown>>)
    if ("profile" in record) {
      delete record.profile;
      changed = true;
    }

  if (changed) await atomicWrite(file, `${JSON.stringify(data)}\n`);
}

/** Rewrites the JSON object in `file` with `edit`, when it exists and changes. */
async function editJsonFile(
  file: string,
  edit: (value: Record<string, unknown>) => boolean,
): Promise<void> {
  const raw = await readText(file);
  if (!raw) return;

  const value = JSON.parse(raw) as Record<string, unknown>;
  if (edit(value)) await atomicWrite(file, `${JSON.stringify(value)}\n`);
}

/** Deletes `keys` from `value`, reporting whether any were present. */
function deleteKeys(value: Record<string, unknown>, keys: string[]): boolean {
  let changed = false;
  for (const key of keys)
    if (key in value) {
      delete value[key];
      changed = true;
    }
  return changed;
}

/** Drops queued messages that continued a resolved approval. */
function dropApprovalContinuations(queue: Record<string, unknown>): boolean {
  if (!Array.isArray(queue.items)) return false;

  const items = queue.items as Array<Record<string, unknown>>,
    kept = items.filter((item) => !("approvalContinuation" in item));
  queue.items = kept;
  return kept.length !== items.length;
}

/**
 * Removes the `image` and `pull_policy` keys from the `[runner]` table of the
 * main configuration, leaving every other line as the operator wrote it.
 */
export function removeRunnerImageKeys(source: string): string {
  let table = "";
  return source
    .split("\n")
    .filter((line) => {
      const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
      if (header) table = header[1]!.trim();
      return !(
        table === "runner" && /^\s*(?:image|pull_policy)\s*=/.test(line)
      );
    })
    .join("\n");
}

/** Files and directories that only Pi image editing and approvals used. */
const IMAGE_EDITING_DATA = [
  "image-recipe.git",
  "image-audit.jsonl",
  "image-state.json",
  "active-image.json",
  "container-packages.json",
  "approvals.json",
  "approval-audit.jsonl",
  join("repository-recovery", "integral-image-recipe"),
];

export const DEPLOYMENT_MIGRATIONS: readonly DeploymentMigration[] = [
  {
    // Format 0 is every deployment created before deployment formats
    // existed. Its files already match format 1; only the format file is new,
    // and the migration runner writes that after each step.
    from: 0,
    name: "record-deployment-format",
    apply: async () => undefined,
  },
  {
    // Format 1 pinned a model and Pi runtime in every schedule, occurrence and
    // scheduled task. Format 2 runs scheduled work on the shared model
    // selection and the current managed Pi runtime instead.
    from: 1,
    name: "unpin-scheduled-runtime",
    async apply(paths) {
      if (await exists(paths.schedules)) {
        const schedules = new ScheduleStore(paths);
        await schedules.load();
        await schedules.removeLegacyPins(MIGRATION_ACTOR);
      }
      await removeRecordProfiles(paths.occurrences, "occurrences");
      await removeRecordProfiles(paths.taskQueue, "tasks");
    },
  },
  {
    // Format 2 let Pi and the operator edit and rebuild the Pi image, gated
    // by approvals, and recorded the Pi version and image in each model
    // selection. Format 3 always runs the image pinned by the release.
    from: 2,
    name: "pin-release-pi-image",
    async apply(paths) {
      const mainConfig = await readText(paths.mainConfig);
      if (mainConfig !== undefined) {
        const pinned = removeRunnerImageKeys(mainConfig);
        if (pinned !== mainConfig) await atomicWrite(paths.mainConfig, pinned);
      }

      const channels = (
        await readdir(paths.channels, { withFileTypes: true }).catch(() => [])
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(paths.channels, entry.name));

      for (const selection of [
        paths.modelSelection,
        ...channels.map((channel) => join(channel, "model.json")),
      ])
        await editJsonFile(selection, (value) =>
          deleteKeys(value, ["piVersion", "piImage"]),
        );

      for (const queue of [
        paths.queue,
        ...channels.map((channel) => join(channel, "queue.json")),
      ])
        await editJsonFile(queue, dropApprovalContinuations);

      for (const entry of await readdir(paths.resources).catch(() => []))
        if (entry.endsWith(".json"))
          await editJsonFile(join(paths.resources, entry), (value) =>
            deleteKeys(value, ["writePolicy"]),
          );

      for (const entry of IMAGE_EDITING_DATA)
        await rm(join(paths.data, entry), { recursive: true, force: true });
      await rm(join(paths.state, "image-recipe-init.lock"), { force: true });
    },
  },
];

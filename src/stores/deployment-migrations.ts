import { stat } from "node:fs/promises";
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
];

import { appendFile, stat } from "node:fs/promises";
import { atomicWrite, ensureDir, readText } from "../platform/files.ts";
import { IntegralError } from "../platform/errors.ts";
import type { IntegralPaths } from "../platform/deployment-paths.ts";

/**
 * The deployment format this release reads and writes. Raise it by one, add a
 * migration, and add a sample deployment whenever a change alters what any
 * store writes to disk.
 */
export const CURRENT_DEPLOYMENT_FORMAT = 1;

export type DeploymentFormat =
  /** `data/` does not exist yet. */
  | { kind: "new" }
  /** `data/` exists. `release` is undefined for format 0. */
  | { kind: "recorded"; format: number; release: string | undefined };

export interface DeploymentFormatRecord {
  format: number;
  release: string;
  writtenAt: string;
}

export interface MigrationAuditRecord {
  migration: string;
  fromFormat: number;
  toFormat: number;
  release: string;
  startedAt: string;
  finishedAt: string;
  result: "completed" | "failed";
  reason?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseRecord(text: string, file: string): DeploymentFormatRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IntegralError(`${file} is not valid JSON`);
  }

  const format: unknown = value && Reflect.get(value, "format"),
    release: unknown = value && Reflect.get(value, "release"),
    writtenAt: unknown = value && Reflect.get(value, "writtenAt");
  if (
    !Number.isInteger(format) ||
    (format as number) < 1 ||
    typeof release !== "string" ||
    typeof writtenAt !== "string"
  )
    throw new IntegralError(`${file} is not a valid deployment format record`);

  return { format: format as number, release, writtenAt };
}

export async function readDeploymentFormat(
  paths: IntegralPaths,
): Promise<DeploymentFormat> {
  if (!(await exists(paths.data))) return { kind: "new" };

  const text = await readText(paths.deploymentFormat);
  if (text === undefined)
    return { kind: "recorded", format: 0, release: undefined };

  const record = parseRecord(text, paths.deploymentFormat);
  return { kind: "recorded", format: record.format, release: record.release };
}

export async function writeDeploymentFormat(
  paths: IntegralPaths,
  format: number,
  release: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const record: DeploymentFormatRecord = {
    format,
    release,
    writtenAt: now().toISOString(),
  };
  await atomicWrite(
    paths.deploymentFormat,
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

export async function appendMigrationAudit(
  paths: IntegralPaths,
  record: MigrationAuditRecord,
): Promise<void> {
  await ensureDir(paths.data);
  await appendFile(paths.migrationAudit, `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}

/**
 * Make sure a command may use this deployment. A new deployment gets its
 * format file when `createWhenNew` is set; a deployment at any other format
 * is refused before anything reads or writes it.
 */
export async function requireCurrentDeploymentFormat(
  paths: IntegralPaths,
  release: string,
  createWhenNew: boolean,
): Promise<void> {
  const found = await readDeploymentFormat(paths);

  if (found.kind === "new") {
    if (createWhenNew) {
      await ensureDir(paths.data);
      await writeDeploymentFormat(paths, CURRENT_DEPLOYMENT_FORMAT, release);
    }
    return;
  }

  if (found.format < CURRENT_DEPLOYMENT_FORMAT)
    throw new IntegralError(
      `deployment format ${found.format} is older than this release's format ${CURRENT_DEPLOYMENT_FORMAT}; run \`integral migrate\` first`,
    );

  if (found.format > CURRENT_DEPLOYMENT_FORMAT) throw newerFormatError(found);
}

export function newerFormatError(found: {
  format: number;
  release: string | undefined;
}): IntegralError {
  return new IntegralError(
    `deployment format ${found.format} was written by release ${found.release ?? "unknown"} and is newer than this release's format ${CURRENT_DEPLOYMENT_FORMAT}; restore the backup taken before that upgrade or run release ${found.release ?? "unknown"} (there are no reverse migrations)`,
  );
}

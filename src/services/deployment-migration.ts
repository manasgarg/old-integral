import { COMPONENTS } from "../platform/constants.ts";
import { acquireLock } from "../platform/files.ts";
import { IntegralError, messageOf } from "../platform/errors.ts";
import type { IntegralPaths } from "../platform/deployment-paths.ts";
import { join } from "node:path";
import {
  appendMigrationAudit,
  CURRENT_DEPLOYMENT_FORMAT,
  newerFormatError,
  readDeploymentFormat,
  writeDeploymentFormat,
} from "../stores/deployment-format.ts";
import {
  DEPLOYMENT_MIGRATIONS,
  type DeploymentMigration,
} from "../stores/deployment-migrations.ts";

export interface DeploymentMigrationOptions {
  release: string;
  report(line: string): void;
  migrations?: readonly DeploymentMigration[];
  currentFormat?: number;
  now?: () => Date;
}

const REASON_LIMIT = 500;

function boundedReason(error: unknown): string {
  const reason = messageOf(error).replace(/\s+/g, " ").trim();
  return reason.length > REASON_LIMIT
    ? `${reason.slice(0, REASON_LIMIT)}…`
    : reason;
}

/**
 * Hold every component lock and the migration lock, so no component can run
 * while the deployment's files change. Refuses, naming the running
 * components, when any lock is already held.
 */
async function holdDeploymentLocks(
  paths: IntegralPaths,
): Promise<() => Promise<void>> {
  const releases: Array<() => Promise<void>> = [],
    running: string[] = [];

  const releaseAll = async () => {
    for (const release of releases.reverse()) await release();
  };

  for (const [name, path] of [
    ...COMPONENTS.map((component) => [
      component,
      join(paths.locks, `${component}.lock`),
    ]),
    ["another `integral migrate`", paths.migrationLock],
  ] as const) {
    try {
      releases.push(await acquireLock(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await releaseAll();
        throw error;
      }
      running.push(name);
    }
  }

  if (running.length) {
    await releaseAll();
    throw new IntegralError(
      `cannot migrate while integral is running for this deployment: ${running.join(", ")}; stop it first`,
    );
  }

  return releaseAll;
}

function migrationPlan(
  migrations: readonly DeploymentMigration[],
  from: number,
  to: number,
): DeploymentMigration[] {
  const plan: DeploymentMigration[] = [];

  for (let format = from; format < to; format++) {
    const step = migrations.filter((migration) => migration.from === format);
    if (step.length !== 1)
      throw new IntegralError(
        `this release has ${step.length} migrations from format ${format}; expected exactly one`,
      );
    plan.push(step[0]!);
  }

  return plan;
}

/** Move a deployment forward to the current format, one migration at a time. */
export async function migrateDeployment(
  paths: IntegralPaths,
  options: DeploymentMigrationOptions,
): Promise<void> {
  const migrations = options.migrations ?? DEPLOYMENT_MIGRATIONS,
    currentFormat = options.currentFormat ?? CURRENT_DEPLOYMENT_FORMAT,
    now = options.now ?? (() => new Date());

  // Refuse a newer format before taking locks, so a refusal leaves the
  // deployment exactly as it was.
  const unlocked = await readDeploymentFormat(paths);
  if (unlocked.kind === "recorded" && unlocked.format > currentFormat)
    throw newerFormatError(unlocked);

  const releaseLocks = await holdDeploymentLocks(paths);
  try {
    const found = await readDeploymentFormat(paths);
    if (found.kind === "new") {
      options.report(
        `no deployment data at ${paths.root}; nothing to migrate\n`,
      );
      return;
    }

    if (found.format > currentFormat)
      throw newerFormatError({ format: found.format, release: found.release });
    if (found.format === currentFormat) {
      options.report(
        `deployment is already at format ${currentFormat}; nothing to migrate\n`,
      );
      return;
    }

    for (const migration of migrationPlan(
      migrations,
      found.format,
      currentFormat,
    )) {
      const toFormat = migration.from + 1,
        startedAt = now().toISOString();
      options.report(
        `migrating format ${migration.from} → ${toFormat}: ${migration.name}\n`,
      );

      try {
        await migration.apply(paths);
        await writeDeploymentFormat(paths, toFormat, options.release, now);
      } catch (error) {
        const reason = boundedReason(error);
        await appendMigrationAudit(paths, {
          migration: migration.name,
          fromFormat: migration.from,
          toFormat,
          release: options.release,
          startedAt,
          finishedAt: now().toISOString(),
          result: "failed",
          reason,
        });
        throw new IntegralError(
          `migration ${migration.name} (format ${migration.from} → ${toFormat}) failed: ${reason}`,
        );
      }

      await appendMigrationAudit(paths, {
        migration: migration.name,
        fromFormat: migration.from,
        toFormat,
        release: options.release,
        startedAt,
        finishedAt: now().toISOString(),
        result: "completed",
      });
    }

    options.report(`deployment is now at format ${currentFormat}\n`);
  } finally {
    await releaseLocks();
  }
}

import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.ts";
import { acquireLock } from "../src/platform/files.ts";
import type { IntegralPaths } from "../src/platform/deployment-paths.ts";
import {
  CURRENT_DEPLOYMENT_FORMAT,
  readDeploymentFormat,
  type MigrationAuditRecord,
} from "../src/stores/deployment-format.ts";
import type { DeploymentMigration } from "../src/stores/deployment-migrations.ts";
import { migrateDeployment } from "../src/services/deployment-migration.ts";
import { directorySnapshot, runCli, sampleDeployment } from "./helpers.ts";

const RELEASE = "0123456789abcdef0123456789abcdef01234567";

async function auditRecords(
  paths: IntegralPaths,
): Promise<MigrationAuditRecord[]> {
  const text = await readFile(paths.migrationAudit, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MigrationAuditRecord);
}

async function recordedFormat(paths: IntegralPaths): Promise<number> {
  const found = await readDeploymentFormat(paths);
  assert.equal(found.kind, "recorded");
  return found.kind === "recorded" ? found.format : -1;
}

/* @covers UPGRADE-95CAFD74
Given the deployment format is older than the current format
	And no integral component is running for the deployment
	When the user runs `integral migrate`
		Then integral holds the deployment lock for the whole operation
			And applies each migration from the deployment format to the current format in order
			And advances `data/deployment-format.json` atomically after each migration completes
			And appends one record per migration to `data/migration-audit.jsonl` with the migration, both formats, the release, the start and end times, and the result
			And prints each migration as it runs
			And exits successfully when the deployment reaches the current format
	When the deployment format already equals the current format
		Then integral reports that there is nothing to migrate
			And exits successfully without changing any file
	When any integral component is running for the deployment
		Then integral refuses to migrate
			And names the running components
			And leaves the deployment's files unchanged
*/
test("[UPGRADE-95CAFD74] migrate applies each migration in order under the deployment locks", async (t) => {
  const paths = await sampleDeployment(t, 0),
    applied: Array<{ name: string; formatBefore: number; locked: boolean }> =
      [];

  const step = (from: number): DeploymentMigration => ({
    from,
    name: `step-${from}`,
    apply: async (p) => {
      const locks = await Promise.all(
        [join(p.locks, "coordinator.lock"), p.migrationLock].map((path) =>
          stat(path).then(
            () => true,
            () => false,
          ),
        ),
      );
      applied.push({
        name: `step-${from}`,
        formatBefore: await recordedFormat(p),
        locked: locks.every(Boolean),
      });
    },
  });

  const printed: string[] = [];
  await migrateDeployment(paths, {
    release: RELEASE,
    report: (line) => printed.push(line),
    migrations: [step(2), step(0), step(1)],
    currentFormat: 3,
  });

  assert.deepEqual(applied, [
    { name: "step-0", formatBefore: 0, locked: true },
    { name: "step-1", formatBefore: 1, locked: true },
    { name: "step-2", formatBefore: 2, locked: true },
  ]);
  assert.equal(await recordedFormat(paths), 3);
  assert.deepEqual(
    (await auditRecords(paths)).map((record) => [
      record.migration,
      record.fromFormat,
      record.toFormat,
      record.release,
      record.result,
      typeof record.startedAt,
      typeof record.finishedAt,
    ]),
    [0, 1, 2].map((from) => [
      `step-${from}`,
      from,
      from + 1,
      RELEASE,
      "completed",
      "string",
      "string",
    ]),
  );
  assert.match(
    printed.join(""),
    /format 0 → 1: step-0[\s\S]*format 2 → 3: step-2/,
  );
  await assert.rejects(stat(paths.migrationLock), { code: "ENOENT" });

  const migrated = await runCli(main, (await sampleDeployment(t, 0)).root, [
    "migrate",
  ]);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.match(migrated.stdout, /record-deployment-format/);

  const current = await sampleDeployment(t, CURRENT_DEPLOYMENT_FORMAT),
    before = await directorySnapshot(current.root),
    unchanged = await runCli(main, current.root, ["migrate"]);
  assert.equal(unchanged.code, 0);
  assert.match(unchanged.stdout, /nothing to migrate/);
  assert.deepEqual(await directorySnapshot(current.root), before);

  const running = await sampleDeployment(t, 0),
    unlock = await acquireLock(join(running.locks, "runner.lock")),
    runningBefore = await directorySnapshot(running.data);
  t.after(unlock);
  const refused = await runCli(main, running.root, ["migrate"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /cannot migrate while integral is running/);
  assert.match(refused.stderr, /runner/);
  assert.deepEqual(await directorySnapshot(running.data), runningBefore);
});

/* @covers UPGRADE-51A0EA97
Given `integral migrate` is applying a migration
	When the migration fails or the process stops before it completes
		Then the deployment format remains at the last completed migration
			And integral records the failed migration and a bounded reason in `data/migration-audit.jsonl`
			And exits unsuccessfully naming the failed migration
	When the user runs `integral migrate` again
		Then integral starts from the first migration that has not completed
			And that migration completes correctly even though it was partly applied before
*/
test("[UPGRADE-51A0EA97] a failed migration keeps the last completed format and resumes on the next run", async (t) => {
  const paths = await sampleDeployment(t, 0),
    marker = join(paths.data, "half-applied"),
    calls: string[] = [];

  let failNext = true;
  const migrations: DeploymentMigration[] = [
    {
      from: 0,
      name: "first",
      apply: async () => void calls.push("first"),
    },
    {
      from: 1,
      name: "second",
      apply: async () => {
        calls.push("second");
        const already = await readFile(marker, "utf8").catch(() => "");
        if (!already.includes("part one"))
          await writeFile(marker, "part one\n", { flag: "a" });
        if (failNext) {
          failNext = false;
          throw new Error("disk full\nwhile rewriting");
        }
        if (!already.includes("part two"))
          await writeFile(marker, "part two\n", { flag: "a" });
      },
    },
  ];

  await assert.rejects(
    migrateDeployment(paths, {
      release: RELEASE,
      report: () => undefined,
      migrations,
      currentFormat: 2,
    }),
    /migration second \(format 1 → 2\) failed: disk full while rewriting/,
  );
  assert.equal(await recordedFormat(paths), 1);
  const failed = (await auditRecords(paths)).at(-1);
  assert.equal(failed?.migration, "second");
  assert.equal(failed?.result, "failed");
  assert.equal(failed?.reason, "disk full while rewriting");

  await migrateDeployment(paths, {
    release: RELEASE,
    report: () => undefined,
    migrations,
    currentFormat: 2,
  });
  assert.deepEqual(calls, ["first", "second", "second"]);
  assert.equal(await recordedFormat(paths), 2);
  assert.equal(await readFile(marker, "utf8"), "part one\npart two\n");
});

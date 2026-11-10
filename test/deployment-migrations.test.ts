import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ScheduleDefinition } from "../src/domain/schedules.ts";
import type { IntegralPaths } from "../src/platform/deployment-paths.ts";
import { MIGRATION_ACTOR } from "../src/stores/deployment-migrations.ts";
import { ScheduleStore } from "../src/stores/schedule-store.ts";
import { CURRENT_DEPLOYMENT_FORMAT } from "../src/stores/deployment-format.ts";
import { migrateDeployment } from "../src/services/deployment-migration.ts";
import { doctorDeployment } from "../src/services/deployment-doctor.ts";
import {
  directorySnapshot,
  SAMPLE_DEPLOYMENTS,
  sampleDeployment,
} from "./helpers.ts";

const RELEASE = "0123456789abcdef0123456789abcdef01234567";
const execFileAsync = promisify(execFile);

/** The sample deployment directories missing for formats 0 to `current`. */
async function missingSampleDeployments(
  root: string,
  current: number,
): Promise<string[]> {
  const missing: string[] = [];
  for (let format = 0; format <= current; format++) {
    const directory = join(root, `format-${format}`);
    const present = await stat(join(directory, "data")).then(
      (entry) => entry.isDirectory(),
      () => false,
    );
    if (!present) missing.push(directory);
  }
  return missing;
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/* @covers UPGRADE-7FE91DD6
Given the repository contains a sample deployment for each format from 0 to the current format under `test/fixtures/deployments/format-<N>/`
	And the sample deployments contain no real credentials or personal data
	When the default test suite runs
		Then it migrates a temporary copy of each sample deployment to the current format
			And runs the `integral doctor` checks on each migrated copy
			And migrates each copy a second time to show that a finished migration changes nothing
			And fails when any migration or check fails
	When the current format has no sample deployment
		Then the default test suite fails
			And names the missing sample deployment
*/
test("[UPGRADE-7FE91DD6] every sample deployment migrates to the current format and passes doctor", async (t) => {
  assert.deepEqual(
    await missingSampleDeployments(
      SAMPLE_DEPLOYMENTS,
      CURRENT_DEPLOYMENT_FORMAT,
    ),
    [],
    "add a sample deployment for every format up to the current one",
  );

  for (const file of await filesBelow(SAMPLE_DEPLOYMENTS)) {
    assert.doesNotMatch(file, /[/\\](credentials|ca)[/\\]/, file);
    assert.doesNotMatch(
      await readFile(file, "utf8"),
      /sk-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{8,}|@[a-z0-9-]+\.(com|org|net)\b/,
      file,
    );
  }

  for (let format = 0; format <= CURRENT_DEPLOYMENT_FORMAT; format++) {
    const paths = await sampleDeployment(t, format);
    await migrateDeployment(paths, {
      release: RELEASE,
      report: () => undefined,
    });

    const report = await doctorDeployment(paths);
    assert.deepEqual(report.findings, [], `format-${format}`);
    assert.equal(report.healthy, true, `format-${format}`);

    const migrated = await directorySnapshot(paths.root);
    await migrateDeployment(paths, {
      release: RELEASE,
      report: () => undefined,
    });
    assert.deepEqual(await directorySnapshot(paths.root), migrated);
  }

  const failing = await sampleDeployment(t, 0);
  await assert.rejects(
    migrateDeployment(failing, {
      release: RELEASE,
      report: () => undefined,
      currentFormat: 1,
      migrations: [
        {
          from: 0,
          name: "broken",
          apply: async () => {
            throw new Error("broken migration");
          },
        },
      ],
    }),
    /broken migration/,
  );

  const partial = await mkdtemp(join(tmpdir(), "integral-samples-"));
  t.after(() => rm(partial, { recursive: true, force: true }));
  await mkdir(join(partial, "format-0", "data"), { recursive: true });
  assert.deepEqual(await missingSampleDeployments(partial, 1), [
    join(partial, "format-1"),
  ]);
});

const LEGACY_PIN = {
  connection: "openai-codex",
  provider: "openai-codex",
  model: "gpt-sample",
  piVersion: "0.84.1",
  piImage: `sha256:${"9".repeat(64)}`,
};

/** Commits `definition` with the pin a format-1 release wrote. */
async function commitPinnedSchedule(
  paths: IntegralPaths,
  definition: ScheduleDefinition,
): Promise<void> {
  await writeFile(
    join(paths.schedules, `${definition.id}.json`),
    `${JSON.stringify({ ...definition, profile: LEGACY_PIN }, null, 2)}\n`,
  );
  const git = (...args: string[]) =>
    execFileAsync("git", args, { cwd: paths.schedules });
  await git("add", `${definition.id}.json`);
  await git(
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    JSON.stringify({
      scheduleId: definition.id,
      revision: definition.revision,
      operation: "create",
      actor: "pi:session-1",
      timestamp: definition.updatedAt,
    }),
  );
}

/* @covers SCHEDULE-E3A1358A
Given a schedule or occurrence written by an earlier release records a model or Pi runtime
	When `integral migrate` moves the deployment to this release's format
		Then integral removes the recorded model connection, provider, model, Pi version, and Pi image
			And keeps its stable schedule ID, revision history, and occurrences
*/
test("[SCHEDULE-E3A1358A] migrating to format 2 removes the pinned model and Pi runtime from scheduled work", async (t) => {
  const paths = await sampleDeployment(t, 1),
    store = new ScheduleStore(paths);
  await store.load();
  const schedule = await store.create(
    {
      trigger: { type: "recurring", cron: "0 */6 * * *", timezone: "UTC" },
      prompt: "Sample radar pass",
    },
    "pi:session-1",
  );
  await commitPinnedSchedule(paths, schedule);

  const unpinnedOccurrence = {
      executionId: "EXECUTION-1",
      scheduleId: schedule.id,
      scheduleRevision: schedule.revision,
      triggerType: "recurring",
      scheduledFor: "2026-11-01T18:00:00.000Z",
      prompt: "Sample radar pass",
      state: "accepted",
      dispatchAttempts: 1,
      createdAt: "2026-11-01T18:00:00.000Z",
    },
    occurrence = { ...unpinnedOccurrence, profile: LEGACY_PIN };
  await writeFile(
    paths.occurrences,
    `${JSON.stringify({ occurrences: [occurrence] })}\n`,
  );
  await writeFile(
    paths.taskQueue,
    `${JSON.stringify({
      tasks: [
        {
          id: "EXECUTION-1",
          executionId: "EXECUTION-1",
          scheduleId: schedule.id,
          scheduleRevision: schedule.revision,
          triggerType: "recurring",
          scheduledFor: "2026-11-01T18:00:00.000Z",
          prompt: "Sample radar pass",
          createdAt: "2026-11-01T18:00:00.000Z",
          profile: LEGACY_PIN,
          state: "queued",
          attempts: [],
        },
      ],
      outbox: [],
    })}\n`,
  );

  // A crash after a previous run rewrote the definition but before it
  // committed leaves an uncommitted change behind.
  await writeFile(
    join(paths.schedules, `${schedule.id}.json`),
    `${JSON.stringify(schedule, null, 2)}\n`,
  );

  await migrateDeployment(paths, { release: RELEASE, report: () => undefined });

  const definition = JSON.parse(
    await readFile(join(paths.schedules, `${schedule.id}.json`), "utf8"),
  ) as Record<string, unknown>;
  assert.equal("profile" in definition, false);
  assert.equal(definition.id, schedule.id);
  assert.equal(definition.revision, schedule.revision);
  assert.equal(definition.prompt, "Sample radar pass");

  const migratedStore = new ScheduleStore(paths);
  await migratedStore.load();
  const history = await migratedStore.history(schedule.id);
  assert.deepEqual(
    history.map((entry) => [entry.operation, entry.actor]),
    [
      ["create", "pi:session-1"],
      ["create", "pi:session-1"],
      ["migrate", MIGRATION_ACTOR],
    ],
  );
  assert.equal(
    (
      await execFileAsync("git", ["status", "--porcelain"], {
        cwd: paths.schedules,
      })
    ).stdout,
    "",
  );

  const occurrences = JSON.parse(await readFile(paths.occurrences, "utf8")) as {
      occurrences: Array<Record<string, unknown>>;
    },
    tasks = JSON.parse(await readFile(paths.taskQueue, "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
  assert.deepEqual(occurrences.occurrences, [unpinnedOccurrence]);
  assert.equal(tasks.tasks.length, 1);
  assert.equal("profile" in tasks.tasks[0]!, false);
  assert.equal(tasks.tasks[0]!.prompt, "Sample radar pass");

  const migrated = await directorySnapshot(paths.root);
  await migrateDeployment(paths, { release: RELEASE, report: () => undefined });
  assert.deepEqual(await directorySnapshot(paths.root), migrated);
  assert.deepEqual((await doctorDeployment(paths)).findings, []);
});

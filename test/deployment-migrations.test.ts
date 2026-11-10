import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CURRENT_DEPLOYMENT_FORMAT } from "../src/stores/deployment-format.ts";
import { migrateDeployment } from "../src/services/deployment-migration.ts";
import { doctorDeployment } from "../src/services/deployment-doctor.ts";
import {
  directorySnapshot,
  SAMPLE_DEPLOYMENTS,
  sampleDeployment,
} from "./helpers.ts";

const RELEASE = "0123456789abcdef0123456789abcdef01234567";

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

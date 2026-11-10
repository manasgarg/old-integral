import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.ts";
import { pathsFor } from "../src/platform/deployment-paths.ts";
import {
  CURRENT_DEPLOYMENT_FORMAT,
  readDeploymentFormat,
  writeDeploymentFormat,
} from "../src/stores/deployment-format.ts";
import { directorySnapshot, runCli, sampleDeployment } from "./helpers.ts";

const NEWER_RELEASE = "abcdef0123456789abcdef0123456789abcdef01";

async function emptyHome(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), "integral-format-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return pathsFor(root);
}

/* @covers UPGRADE-13E4E25F
Given a deployment home whose `data/` directory does not exist yet
	When integral creates `data/` for a new deployment
		Then it writes `data/deployment-format.json` atomically
			And records the release's current format as the deployment format
			And records the release that wrote it
Given a deployment home whose `data/` was created before deployment formats existed
	When integral reads the deployment format
		Then it finds no `data/deployment-format.json`
			And treats the deployment format as 0
			And leaves `integral migrate` as the only command that writes the format file for that deployment
*/
test("[UPGRADE-13E4E25F] a new deployment records its format and an older one counts as format 0", async (t) => {
  const fresh = await emptyHome(t);
  assert.deepEqual(await readDeploymentFormat(fresh), { kind: "new" });

  const created = await runCli(main, fresh.root, ["connection", "ls"]);
  assert.equal(created.code, 0, created.stderr);
  const record: unknown = JSON.parse(
    await readFile(fresh.deploymentFormat, "utf8"),
  );
  assert.equal(
    Reflect.get(record as object, "format"),
    CURRENT_DEPLOYMENT_FORMAT,
  );
  assert.equal(Reflect.get(record as object, "release"), "development");
  assert.deepEqual(
    (await readdir(fresh.data)).filter((name) => name.endsWith(".tmp")),
    [],
  );

  const legacy = await sampleDeployment(t, 0);
  assert.deepEqual(await readDeploymentFormat(legacy), {
    kind: "recorded",
    format: 0,
    release: undefined,
  });

  for (const args of [["connection", "ls"], ["doctor"], ["config", "show"]])
    await runCli(main, legacy.root, args);
  await assert.rejects(stat(legacy.deploymentFormat), { code: "ENOENT" });

  const migrated = await runCli(main, legacy.root, ["migrate"]);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.deepEqual(await readDeploymentFormat(legacy), {
    kind: "recorded",
    format: CURRENT_DEPLOYMENT_FORMAT,
    release: "development",
  });
});

/* @covers UPGRADE-687E186E
Given the deployment format is older than the current format
	When the user runs any command that reads or writes deployment state other than `integral migrate` and `integral doctor`
		Then integral exits unsuccessfully before starting any component or opening any store
			And leaves the deployment's files unchanged
			And names the deployment format and the current format
			And tells the user to run `integral migrate`
	When a separately started component starts
		Then it refuses to start in the same way
*/
test("[UPGRADE-687E186E] commands and components refuse an older deployment format without touching it", async (t) => {
  const paths = await sampleDeployment(t, 0),
    before = await directorySnapshot(paths.root);

  for (const args of [
    ["connection", "ls"],
    ["status"],
    ["talk"],
    ["queue", "ls"],
    ["config", "show"],
    ["server", "start"],
  ]) {
    const result = await runCli(main, paths.root, args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, /deployment format 0/);
    assert.match(
      result.stderr,
      new RegExp(`format ${CURRENT_DEPLOYMENT_FORMAT}`),
    );
    assert.match(result.stderr, /run `integral migrate`/);
  }

  const component = await runCli(main, paths.root, [
    "server",
    "start",
    "--component",
    "gateway",
  ]);
  assert.equal(component.code, 1);
  assert.match(component.stderr, /deployment format 0.*run `integral migrate`/);

  assert.deepEqual(await directorySnapshot(paths.root), before);
  await assert.rejects(stat(paths.state), { code: "ENOENT" });
});

/* @covers UPGRADE-FB9B1FDA
Given the deployment format is newer than the current format
	When the user runs any command that reads or writes deployment state
		Then integral exits unsuccessfully before starting any component or opening any store
			And leaves the deployment's files unchanged
			And names the release that wrote the deployment format
			And explains that the deployment must be restored from the backup taken before that upgrade or run with that release
	When the user runs `integral migrate`
		Then integral refuses in the same way
			And does not offer a reverse migration
*/
test("[UPGRADE-FB9B1FDA] commands and migrate refuse a newer deployment format", async (t) => {
  const paths = await sampleDeployment(t, CURRENT_DEPLOYMENT_FORMAT);
  await writeDeploymentFormat(
    paths,
    CURRENT_DEPLOYMENT_FORMAT + 1,
    NEWER_RELEASE,
  );
  const before = await directorySnapshot(paths.root);

  for (const args of [["connection", "ls"], ["status"], ["server", "start"]]) {
    const result = await runCli(main, paths.root, args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(
      result.stderr,
      new RegExp(`written by release ${NEWER_RELEASE}`),
    );
    assert.match(result.stderr, /restore the backup taken before that upgrade/);
    assert.match(result.stderr, new RegExp(`run release ${NEWER_RELEASE}`));
  }

  const migrate = await runCli(main, paths.root, ["migrate"]);
  assert.equal(migrate.code, 1);
  assert.match(
    migrate.stderr,
    new RegExp(`written by release ${NEWER_RELEASE}`),
  );
  assert.match(migrate.stderr, /there are no reverse migrations/);

  assert.deepEqual(await directorySnapshot(paths.root), before);
  await assert.rejects(stat(paths.state), { code: "ENOENT" });
});

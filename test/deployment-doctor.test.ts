import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { main } from "../src/cli/main.ts";
import { CURRENT_DEPLOYMENT_FORMAT } from "../src/stores/deployment-format.ts";
import { doctorDeployment } from "../src/services/deployment-doctor.ts";
import { directorySnapshot, runCli, sampleDeployment } from "./helpers.ts";

const SECRET = "sk-ant-doctor-must-not-print-this";

/* @covers UPGRADE-D1B8C002
Given a deployment at any format
	When the user runs `integral doctor`
		Then integral reports the deployment format and the current format
			And, when they match, reads every durable store with the current release's own readers
			And reports each store it could not read or that failed validation, with a bounded reason and without secrets
			And never changes deployment files
			And exits successfully only when the formats match and every store is readable and valid
	When the deployment format differs from the current format
		Then integral reports the difference
			And exits unsuccessfully without reading the stores
*/
test("[UPGRADE-D1B8C002] doctor reads every store without changing the deployment", async (t) => {
  const healthy = await sampleDeployment(t, CURRENT_DEPLOYMENT_FORMAT),
    before = await directorySnapshot(healthy.root);

  const good = await runCli(main, healthy.root, ["doctor"]);
  assert.equal(good.code, 0, good.stdout);
  assert.match(
    good.stdout,
    new RegExp(`deployment format: ${CURRENT_DEPLOYMENT_FORMAT}`),
  );
  assert.match(
    good.stdout,
    new RegExp(`current format: ${CURRENT_DEPLOYMENT_FORMAT}`),
  );
  assert.match(good.stdout, /deployment is healthy/);

  const report = await doctorDeployment(healthy);
  for (const store of [
    "configuration",
    "connections",
    "conversation",
    "message queue",
    "task queue",
    "approvals",
    "schedules",
    "channel discord-100000000000000001 queue",
  ])
    assert.ok(report.checkedStores.includes(store), store);
  assert.deepEqual(await directorySnapshot(healthy.root), before);

  const broken = await sampleDeployment(t, CURRENT_DEPLOYMENT_FORMAT);
  await writeFile(broken.queue, `{"token": "${SECRET}"`);
  const brokenBefore = await directorySnapshot(broken.root),
    bad = await runCli(main, broken.root, ["doctor"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /problem: message queue: /);
  assert.match(bad.stdout, /deployment has problems/);
  assert.doesNotMatch(bad.stdout + bad.stderr, new RegExp(SECRET));
  assert.deepEqual(await directorySnapshot(broken.root), brokenBefore);

  const older = await sampleDeployment(t, 0);
  let read = false;
  const olderReport = await doctorDeployment(older, [
    { store: "spy", check: async () => void (read = true) },
  ]);
  assert.equal(read, false);
  assert.equal(olderReport.healthy, false);
  assert.equal(olderReport.deploymentFormat, 0);
  const olderCli = await runCli(main, older.root, ["doctor"]);
  assert.equal(olderCli.code, 1);
  assert.match(olderCli.stdout, /deployment format: 0/);
  assert.match(olderCli.stdout, /needs `integral migrate`/);
});

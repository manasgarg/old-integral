import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEVELOPMENT_RELEASE,
  releaseIdentity,
} from "../src/platform/release-identity.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/* @covers CLI-04301CCA
Given integral is installed
	When the user runs `integral version`
			And prints the release's commit SHA, or `development` when it was not built by deploy
*/
test("[CLI-04301CCA] a release built by deploy reports its commit and any other build reports development", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "integral-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stamp = join(root, "release.json");

  assert.equal(releaseIdentity(stamp), DEVELOPMENT_RELEASE);

  await writeFile(
    stamp,
    JSON.stringify({ commit: COMMIT, deploymentFormat: 1 }),
  );
  assert.equal(releaseIdentity(stamp), COMMIT);

  await writeFile(
    stamp,
    JSON.stringify({ commit: "not-a-commit", deploymentFormat: 1 }),
  );
  assert.equal(releaseIdentity(stamp), DEVELOPMENT_RELEASE);
});

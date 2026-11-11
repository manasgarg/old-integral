import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PI_VERSION } from "../src/platform/constants.ts";
import { packageFile } from "../src/platform/package-files.ts";
import {
  ensurePiRuntime,
  type PiPackageOperations,
} from "../src/integrations/pi/host-runtime.ts";
import { fixture } from "./helpers.ts";

function fakeOperations(calls: string[]): PiPackageOperations {
  return {
    install(prefix, selected) {
      calls.push(`install:${selected}`);

      const root = join(
        prefix,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
      );
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ version: selected }),
      );
    },
  };
}

/* @covers BOX-E1F472A1
Given the integral release pins one exact Pi version
	And integral begins Pi-specific OAuth or opens the model chooser
	When no valid runtime for the pinned version is installed
		Then integral installs exactly the pinned version under deployment runtime state
	When a valid runtime for the pinned version is already installed
		Then integral reuses the installed host runtime without querying the npm registry
			And does not reinstall Pi
*/
test("[BOX-E1F472A1] the pinned Pi version is installed once and then reused from deployment runtime state", async (t) => {
  const paths = await fixture(t),
    calls: string[] = [],
    operations = fakeOperations(calls);

  const first = await ensurePiRuntime(paths, operations),
    second = await ensurePiRuntime(paths, operations);

  assert.equal(first.version, PI_VERSION);
  assert.equal(second.version, PI_VERSION);
  assert.equal(second.packageRoot, first.packageRoot);
  assert.deepEqual(calls, [`install:${PI_VERSION}`]);
});

/* @covers BOX-E1F472A1
Given the integral release pins one exact Pi version
	When installing the pinned version fails
		Then the Pi-dependent operation exits non-zero
			And explains that the pinned Pi version could not be installed
			And does not fall back to another installed Pi version
*/
test("[BOX-E1F472A1] a failed install of the pinned Pi version fails clearly without falling back to another installed version", async (t) => {
  const paths = await fixture(t);
  await ensurePiRuntime(paths, fakeOperations([]), "1.0.0");

  await assert.rejects(
    ensurePiRuntime(paths, {
      install() {
        throw new Error("offline");
      },
    }),
    new RegExp(
      `cannot install pinned Pi ${PI_VERSION.replaceAll(".", "\\.")}: offline`,
    ),
  );
});

/* @covers BOX-E1F472A1
Given the integral release ships the Dockerfile for its Pi image
	When integral reads that Dockerfile
		Then it names its base image by an immutable digest
			And installs the pinned Pi version
			And never installs a floating `latest` Pi version
*/
test("[BOX-E1F472A1] the release's Pi Dockerfile pins its base image by digest and installs the pinned Pi version", async () => {
  const dockerfile = await readFile(packageFile("Dockerfile.pi"), "utf8"),
    from = dockerfile.match(/^FROM\s+(\S+)/gm) ?? [];

  assert.equal(from.length, 1);
  assert.match(from[0], /^FROM \S+@sha256:[0-9a-f]{64}$/);
  assert.match(dockerfile, /^ARG PI_VERSION=(.+)$/m);
  assert.equal(dockerfile.match(/^ARG PI_VERSION=(.+)$/m)?.[1], PI_VERSION);
  assert.match(PI_VERSION, /^\d+\.\d+\.\d+$/);
  assert.doesNotMatch(dockerfile, /latest/);
});

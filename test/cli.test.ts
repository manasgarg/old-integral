import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { main } from "../src/cli/main.ts";
import { PI_VERSION } from "../src/platform/constants.ts";
import { CURRENT_DEPLOYMENT_FORMAT } from "../src/stores/deployment-format.ts";

async function capture(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "",
    stderr = "";
  const out = process.stdout.write,
    err = process.stderr.write;
  process.stdout.write = (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  };
  try {
    return { code: await main(args), stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/* @covers CLI-6001FE46
Given integral is installed
	When the user runs `integral`, `integral --help`, `integral -h`, or `integral help`
		Then the command exits successfully
			And lists `server`, `talk`, `status`, `model`, `queue`, `task`, `approval`, `schedule`, `connection`, `image`, `config`, `migrate`, `doctor`, and `version`
			And describes each command in plain English
	When npm reads the package metadata
		Then the package is named `@pirogram/integral`
			And it exposes `integral` through `bin/integral.js`
*/
test("[CLI-6001FE46] top-level help lists the public command surface", async () => {
  const result = await capture(["--help"]);
  assert.equal(result.code, 0);
  for (const command of [
    "server",
    "talk",
    "status",
    "model",
    "queue",
    "task",
    "approval",
    "schedule",
    "connection",
    "image",
    "config",
    "migrate",
    "doctor",
    "version",
  ]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test("[CLI-6001FE46] package metadata names and exposes the Integral CLI", async () => {
  const packageJson: unknown = JSON.parse(
    await readFile("package.json", "utf8"),
  );
  assert.ok(packageJson && typeof packageJson === "object");
  assert.equal(Reflect.get(packageJson, "name"), "@pirogram/integral");
  const bin: unknown = Reflect.get(packageJson, "bin");
  assert.ok(bin && typeof bin === "object");
  assert.equal(Reflect.get(bin, "integral"), "bin/integral.js");
});

/* @covers CLI-04301CCA
Given integral is installed
	When the user runs `integral version`
		Then the command prints the integral version
			And prints the release's commit SHA, or `development` when it was not built by deploy
			And prints the deployment format the release supports
			And prints the Node.js version
			And prints the pinned Pi version
			And exits successfully
	When the user runs `integral --version` or `integral -V`
		Then the command prints the same implementation versions
			And exits successfully
*/
test("[CLI-04301CCA] version reports integral, Node, and Pi versions", async () => {
  const result = await capture(["version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^integral 0\.1\.0/m);
  assert.match(
    result.stdout,
    new RegExp(
      `^Node\\.js ${process.versions.node.replaceAll(".", "\\.")}$`,
      "m",
    ),
  );
  assert.ok(result.stdout.split("\n").includes(`Pi runtime: ${PI_VERSION}`));
  assert.ok(result.stdout.split("\n").includes("Release: development"));
  assert.ok(
    result.stdout
      .split("\n")
      .includes(`Deployment format: ${CURRENT_DEPLOYMENT_FORMAT}`),
  );
  assert.doesNotMatch(result.stdout, /latest/);
});

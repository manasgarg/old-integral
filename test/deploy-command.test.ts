import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { productionDeployHost } from "../scripts/deploy-command.ts";
import { defaultDeploySettings, serviceUnit } from "../scripts/deploy.ts";
import { resolveIntegralHome } from "../src/platform/deployment-paths.ts";

/* @covers UPGRADE-4BC437DA
Given a developer works in a repository worktree with the project's mise environment active
	When they run integral from the worktree without setting `INTEGRAL_HOME`
		Then integral uses `$HOME/.integral-dev` as the deployment home
			And never reads or writes the production deployment
	When they build or test in the worktree
		Then the running production release is unaffected
*/
test("[UPGRADE-4BC437DA] development uses its own deployment home and deploy never inherits it", async () => {
  const mise = parse(await readFile("mise.toml", "utf8")) as {
    env?: Record<string, unknown>;
  };
  assert.equal(mise.env?.INTEGRAL_HOME, "{{env.HOME}}/.integral-dev");

  const home = "/home/developer",
    developmentHome = String(mise.env?.INTEGRAL_HOME).replace(
      "{{env.HOME}}",
      home,
    );
  assert.equal(
    resolveIntegralHome({ HOME: home, INTEGRAL_HOME: developmentHome }),
    join(home, ".integral-dev"),
  );
  assert.notEqual(developmentHome, join(home, ".integral"));

  const worktree = "/home/developer/projects/integral/main",
    settings = defaultDeploySettings(worktree, {
      HOME: home,
      INTEGRAL_HOME: developmentHome,
    });
  assert.equal(settings.deploymentHome, join(home, ".integral"));
  assert.ok(relative(worktree, settings.releaseRoot).startsWith(".."));
  assert.doesNotMatch(serviceUnit(settings), new RegExp(worktree));

  const previous = process.env.INTEGRAL_HOME;
  process.env.INTEGRAL_HOME = developmentHome;
  try {
    const result = await productionDeployHost.run(process.execPath, [
      "-e",
      "process.stdout.write(process.env.INTEGRAL_HOME ?? 'unset')",
    ]);
    assert.equal(result.stdout, "unset");
  } finally {
    if (previous === undefined) delete process.env.INTEGRAL_HOME;
    else process.env.INTEGRAL_HOME = previous;
  }
});

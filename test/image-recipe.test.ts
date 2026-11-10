import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  activateImageProposal,
  bundledFoundationalImage,
  commitImageDockerfile,
  ensureImageRecipeRepository,
  imageRecipeDockerfile,
  imageRecipeHead,
  materializeImageRecipe,
  RETIRED_FOUNDATIONAL_IMAGES,
  stageImageProposal,
  validateImageDockerfile,
} from "../src/stores/image-recipe-store.ts";
import { buildImageRecipe } from "../src/integrations/docker/image-build.ts";
import { loadConfig } from "../src/stores/config.ts";
import { PI_VERSION } from "../src/platform/constants.ts";
import type { IntegralPaths } from "../src/platform/deployment-paths.ts";
import { fixture } from "./helpers.ts";

const run = promisify(execFile);

test("[BOX-6A91C3E7] the host-managed image recipe is projected as an isolated writable Git checkout", async (t) => {
  const paths = await fixture(t),
    head = await ensureImageRecipeRepository(paths),
    sessionHome = join(paths.state, "session-home"),
    projection = await materializeImageRecipe(paths, sessionHome, "session-1");
  assert.equal(projection.head, head);
  assert.equal(projection.checkout, join(sessionHome, "image"));
  assert.match(
    await readFile(join(projection.checkout, "Dockerfile"), "utf8"),
    new RegExp(`ARG PI_VERSION=${PI_VERSION.replaceAll(".", "\\.")}\\n`),
  );
  assert.equal(
    (
      await run("git", ["remote", "get-url", "origin"], {
        cwd: projection.checkout,
      })
    ).stdout.trim(),
    "http://integral.control/integral/control/resources/repos/integral-image-recipe/git",
  );
});

test("[REPO-7B0E2F4A] an image recipe proposal is validated and quarantined until its exact commit is activated", async (t) => {
  const paths = await fixture(t),
    base = await ensureImageRecipeRepository(paths),
    sessionHome = join(paths.state, "proposal-home"),
    { checkout } = await materializeImageRecipe(
      paths,
      sessionHome,
      "session-2",
    ),
    dockerfile = join(checkout, "Dockerfile"),
    source = await readFile(dockerfile, "utf8");
  await writeFile(
    dockerfile,
    source.replace(
      "USER 1000:1000",
      "RUN npm install --global cowsay@latest\n\nUSER 1000:1000",
    ),
  );
  await run("git", ["add", "Dockerfile"], { cwd: checkout });
  await run("git", ["commit", "-m", "Add floating package"], {
    cwd: checkout,
  });
  const proposed = (
      await run("git", ["rev-parse", "HEAD"], { cwd: checkout })
    ).stdout.trim(),
    bundle = join(paths.state, "proposal.bundle");
  await run("git", ["bundle", "create", bundle, "HEAD"], { cwd: checkout });
  const staged = await stageImageProposal(
    paths,
    await readFile(bundle),
    proposed,
  );
  assert.equal(staged.baseCommit, base);
  assert.equal(staged.proposedCommit, proposed);
  assert.deepEqual(staged.changedPaths, ["Dockerfile"]);
  assert.match(staged.diff, /cowsay@latest/);
  assert.equal(await imageRecipeHead(paths), base);

  await activateImageProposal(paths, staged);
  assert.equal(await imageRecipeHead(paths), proposed);
});

test("[CLI-5D8A1C72] direct Dockerfile commits retain the foundational boundary", async (t) => {
  const paths = await fixture(t),
    source = await imageRecipeDockerfile(paths),
    updated = source.replace(
      `ARG PI_VERSION=${PI_VERSION}`,
      "ARG PI_VERSION=0.85.0",
    ),
    committed = await commitImageDockerfile(paths, updated, "operator");
  assert.notEqual(committed.prior, committed.landed);
  assert.match(await imageRecipeDockerfile(paths), /PI_VERSION=0\.85\.0/);
  const unchanged = await commitImageDockerfile(paths, updated, "operator");
  assert.equal(unchanged.prior, unchanged.landed);
  await assert.rejects(
    commitImageDockerfile(
      paths,
      updated.replace("FROM node:26.13.0-slim", "FROM alpine:latest"),
      "operator",
    ),
    /foundational boundary/,
  );
  assert.equal(await imageRecipeHead(paths), committed.landed);
});

test("[CLI-5D8A1C72] a Dockerfile saved by an editor with a final newline is accepted", async (t) => {
  const paths = await fixture(t),
    source = await imageRecipeDockerfile(paths);
  assert.match(source, /^WORKDIR \/home\/pi$(?![\s\S])/m);
  const edited = `${source.replace(`ARG PI_VERSION=${PI_VERSION}`, "ARG PI_VERSION=0.85.0")}\n`;
  await validateImageDockerfile(edited);
  const committed = await commitImageDockerfile(paths, edited, "operator");
  assert.notEqual(committed.prior, committed.landed);
  await assert.rejects(
    validateImageDockerfile(
      edited.replace("WORKDIR /home/pi", "WORKDIR /home/pi/other"),
    ),
    /WORKDIR \/home\/pi/,
  );
});

test("[BOX-6A91C3E7] image recipe validation rejects unsafe build boundaries before approval", async (t) => {
  const paths = await fixture(t),
    source = await imageRecipeDockerfile(paths);
  await assert.rejects(validateImageDockerfile(""), /between 1 byte and 1 MB/);
  await assert.rejects(
    validateImageDockerfile(source.replace("USER 1000:1000", "USER root")),
    /retain USER/,
  );
  await assert.rejects(
    validateImageDockerfile(
      source.replace(
        "USER 1000:1000",
        "COPY secret /tmp/secret\n\nUSER 1000:1000",
      ),
    ),
    /may only copy/,
  );
  await assert.rejects(
    validateImageDockerfile(
      source.replace("WORKDIR /home/pi", "WORKDIR /workspace"),
    ),
    /retain WORKDIR/,
  );
  await assert.rejects(
    validateImageDockerfile(`${source}\nUSER root\n`),
    /effective runtime user/,
  );
  await assert.rejects(
    validateImageDockerfile(`${source}\nWORKDIR /workspace\n`),
    /effective workdir/,
  );
  await assert.rejects(
    validateImageDockerfile(`${source}\nENTRYPOINT ["sh"]\n`),
    /runtime command boundary/,
  );
});

// Commits a Dockerfile straight into the canonical recipe repository, as an
// earlier Integral release would have left it, bypassing current validation.
async function seedEarlierRecipe(
  paths: IntegralPaths,
  source: string,
): Promise<string> {
  await ensureImageRecipeRepository(paths);
  const working = join(paths.state, `earlier-recipe-${Date.now()}`);
  await run("git", ["clone", "--no-local", paths.imageRecipe, working]);
  await writeFile(join(working, "Dockerfile"), source);
  await run(
    "git",
    [
      "-c",
      "user.name=Earlier release",
      "-c",
      "user.email=earlier@integral.local",
      "commit",
      "-am",
      "Earlier image recipe",
    ],
    { cwd: working },
  );
  await run("git", ["push", "origin", "HEAD:main"], { cwd: working });
  return (
    await run("git", ["rev-parse", "HEAD"], { cwd: working })
  ).stdout.trim();
}

async function earlierRecipeSource(
  paths: IntegralPaths,
  foundation: string,
): Promise<string> {
  const current = await bundledFoundationalImage();
  return (await imageRecipeDockerfile(paths))
    .replace(`FROM ${current}`, `FROM ${foundation}`)
    .replace("USER 1000:1000", "RUN echo customized\n\nUSER 1000:1000")
    .concat("\n");
}

async function auditRecords(
  paths: IntegralPaths,
): Promise<Record<string, unknown>[]> {
  const text = await readFile(paths.imageAudit, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/* @covers BOX-62AC107F
Given Integral owns the deployment's governed Pi image-recipe repository
	And the running Integral release bundles a foundational image reference that differs from the one the active recipe uses
	When the active Dockerfile uses a foundational image reference that an earlier Integral release bundled
		And Integral next uses the image-recipe repository
		Then Integral commits a change that replaces only that foundational image reference with the current one
			And records the change as made by Integral with the prior and resulting commits, tree digest, and both foundational image references
			And does not create an approval request or build an image
			And keeps the selected image until a later approved or operator rebuild
			And gives later sessions, proposals, and rebuilds the updated recipe
*/
test("[BOX-62AC107F] a recipe on a retired foundational image moves to the current one", async (t) => {
  const paths = await fixture(t),
    current = await bundledFoundationalImage(),
    retired = RETIRED_FOUNDATIONAL_IMAGES[0]!;
  assert.ok(!RETIRED_FOUNDATIONAL_IMAGES.includes(current));
  const earlierSource = await earlierRecipeSource(paths, retired),
    earlier = await seedEarlierRecipe(paths, earlierSource),
    auditBefore = (await auditRecords(paths)).length;

  const landed = await ensureImageRecipeRepository(paths);
  assert.notEqual(landed, earlier);
  assert.equal(await imageRecipeHead(paths), landed);
  assert.equal(
    await imageRecipeDockerfile(paths),
    earlierSource.replace(`FROM ${retired}`, `FROM ${current}`).trimEnd(),
  );
  assert.equal(
    (
      await run("git", [
        "--git-dir",
        paths.imageRecipe,
        "log",
        "-1",
        "--format=%an %P",
        landed,
      ])
    ).stdout.trim(),
    `Integral ${earlier}`,
  );
  const audit = (await auditRecords(paths)).slice(auditBefore);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.action, "recipe.migrate");
  assert.equal(audit[0]!.actor, "Integral");
  assert.equal(audit[0]!.prior, earlier);
  assert.equal(audit[0]!.landed, landed);
  assert.equal(audit[0]!.priorFoundationalImageReference, retired);
  assert.equal(audit[0]!.foundationalImageReference, current);
  assert.match(String(audit[0]!.treeDigest), /^[0-9a-f]{40,64}$/);

  assert.equal(await ensureImageRecipeRepository(paths), landed);
  assert.equal((await auditRecords(paths)).length, auditBefore + 1);
  const projection = await materializeImageRecipe(
    paths,
    join(paths.state, "migrated-home"),
    "session-migrated",
  );
  assert.equal(projection.head, landed);
  assert.match(
    await readFile(join(projection.checkout, "Dockerfile"), "utf8"),
    new RegExp(`^FROM ${current.replaceAll(".", "\\.")}$`, "m"),
  );
});

/* @covers BOX-62AC107F
Given Integral owns the deployment's governed Pi image-recipe repository
	And the running Integral release bundles a foundational image reference that differs from the one the active recipe uses
	When the active Dockerfile uses a foundational image reference that no Integral release bundled
		And Integral next uses the image-recipe repository
		Then Integral leaves the recipe unchanged
			And continues to reject builds and proposals that do not retain the current foundational image reference
*/
test("[BOX-62AC107F] a recipe on an unknown foundational image is left unchanged", async (t) => {
  const paths = await fixture(t),
    source = await earlierRecipeSource(paths, "alpine:3.20"),
    earlier = await seedEarlierRecipe(paths, source),
    auditBefore = (await auditRecords(paths)).length;
  assert.equal(await ensureImageRecipeRepository(paths), earlier);
  assert.equal(await imageRecipeDockerfile(paths), source.trimEnd());
  assert.equal((await auditRecords(paths)).length, auditBefore);
  await assert.rejects(
    buildImageRecipe(paths, await loadConfig(paths, {}), earlier, "operator"),
    /foundational boundary/,
  );
});

/* @covers BOX-62AC107F
Given Integral owns the deployment's governed Pi image-recipe repository
	And the running Integral release bundles a foundational image reference that differs from the one the active recipe uses
	When an image proposal or rebuild request is bound to the recipe commit from before the move
		Then Integral rejects it without building
			And leaves the active recipe and selected image unchanged
*/
test("[BOX-62AC107F] proposals and rebuilds bound to the pre-move recipe are rejected", async (t) => {
  const paths = await fixture(t),
    earlier = await seedEarlierRecipe(
      paths,
      await earlierRecipeSource(paths, RETIRED_FOUNDATIONAL_IMAGES[0]!),
    ),
    checkout = join(paths.state, "stale-proposal");
  await run("git", ["clone", "--no-local", paths.imageRecipe, checkout]);
  await run("git", ["checkout", "--detach", earlier], { cwd: checkout });
  const dockerfile = join(checkout, "Dockerfile");
  await writeFile(
    dockerfile,
    (await readFile(dockerfile, "utf8")).replace(
      "RUN echo customized",
      "RUN echo proposed",
    ),
  );
  await run(
    "git",
    [
      "-c",
      "user.name=Pi",
      "-c",
      "user.email=pi@integral.local",
      "commit",
      "-am",
      "Propose against the pre-move recipe",
    ],
    { cwd: checkout },
  );
  const proposed = (
      await run("git", ["rev-parse", "HEAD"], { cwd: checkout })
    ).stdout.trim(),
    bundle = join(paths.state, "stale.bundle");
  await run("git", ["bundle", "create", bundle, "HEAD"], { cwd: checkout });

  await assert.rejects(
    stageImageProposal(paths, await readFile(bundle), proposed),
  );
  const landed = await imageRecipeHead(paths);
  assert.notEqual(landed, earlier);
  await assert.rejects(
    buildImageRecipe(paths, await loadConfig(paths, {}), earlier, "operator"),
    /foundational boundary/,
  );
  assert.equal(await imageRecipeHead(paths), landed);
  assert.ok(
    !(await auditRecords(paths)).some(
      (entry) => entry.action === "image.build",
    ),
  );
});

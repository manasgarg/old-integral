import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveConfig } from "../../stores/config.ts";
import {
  appendImageAudit,
  ensureImageRecipeRepository,
  imageRecipeDockerfile,
  validateImageRecipeCommit,
  type ImageBuildAuditContext,
  type ImageBuildResult,
} from "../../stores/image-recipe-store.ts";
import {
  DEFAULT_PI_IMAGE,
  INTEGRAL_VERSION,
} from "../../platform/constants.ts";
import type { IntegralPaths } from "../../platform/deployment-paths.ts";
import { IntegralError } from "../../platform/errors.ts";
import { packageFile } from "../../platform/package-files.ts";

function modelBridge(): string {
  return packageFile("bin/integral-pi-models.mjs");
}

export async function buildImageRecipe(
  paths: IntegralPaths,
  config: EffectiveConfig,
  commit: string,
  actor: string,
  audit: ImageBuildAuditContext = {},
): Promise<ImageBuildResult> {
  if (config.runner.image !== DEFAULT_PI_IMAGE)
    throw new IntegralError(
      "image recipes can only build Integral's managed Pi image",
      409,
    );

  await ensureImageRecipeRepository(paths);
  const validated = await validateImageRecipeCommit(paths.imageRecipe, commit),
    foundationalImageReference =
      validated.dockerfile.match(/^FROM\s+(\S+)/m)?.[1];

  const context = await mkdtemp(join(tmpdir(), "integral-image-build-")),
    tag = `integral-pi:${INTEGRAL_VERSION}-image-${commit.slice(0, 12)}`;

  try {
    const dockerfile = await imageRecipeDockerfile(paths, commit);
    await writeFile(join(context, "Dockerfile"), `${dockerfile.trimEnd()}\n`);
    await mkdir(join(context, "bin"), { recursive: true });
    await copyFile(
      modelBridge(),
      join(context, "bin", "integral-pi-models.mjs"),
    );

    const built = spawnSync(
      "docker",
      [
        "build",
        "--pull",
        "--no-cache",
        "--memory",
        `${config.runner.memoryMb}m`,
        "--label",
        `org.pirogram.integral.recipe=${commit}`,
        "--tag",
        tag,
        "--file",
        join(context, "Dockerfile"),
        context,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 1_800_000 },
    );
    if (built.status !== 0)
      throw new IntegralError(
        `image recipe build failed: ${built.stderr.trim()}`,
      );

    const inspected = spawnSync(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", tag],
      { encoding: "utf8" },
    );
    if (inspected.status !== 0 || !inspected.stdout.trim())
      throw new IntegralError("built image identity is unavailable");

    const version = spawnSync(
        "docker",
        ["run", "--rm", "--network", "none", tag, "pi", "--version"],
        {
          encoding: "utf8",
        },
      ),
      inventory = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          tag,
          "dpkg-query",
          "-W",
          "-f=${Package}=${Version}\\n",
        ],
        { encoding: "utf8" },
      );
    if (version.status !== 0 || inventory.status !== 0)
      throw new IntegralError("built image package inventory is unavailable");

    const piVersion = version.stdout
      .trim()
      .match(/\d+\.\d+\.\d+(?:[-+][^\s]+)?/)?.[0];
    if (!piVersion) throw new IntegralError("built Pi version is unavailable");

    const result = {
      recipeCommit: commit,
      image: inspected.stdout.trim(),
      piVersion,
      packages: inventory.stdout.trim().split("\n").filter(Boolean).sort(),
    };

    await appendImageAudit(paths, {
      action: "image.build",
      actor,
      ...audit,
      foundationalImageReference,
      treeDigest: validated.treeDigest,
      ...result,
    });

    return result;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

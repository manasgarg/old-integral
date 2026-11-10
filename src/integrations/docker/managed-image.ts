import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { EffectiveConfig } from "../../stores/config.ts";
import { IntegralError } from "../../platform/errors.ts";
import {
  DEFAULT_PI_IMAGE,
  INTEGRAL_VERSION,
} from "../../platform/constants.ts";
import { DEFAULT_CONTAINER_PACKAGES } from "../../stores/container-package-store.ts";
import { packageFile } from "../../platform/package-files.ts";

function inspectImage(image: string): string | undefined {
  const result = spawnSync(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { encoding: "utf8" },
  );

  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
}

export function managedPiImage(
  version: string,
  recipeInputs?: readonly Uint8Array[],
  systemPackages: readonly string[] = DEFAULT_CONTAINER_PACKAGES,
): string {
  const dockerfile = packageFile("Dockerfile.pi"),
    modelBridge = packageFile("bin/integral-pi-models.mjs"),
    inputs = recipeInputs ?? [
      readFileSync(dockerfile),
      readFileSync(modelBridge),
    ],
    hash = createHash("sha256");

  for (const input of inputs)
    hash.update(String(input.byteLength)).update("\0").update(input);
  hash.update("packages\0").update(JSON.stringify([...systemPackages].sort()));

  const recipe = hash.digest("hex").slice(0, 12);
  return `integral-pi:${INTEGRAL_VERSION}-recipe-${recipe}-pi-${version.replace(/[^0-9A-Za-z_.-]/g, "-")}`;
}

export function ensureManagedPiImage(
  config: EffectiveConfig,
  piVersion: string,
  options: {
    systemPackages?: readonly string[];
    rebuild?: boolean;
    expectedImage?: string;
  } = {},
): string {
  if (options.expectedImage) {
    const selected = inspectImage(options.expectedImage);
    if (selected) return selected;
  }

  const systemPackages = [
    ...(options.systemPackages ?? DEFAULT_CONTAINER_PACKAGES),
  ].sort();
  const requested =
    config.runner.image === DEFAULT_PI_IMAGE
      ? managedPiImage(piVersion, undefined, systemPackages)
      : config.runner.image;

  const existing = inspectImage(requested);
  if (config.runner.pullPolicy === "never") {
    if (!existing)
      throw new IntegralError(
        `container image is unavailable and pull_policy is never: ${requested}`,
      );
    return existing;
  }

  if (
    config.runner.pullPolicy === "if-not-present" &&
    existing &&
    !options.rebuild
  )
    return existing;

  if (config.runner.image === DEFAULT_PI_IMAGE) {
    const dockerfile = packageFile("Dockerfile.pi");
    const root = packageFile(".");

    const result = spawnSync(
      "docker",
      [
        "build",
        "--pull",
        ...(options.rebuild ? ["--no-cache"] : []),
        "--build-arg",
        `PI_VERSION=${piVersion}`,
        "--build-arg",
        `SYSTEM_PACKAGES=${systemPackages.join(" ")}`,
        "--tag",
        requested,
        "--file",
        dockerfile,
        root,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0)
      throw new IntegralError(
        `cannot build Pi ${piVersion} image: ${result.stderr.trim()}`,
      );

    const identity = inspectImage(requested);
    if (!identity)
      throw new IntegralError(`cannot resolve Pi ${piVersion} image identity`);
    return identity;
  }

  const result = spawnSync("docker", ["pull", requested], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new IntegralError(
      `cannot pull Pi image ${requested}: ${result.stderr.trim()}`,
    );

  const identity = inspectImage(requested);
  if (!identity)
    throw new IntegralError(`cannot resolve Pi image identity: ${requested}`);
  return identity;
}

export async function discoverPiModels(
  image: string,
  providers: readonly string[],
): Promise<Array<{ provider: string; model: string }>> {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      image,
      "integral-pi-models",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new IntegralError(
      `cannot discover models from Pi image: ${result.stderr.trim() || "container failed; the image must provide integral-pi-models"}`,
    );

  return parsePiModelList(result.stdout, providers);
}

export function parsePiModelList(
  output: string,
  providers: readonly string[],
): Array<{ provider: string; model: string }> {
  const allowed = new Set(providers);

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IntegralError("Pi image returned an invalid model catalog");
  }

  if (!Array.isArray(parsed))
    throw new IntegralError("Pi image returned an invalid model catalog");
  return (parsed as unknown[]).filter(
    (entry: unknown): entry is { provider: string; model: string } =>
      typeof entry === "object" &&
      entry !== null &&
      "provider" in entry &&
      typeof entry.provider === "string" &&
      allowed.has(entry.provider) &&
      "model" in entry &&
      typeof entry.model === "string" &&
      Boolean(entry.model),
  );
}

export function discoverPiVersion(image: string): string {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      image,
      "pi",
      "--version",
    ],
    { encoding: "utf8" },
  );

  const version = result.stdout.trim();
  if (result.status !== 0 || !version)
    throw new IntegralError(
      `cannot identify Pi image version: ${result.stderr.trim() || "container failed"}`,
    );
  return version;
}

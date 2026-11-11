import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { IntegralError } from "../../platform/errors.ts";
import { INTEGRAL_VERSION, PI_VERSION } from "../../platform/constants.ts";
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

/**
 * The local tag of the Pi image this release runs. It names the Integral
 * version, a digest of the release's image inputs and the pinned Pi version,
 * so a different release never reuses another release's image.
 */
export function releasePiImageTag(
  imageInputs: readonly Uint8Array[] = [
    readFileSync(packageFile("Dockerfile.pi")),
    readFileSync(packageFile("bin/integral-pi-models.mjs")),
  ],
): string {
  const hash = createHash("sha256");

  for (const input of imageInputs)
    hash.update(String(input.byteLength)).update("\0").update(input);

  const inputs = hash.digest("hex").slice(0, 12);
  return `integral-pi:${INTEGRAL_VERSION}-${inputs}-pi-${PI_VERSION.replace(/[^0-9A-Za-z_.-]/g, "-")}`;
}

/**
 * Returns the immutable identity of the release's Pi image, building it from
 * the release's own `Dockerfile.pi` when it is not present locally.
 */
export function ensureReleasePiImage(): string {
  const tag = releasePiImageTag(),
    existing = inspectImage(tag);
  if (existing) return existing;

  const result = spawnSync(
    "docker",
    [
      "build",
      "--pull",
      "--tag",
      tag,
      "--file",
      packageFile("Dockerfile.pi"),
      packageFile("."),
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new IntegralError(
      `cannot build the Pi ${PI_VERSION} image: ${result.stderr.trim()}`,
    );

  const identity = inspectImage(tag);
  if (!identity)
    throw new IntegralError(
      `cannot resolve the Pi ${PI_VERSION} image identity`,
    );
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

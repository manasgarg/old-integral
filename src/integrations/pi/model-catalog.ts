import type { EffectiveConfig } from "../../stores/config.ts";
import {
  discoverPiModels,
  discoverPiVersion,
  ensureManagedPiImage,
} from "../docker/managed-image.ts";
import { DEFAULT_PI_IMAGE } from "../../platform/constants.ts";
import { listConnections } from "../../stores/connection-store.ts";
import type { IntegralPaths } from "../../platform/deployment-paths.ts";
import { ensurePiRuntime, type PiRuntimeResolution } from "./host-runtime.ts";
import { loadContainerPackageState } from "../../stores/container-package-store.ts";
import { readText } from "../../platform/files.ts";
import type { ImageBuildResult } from "../../stores/image-recipe-store.ts";
import { IntegralError } from "../../platform/errors.ts";
import type { ModelChoice } from "../../domain/model-selection.ts";

export interface ModelCatalog {
  choices: ModelChoice[];
  piVersion?: string;
  piImage?: string;
}

export type ModelCatalogProgress = (
  stage: string,
  message: string,
  context?: Record<string, unknown>,
) => void;

export interface ModelCatalogDependencies {
  ensureRuntime(paths: IntegralPaths): Promise<PiRuntimeResolution>;
  ensureImage(
    config: EffectiveConfig,
    piVersion: string,
    options?: {
      systemPackages?: readonly string[];
      rebuild?: boolean;
      expectedImage?: string;
    },
  ): string | Promise<string>;
  discoverModels(
    image: string,
    providers: readonly string[],
  ): Promise<Array<{ provider: string; model: string }>>;
  discoverVersion(image: string): string | Promise<string>;
}

const productionDependencies: ModelCatalogDependencies = {
  ensureRuntime: ensurePiRuntime,
  ensureImage: ensureManagedPiImage,
  discoverModels: discoverPiModels,
  discoverVersion: discoverPiVersion,
};

export async function listModelChoices(
  paths: IntegralPaths,
  config: EffectiveConfig,
  overrides: Partial<ModelCatalogDependencies> = {},
  progress?: ModelCatalogProgress,
): Promise<ModelCatalog> {
  const connections = (await listConnections(paths))
    .filter(
      (connection) =>
        connection.kind === "model" && connection.state === "active",
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!connections.length) return { choices: [] };

  const dependencies = { ...productionDependencies, ...overrides };
  progress?.("runtime.resolve", "checking and preparing the Pi runtime");
  const runtime = await dependencies.ensureRuntime(paths);
  progress?.("runtime.ready", "Pi runtime is ready", {
    pi_version: runtime.version,
  });

  progress?.(
    "image.resolve",
    "resolving the managed Pi image; this may build or pull an image",
    { pi_version: runtime.version },
  );

  const packageState = await loadContainerPackageState(paths),
    activeRaw = await readText(paths.activeImage);
  let active: { recipeCommit: string; result: ImageBuildResult } | undefined;
  if (activeRaw)
    try {
      active = JSON.parse(activeRaw) as {
        recipeCommit: string;
        result: ImageBuildResult;
      };
    } catch {
      throw new IntegralError("invalid active managed image state");
    }

  const image = await dependencies.ensureImage(
    config,
    active?.result.piVersion ?? runtime.version,
    {
      systemPackages: packageState.packages,
      ...(active ? { expectedImage: active.result.image } : {}),
    },
  );
  if (active && image !== active.result.image)
    throw new IntegralError(
      `active managed image ${active.result.image} is unavailable; run integral image rebuild`,
    );
  progress?.("image.ready", "managed Pi image is ready", {
    pi_version: runtime.version,
  });

  const piVersion =
      config.runner.image === DEFAULT_PI_IMAGE
        ? (active?.result.piVersion ?? runtime.version)
        : await dependencies.discoverVersion(image),
    providers = [
      ...new Set(connections.map((connection) => connection.provider!)),
    ];

  progress?.("models.discover", "discovering models from the Pi image", {
    provider_count: providers.length,
  });
  const models = await dependencies.discoverModels(image, providers),
    byProvider = new Map<string, string[]>();
  progress?.("models.ready", "Pi model discovery is complete", {
    model_count: models.length,
  });

  for (const { provider, model } of models) {
    const group = byProvider.get(provider) ?? [];
    group.push(model);
    byProvider.set(provider, group);
  }

  const choices = connections.flatMap((connection) =>
    [...new Set(byProvider.get(connection.provider!) ?? [])]
      .sort()
      .map((model) => ({
        connection: connection.name,
        provider: connection.provider!,
        model,
        piVersion,
        piImage: image,
      })),
  );

  return {
    choices,
    piVersion,
    piImage: image,
  };
}

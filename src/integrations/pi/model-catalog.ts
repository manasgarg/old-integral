import {
  discoverPiModels,
  ensureReleasePiImage,
} from "../docker/managed-image.ts";
import { listConnections } from "../../stores/connection-store.ts";
import type { IntegralPaths } from "../../platform/deployment-paths.ts";
import { ensurePiRuntime, type PiRuntimeResolution } from "./host-runtime.ts";
import type { ModelChoice } from "../../domain/model-selection.ts";

export interface ModelCatalog {
  choices: ModelChoice[];
  piVersion?: string;
}

export type ModelCatalogProgress = (
  stage: string,
  message: string,
  context?: Record<string, unknown>,
) => void;

export interface ModelCatalogDependencies {
  ensureRuntime(paths: IntegralPaths): Promise<PiRuntimeResolution>;
  ensureImage(): string | Promise<string>;
  discoverModels(
    image: string,
    providers: readonly string[],
  ): Promise<Array<{ provider: string; model: string }>>;
}

const productionDependencies: ModelCatalogDependencies = {
  ensureRuntime: ensurePiRuntime,
  ensureImage: ensureReleasePiImage,
  discoverModels: discoverPiModels,
};

export interface ManagedPiRuntime {
  piVersion: string;
  piImage: string;
}

/**
 * The Pi version and image this release runs: the pinned Pi version and the
 * image built from the release's own Dockerfile. Interactive sessions,
 * scheduled attempts and the model chooser all use it.
 */
export async function resolveManagedPiRuntime(
  paths: IntegralPaths,
  overrides: Partial<ModelCatalogDependencies> = {},
  progress?: ModelCatalogProgress,
): Promise<ManagedPiRuntime> {
  const dependencies = { ...productionDependencies, ...overrides };
  progress?.("runtime.resolve", "checking and preparing the Pi runtime");
  const runtime = await dependencies.ensureRuntime(paths);
  progress?.("runtime.ready", "Pi runtime is ready", {
    pi_version: runtime.version,
  });

  progress?.(
    "image.resolve",
    "resolving the release's Pi image; this may build it",
    { pi_version: runtime.version },
  );
  const image = await dependencies.ensureImage();
  progress?.("image.ready", "the release's Pi image is ready", {
    pi_version: runtime.version,
  });

  return { piVersion: runtime.version, piImage: image };
}

export async function listModelChoices(
  paths: IntegralPaths,
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

  const dependencies = { ...productionDependencies, ...overrides },
    { piVersion, piImage: image } = await resolveManagedPiRuntime(
      paths,
      dependencies,
      progress,
    ),
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
      })),
  );

  return { choices, piVersion };
}

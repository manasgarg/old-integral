import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PI_PACKAGE, PI_VERSION } from "./platform/constants.ts";
import { IntegralError } from "./platform/errors.ts";
import { ensureDir } from "./platform/files.ts";
import type { IntegralPaths } from "./platform/deployment-paths.ts";

export interface PiRuntimeResolution {
  version: string;
  packageRoot: string;
}

export interface PiPackageOperations {
  install(prefix: string, version: string): void;
}

const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

const productionOperations: PiPackageOperations = {
  install(prefix, version) {
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-save",
        "--package-lock=false",
        `${PI_PACKAGE}@${version}`,
      ],
      { encoding: "utf8", env: process.env },
    );

    if (result.status !== 0)
      throw new Error(result.stderr.trim() || "npm failed");
  },
};

function versionRoot(paths: IntegralPaths, version: string): string {
  return join(paths.piRuntime, "versions", version);
}

function packageRoot(prefix: string): string {
  return join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
}

async function installedVersion(prefix: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(packageRoot(prefix), "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Installs the pinned Pi version under deployment runtime state, or reuses it
 * when it is already installed. Never resolves a floating version and never
 * falls back to another installed version.
 */
export async function ensurePiRuntime(
  paths: IntegralPaths,
  operations: PiPackageOperations = productionOperations,
  version: string = PI_VERSION,
): Promise<PiRuntimeResolution> {
  if (!versionPattern.test(version))
    throw new IntegralError(`invalid pinned Pi version: ${version}`);

  const prefix = versionRoot(paths, version);
  if ((await installedVersion(prefix)) === version)
    return { version, packageRoot: packageRoot(prefix) };

  await ensureDir(prefix);
  try {
    operations.install(prefix, version);
  } catch (error) {
    throw new IntegralError(
      `cannot install pinned Pi ${version}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if ((await installedVersion(prefix)) !== version)
    throw new IntegralError(`Pi ${version} installation is incomplete`);

  return { version, packageRoot: packageRoot(prefix) };
}

export interface PiRuntimeModule {
  AuthStorage?: {
    inMemory(data?: Record<string, unknown>): PiAuthStorage;
  };
  ModelRegistry?: {
    inMemory(storage: PiAuthStorage): PiModelRegistry;
  };
  ModelRuntime?: {
    create(options?: {
      credentials?: PiCredentialStore;
    }): Promise<PiModelRuntime>;
  };
}

export interface PiCredential {
  type: "api_key" | "oauth";
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
}

export interface PiCredentialStore {
  read(provider: string): Promise<PiCredential | undefined>;
  list(): Promise<Array<{ providerId: string; type: "api_key" | "oauth" }>>;
  modify(
    provider: string,
    update: (
      current: PiCredential | undefined,
    ) => Promise<PiCredential | undefined>,
  ): Promise<PiCredential | undefined>;
  delete(provider: string): Promise<void>;
}

export type PiAuthPrompt =
  | {
      type: "text" | "secret" | "manual_code";
      message: string;
      placeholder?: string;
      signal?: AbortSignal;
    }
  | {
      type: "select";
      message: string;
      options: ReadonlyArray<{ id: string; label: string }>;
      signal?: AbortSignal;
    };

export type PiAuthEvent =
  | { type: "info" | "progress"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; verificationUri: string; userCode: string };

export interface PiModelRuntime {
  login(
    provider: string,
    type: "oauth",
    interaction: {
      signal?: AbortSignal;
      prompt(prompt: PiAuthPrompt): Promise<string>;
      notify(event: PiAuthEvent): void;
    },
  ): Promise<PiCredential>;
  getAuth(
    provider: string,
    options?: { minOAuthValidityMs?: number },
  ): Promise<
    { auth: { apiKey?: string; headers?: Record<string, string> } } | undefined
  >;
}

export interface PiAuthStorage {
  login(
    provider: string,
    callbacks: {
      onAuth(info: { instructions?: string; url: string }): void;
      onDeviceCode(info: { verificationUri: string; userCode: string }): void;
      onPrompt(prompt: {
        message: string;
        placeholder?: string;
      }): Promise<string>;
      onManualCodeInput(): Promise<string>;
      onProgress(message: string): void;
      onSelect(prompt: {
        options: Array<{ id: string; label: string }>;
      }): Promise<string | undefined>;
    },
  ): Promise<void>;
  get(provider: string): unknown;
  getApiKey(
    provider: string,
    options?: { includeFallback?: boolean },
  ): Promise<string | undefined>;
}

export interface PiModelRegistry {
  getAll(): Array<{ provider: string; id: string }>;
}

export async function loadPiRuntimeModule(
  resolution: PiRuntimeResolution,
): Promise<PiRuntimeModule> {
  const entry = pathToFileURL(join(resolution.packageRoot, "dist", "index.js"));
  const loaded = (await import(entry.href)) as Partial<PiRuntimeModule>;
  if (!loaded.ModelRuntime?.create && !loaded.AuthStorage?.inMemory)
    throw new IntegralError(
      `Pi ${resolution.version} is incompatible with integral's runtime interface`,
    );
  return loaded;
}

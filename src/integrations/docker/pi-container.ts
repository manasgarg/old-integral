import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import type { EffectiveConfig } from "../../stores/config.ts";
import type { Connection } from "../../stores/connection-store.ts";
import { IntegralError } from "../../platform/errors.ts";
import { atomicWrite, ensureDir } from "../../platform/files.ts";
import { OAUTH_SENTINEL, SENTINEL } from "../../domain/credential-sentinels.ts";
import { type McpRuntime } from "../mcp.ts";
import {
  interpretPiEvent,
  type PiProtocolEvent,
} from "../../domain/pi-rpc-protocol.ts";
import { ensureManagedPiImage } from "./managed-image.ts";
import { StdioMcpSidecar, type McpSidecarSpec } from "./mcp-sidecar.ts";

export {
  interpretPiProtocol,
  type PiProtocolEvent,
  type PiProtocolResult,
} from "../../domain/pi-rpc-protocol.ts";

export interface ContainerSpec {
  image: string;
  args: string[];
  environment: Record<string, string>;
  mounts: { source: string; target: string; readonly: boolean }[];
  sessionId: string;
  sessionToken: string;
  home: string;
  gatewayAddress: string;
}

export interface PiSession {
  readonly spec: ContainerSpec;
  start(): Promise<void>;
  prompt(text: string): Promise<string>;
  steer?(text: string): Promise<void>;
  stop(): Promise<void>;
}

export interface TaskPiSession extends PiSession {
  finish(): Promise<number>;
}

export interface ContainerBackend {
  ensureImage(
    config: EffectiveConfig,
    piVersion: string,
    options?: {
      systemPackages?: readonly string[];
      rebuild?: boolean;
      expectedImage?: string;
    },
  ): string | Promise<string>;
  ensureNetwork(name: string): Promise<void>;
  networkGateway(name: string): string | Promise<string>;
  createPi(
    spec: ContainerSpec,
    config: EffectiveConfig,
    network: string,
    onStderr: (line: string) => void,
    onEvent?: (event: PiProtocolEvent) => void,
  ): PiSession;
  createTaskPi(
    spec: ContainerSpec,
    config: EffectiveConfig,
    network: string,
    onStderr: (line: string) => void,
    onEvent?: (event: PiProtocolEvent) => void,
  ): TaskPiSession;
  createMcpSidecar?(
    spec: McpSidecarSpec,
    config: EffectiveConfig,
    network: string,
    onStderr: (line: string) => void,
  ): McpRuntime;
}

const managed = new Set([
  "HOME",
  "PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "PIP_CERT",
  "PI_CODING_AGENT_DIR",
  "NODE_USE_ENV_PROXY",
  "GH_TOKEN",
]);

export function isManagedContainerVariable(name: string): boolean {
  return managed.has(name) || name.startsWith("INTEGRAL_");
}

export function buildContainerSpec(options: {
  config: EffectiveConfig;
  gatewayUrl: string;
  gatewayAddress?: string;
  caCert: string;
  caBundle: string;
  sessionHome: string;
  sessionId: string;
  sessionToken: string;
  model: Connection;
  selectedModel: string;
  image?: string;
  mcp: Connection[];
  connections?: Connection[];
  historyArchive?: string;
  currentRun?: string;
}): ContainerSpec {
  const proxy = new URL(options.gatewayUrl);
  proxy.username = "integral";
  proxy.password = options.sessionToken;
  const proxyUrl = proxy.toString();

  const caPath = "/integral-ca/integral-ca.pem",
    bundlePath = "/integral-ca/ca-bundle.pem";
  const environment: Record<string, string> = {
    HOME: "/home/pi",
    PATH: "/home/pi/.local/bin:/usr/local/bin:/usr/bin:/bin",
    TMPDIR: "/tmp",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "",
    no_proxy: "",
    NODE_EXTRA_CA_CERTS: caPath,
    SSL_CERT_FILE: bundlePath,
    CURL_CA_BUNDLE: bundlePath,
    REQUESTS_CA_BUNDLE: bundlePath,
    GIT_SSL_CAINFO: bundlePath,
    PIP_CERT: bundlePath,
    PI_CODING_AGENT_DIR: "/home/pi/.pi/agent",
    NODE_USE_ENV_PROXY: "1",
  };

  const provider = options.model.provider!;
  // Pi sees only a sentinel. The gateway swaps it for the host credential inside the allowed boundary.
  if (options.model.auth !== "oauth" && options.model.auth !== "device-code")
    environment[
      provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
    ] = SENTINEL;

  if (
    options.connections?.some((connection) => connection.provider === "github")
  )
    environment.GH_TOKEN = SENTINEL;

  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--approve",
    "--offline",
    "--provider",
    provider,
  ];
  if (options.model.auth !== "oauth" && options.model.auth !== "device-code")
    args.push("--api-key", SENTINEL);
  args.push("--model", options.selectedModel);
  args.push("--extension", "/home/pi/.integral/extensions/integral-web.mjs");

  const mounts = [
    { source: options.caCert, target: caPath, readonly: true },
    { source: options.caBundle, target: bundlePath, readonly: true },
    { source: options.sessionHome, target: "/home/pi", readonly: false },
    {
      source: join(options.sessionHome, ".integral", "auth.json"),
      target: "/home/pi/.pi/agent/auth.json",
      readonly: true,
    },
  ];

  if (options.historyArchive)
    mounts.push({
      source: options.historyArchive,
      target: "/home/pi/history/runs",
      readonly: true,
    });
  if (options.currentRun)
    mounts.push({
      source: options.currentRun,
      target: "/home/pi/history/current",
      readonly: true,
    });

  return {
    image: options.image ?? options.config.runner.image,
    args,
    environment,
    mounts,
    sessionId: options.sessionId,
    sessionToken: options.sessionToken,
    home: options.sessionHome,
    gatewayAddress: options.gatewayAddress ?? "host-gateway",
  };
}

export function dockerRunArgs(
  spec: ContainerSpec,
  config: EffectiveConfig,
  network: string,
): string[] {
  const result = [
    "run",
    "--rm",
    "--interactive",
    "--name",
    `integral-${spec.sessionId}`,
    "--network",
    network,
    "--add-host",
    `host.integral.internal:${spec.gatewayAddress}`,
    "--user",
    "1000:1000",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--memory",
    `${config.runner.memoryMb}m`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=${config.runner.tmpfsMb}m`,
  ];

  for (const [name, value] of Object.entries(spec.environment))
    result.push("--env", `${name}=${value}`);
  for (const mount of spec.mounts)
    result.push(
      "--mount",
      `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ",readonly" : ""}`,
    );

  return [...result, spec.image, "pi", ...spec.args];
}

export async function writePiCredential(
  sessionHome: string,
  model: Connection,
): Promise<void> {
  const directory = join(sessionHome, ".integral");
  await ensureDir(directory);
  await ensureDir(join(sessionHome, ".pi", "agent"));

  const credential =
    model.auth === "oauth" || model.auth === "device-code"
      ? {
          type: "oauth",
          access: OAUTH_SENTINEL,
          refresh: SENTINEL,
          expires: Number.MAX_SAFE_INTEGER,
        }
      : { type: "api_key", key: SENTINEL };

  await atomicWrite(
    join(directory, "auth.json"),
    `${JSON.stringify({ [model.provider!]: credential })}\n`,
  );
}

export function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

export async function createLockedNetwork(name: string): Promise<void> {
  const inspect = spawnSync("docker", ["network", "inspect", name], {
    stdio: "ignore",
  });
  if (inspect.status === 0) return;

  const created = spawnSync(
    "docker",
    ["network", "create", "--internal", name],
    { encoding: "utf8" },
  );
  if (created.status !== 0)
    throw new IntegralError(
      `cannot create locked Docker network: ${created.stderr.trim()}`,
    );
}

export function dockerNetworkGateway(name: string): string {
  const result = spawnSync(
    "docker",
    [
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
      name,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout.trim())
    throw new IntegralError("cannot discover locked Docker network gateway");
  return result.stdout.trim();
}

export class PiContainer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private response = "";
  private pending:
    | {
        resolve: (text: string) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private exit: Promise<number | null> | undefined;
  private readonly steering: Array<{
    resolve(): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    readonly spec: ContainerSpec,
    private readonly config: EffectiveConfig,
    private readonly network: string,
    private readonly diagnostic: (line: string) => void = () => undefined,
    private readonly observe: (event: PiProtocolEvent) => void = () =>
      undefined,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;

    const child = spawn(
      "docker",
      dockerRunArgs(this.spec, this.config, this.network),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    this.exit = new Promise((resolve) => child.once("exit", resolve));

    createInterface({ input: child.stdout }).on("line", (line) =>
      this.protocol(line),
    );
    createInterface({ input: child.stderr }).on("line", (line) =>
      this.diagnostic(line.replace(/[\r\n]/g, " ")),
    );

    child.once("exit", (code) => {
      const error = new IntegralError(
        `Pi container exited unexpectedly (${code ?? "signal"})`,
      );

      this.pending?.reject(error);
      this.pending = undefined;

      for (const steering of this.steering) {
        clearTimeout(steering.timer);
        steering.reject(error);
      }
      this.steering.length = 0;
      this.child = undefined;
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  private protocol(line: string): void {
    let raw: PiProtocolEvent;
    try {
      raw = JSON.parse(line) as PiProtocolEvent;
    } catch {
      return;
    }

    try {
      this.observe(raw);
    } catch (error) {
      this.diagnostic(
        `run event observer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const response = raw as unknown as {
      type?: unknown;
      command?: unknown;
      success?: unknown;
      error?: unknown;
    };

    if (response.type === "response" && response.command === "steer") {
      const steering = this.steering.shift();
      if (steering) {
        clearTimeout(steering.timer);
        if (response.success === false)
          steering.reject(
            new IntegralError(
              typeof response.error === "string"
                ? response.error
                : "Pi rejected steering input",
            ),
          );
        else steering.resolve();
      }
      return;
    }

    if (!this.pending) return;
    const event = interpretPiEvent(raw);

    if (event.type === "rejected") {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(new IntegralError(event.error));
      return;
    }

    if (event.type === "text") this.response += event.text;
    if (event.type === "complete") {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(this.response);
    }
  }

  prompt(text: string): Promise<string> {
    if (!this.child)
      return Promise.reject(new IntegralError("Pi container is not running"));
    if (this.pending)
      return Promise.reject(new IntegralError("Pi turn already in flight"));

    this.response = "";
    this.child.stdin.write(
      `${JSON.stringify({ type: "prompt", message: text })}\n`,
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new IntegralError("Pi turn timed out"));
        void this.stop();
      }, this.config.runner.turnTimeoutSeconds * 1000);

      this.pending = { resolve, reject, timer };
    });
  }

  steer(text: string): Promise<void> {
    if (!this.child)
      return Promise.reject(new IntegralError("Pi container is not running"));
    if (!this.pending)
      return Promise.reject(new IntegralError("Pi turn is not in flight"));

    return new Promise((resolve, reject) => {
      const request = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.steering.indexOf(request);
          if (index >= 0) this.steering.splice(index, 1);
          reject(new IntegralError("Pi steering acknowledgement timed out"));
        }, 5_000),
      };

      this.steering.push(request);
      this.child!.stdin.write(
        `${JSON.stringify({ type: "steer", message: text })}\n`,
        (error) => {
          if (!error) return;
          clearTimeout(request.timer);
          const index = this.steering.indexOf(request);
          if (index >= 0) this.steering.splice(index, 1);
          reject(error);
        },
      );
    });
  }

  async finish(): Promise<number> {
    const child = this.child,
      exit = this.exit;
    if (!child || !exit) throw new IntegralError("Pi container is not running");
    if (this.pending) throw new IntegralError("Pi turn is still in flight");

    child.stdin.end();
    const result = await Promise.race([
      exit,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 5_000),
      ),
    ]);

    if (result === "timeout") {
      await this.stop();
      throw new IntegralError("Pi task did not exit cleanly after completion");
    }

    return result ?? 128;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;

    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(new IntegralError("Pi container stopped"));
    }

    for (const steering of this.steering) {
      clearTimeout(steering.timer);
      steering.reject(new IntegralError("Pi container stopped"));
    }
    this.steering.length = 0;

    if (child) {
      const exited = new Promise<boolean>((resolve) =>
        child.once("exit", () => resolve(true)),
      );
      child.kill("SIGTERM");

      const stopped = await Promise.race([
        exited,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);

      if (!stopped) {
        spawnSync(
          "docker",
          ["rm", "--force", `integral-${this.spec.sessionId}`],
          {
            stdio: "ignore",
          },
        );
        await exited;
      }
    }

    await rm(this.spec.home, { recursive: true, force: true });
  }
}

export const dockerContainerBackend: ContainerBackend = {
  ensureImage: ensureManagedPiImage,
  ensureNetwork: createLockedNetwork,
  networkGateway: dockerNetworkGateway,
  createPi(spec, config, network, onStderr, onEvent) {
    return new PiContainer(spec, config, network, onStderr, onEvent);
  },
  createTaskPi(spec, config, network, onStderr, onEvent) {
    return new PiContainer(spec, config, network, onStderr, onEvent);
  },
  createMcpSidecar(spec, config, network, onStderr) {
    return new StdioMcpSidecar(spec, config, network, onStderr);
  },
};

export async function freshSessionHome(
  parent: string = tmpdir(),
): Promise<string> {
  await ensureDir(parent);
  const home = await mkdtemp(join(parent, "integral-pi-"));

  try {
    await Promise.all([
      ensureDir(join(home, "history", "runs")),
      ensureDir(join(home, "history", "current")),
    ]);
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }

  return home;
}

export function newSessionIdentity(): {
  sessionId: string;
  sessionToken: string;
} {
  return {
    sessionId: randomUUID(),
    sessionToken: `${randomUUID()}${randomUUID()}`,
  };
}

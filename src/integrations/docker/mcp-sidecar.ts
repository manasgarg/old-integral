import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import type { EffectiveConfig } from "../../stores/config.ts";
import type { Connection } from "../../stores/connection-store.ts";
import { IntegralError } from "../../platform/errors.ts";
import { INTEGRAL_VERSION } from "../../platform/constants.ts";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SESSION_PROTOCOL_VERSION,
  toolsFromListResult,
  type McpCatalog,
  type McpRuntime,
  type McpToolResult,
} from "../mcp.ts";

export interface McpSidecarSpec {
  connection: Connection;
  image: string;
  sessionId: string;
  sessionToken: string;
  gatewayUrl: string;
  gatewayAddress: string;
  caCert: string;
  caBundle: string;
  secretValues: Record<string, string>;
}

const MCP_BOOTSTRAP = `const { spawn } = require("node:child_process"); let buffered = Buffer.alloc(0), started = false; function data(chunk) { if (started) return; buffered = Buffer.concat([buffered, chunk]); const newline = buffered.indexOf(10); if (newline < 0) return; started = true; process.stdin.off("data", data); let secrets; try { secrets = JSON.parse(buffered.subarray(0, newline).toString("utf8")); } catch { process.stderr.write("invalid integral MCP secret bootstrap\\n"); process.exit(70); return; } const child = spawn(process.argv[1], process.argv.slice(2), { env: { ...process.env, ...secrets }, stdio: ["pipe", "pipe", "pipe"] }); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); const remaining = buffered.subarray(newline + 1); if (remaining.length) child.stdin.write(remaining); process.stdin.pipe(child.stdin); child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1))); child.on("error", (error) => { process.stderr.write(error.message + "\\n"); process.exit(70); }); } process.stdin.on("data", data); process.stdin.resume();`;

export function dockerMcpSidecarArgs(
  spec: McpSidecarSpec,
  config: EffectiveConfig,
  network: string,
): string[] {
  const proxy = new URL(spec.gatewayUrl);
  proxy.username = "integral";
  proxy.password = spec.sessionToken;

  const proxyUrl = proxy.toString(),
    name = `integral-mcp-${spec.sessionId}-${spec.connection.name.replace(/[^A-Za-z0-9_.-]/g, "-")}`,
    caPath = "/integral-ca/integral-ca.pem",
    bundlePath = "/integral-ca/ca-bundle.pem",
    environment: Record<string, string> = {
      HOME: "/tmp",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: "/tmp",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "",
      no_proxy: "",
      NODE_EXTRA_CA_CERTS: caPath,
      SSL_CERT_FILE: bundlePath,
      NODE_USE_ENV_PROXY: "1",
      ...(spec.connection.env ?? {}),
    },
    args = [
      "run",
      "--rm",
      "--interactive",
      "--name",
      name,
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

  for (const [key, value] of Object.entries(environment))
    args.push("--env", `${key}=${value}`);
  for (const [source, target] of [
    [spec.caCert, caPath],
    [spec.caBundle, bundlePath],
  ])
    args.push(
      "--mount",
      `type=bind,source=${source},target=${target},readonly`,
    );

  return [
    ...args,
    spec.image,
    "node",
    "-e",
    MCP_BOOTSTRAP,
    spec.connection.command!,
    ...(spec.connection.args ?? []),
  ];
}

interface PendingMcpRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}

export class StdioMcpSidecar implements McpRuntime {
  readonly connection: Connection;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private readonly pending = new Map<number, PendingMcpRequest>();

  constructor(
    private readonly spec: McpSidecarSpec,
    private readonly config: EffectiveConfig,
    private readonly network: string,
    private readonly diagnostic: (line: string) => void = () => undefined,
  ) {
    this.connection = spec.connection;
  }

  async start(): Promise<McpCatalog> {
    if (this.child)
      throw new IntegralError(
        `MCP sidecar ${this.connection.name} is already running`,
      );

    const child = spawn(
      "docker",
      dockerMcpSidecarArgs(this.spec, this.config, this.network),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.protocol(line),
    );
    createInterface({ input: child.stderr }).on("line", (line) =>
      this.diagnostic(this.sanitize(line)),
    );

    child.once("exit", (code) => {
      const error = new IntegralError(
        `MCP sidecar ${this.connection.name} exited (${code ?? "signal"})`,
      );

      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      if (this.child === child) this.child = undefined;
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    child.stdin.write(`${JSON.stringify(this.spec.secretValues)}\n`);

    try {
      const discovery = await this.request("server/discover", {});
      if (discovery.error === undefined) {
        this.protocolVersion = MCP_PROTOCOL_VERSION;
      } else {
        const initialized = await this.request("initialize", {
          protocolVersion: MCP_SESSION_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "integral", version: INTEGRAL_VERSION },
        });

        const result = this.result(initialized, "initialize");
        if (typeof result.protocolVersion !== "string")
          throw new IntegralError(
            "MCP initialize result omitted protocolVersion",
          );

        this.protocolVersion = result.protocolVersion;
        this.notify("notifications/initialized", {});
      }

      const tools = [],
        diagnostics: string[] = [],
        names = new Set<string>(),
        seen = new Set<string>();

      let cursor: string | undefined;
      do {
        if (cursor && seen.has(cursor))
          throw new IntegralError(
            "MCP tools/list repeated a pagination cursor",
          );
        if (cursor) seen.add(cursor);

        const page = toolsFromListResult(
          this.result(
            await this.request("tools/list", cursor ? { cursor } : {}),
            "tools/list",
          ),
        );
        tools.push(...page.tools);
        diagnostics.push(...page.diagnostics);
        cursor = page.nextCursor;
      } while (cursor);

      const duplicates = new Set<string>();
      for (const tool of tools)
        if (names.has(tool.name)) duplicates.add(tool.name);
        else names.add(tool.name);
      for (const name of duplicates)
        diagnostics.push(`${name}: MCP tool name is duplicated`);

      return {
        connection: this.connection,
        protocolVersion: this.protocolVersion,
        tools: tools.filter((tool) => !duplicates.has(tool.name)),
        ...(diagnostics.length ? { diagnostics } : {}),
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    return this.result(
      await this.request(
        "tools/call",
        { name, arguments: args },
        signal,
        this.config.runner.turnTimeoutSeconds * 1000,
      ),
      "tools/call",
    );
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child)
      return Promise.reject(
        new IntegralError(`MCP sidecar ${this.connection.name} is not running`),
      );

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: "timeout",
        });
        reject(new IntegralError(`MCP ${method} timed out`));
      }, timeoutMs);

      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: "cancelled",
        });
        reject(new IntegralError(`MCP ${method} was cancelled`));
      };

      if (signal?.aborted) return abort();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });

      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  private protocol(line: string): void {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
      if (!value || typeof value !== "object" || value.jsonrpc !== "2.0")
        throw new Error("invalid JSON-RPC envelope");
    } catch {
      const error = new IntegralError(
        `MCP sidecar ${this.connection.name} wrote non-protocol output to stdout`,
      );
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      void this.stop();
      return;
    }

    if (typeof value.id !== "number") return;
    const request = this.pending.get(value.id);
    if (!request) return;
    this.pending.delete(value.id);
    request.resolve(value);
  }

  private result(
    response: Record<string, unknown>,
    method: string,
  ): Record<string, unknown> {
    if (response.error && typeof response.error === "object") {
      const error = response.error as Record<string, unknown>;
      const detail =
        typeof error.message === "string"
          ? error.message
          : typeof error.code === "string" || typeof error.code === "number"
            ? String(error.code)
            : "unknown error";
      throw new IntegralError(`MCP ${method} failed: ${detail}`);
    }

    if (
      !response.result ||
      typeof response.result !== "object" ||
      Array.isArray(response.result)
    )
      throw new IntegralError(`MCP ${method} result must be an object`);

    return response.result as Record<string, unknown>;
  }

  private sanitize(line: string): string {
    let clean = line.replace(/[\r\n]/g, " ");
    for (const secret of Object.values(this.spec.secretValues))
      if (secret) clean = clean.split(secret).join("[REDACTED]");
    return clean;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child) return;

    for (const request of this.pending.values())
      request.reject(
        new IntegralError(`MCP sidecar ${this.connection.name} stopped`),
      );
    this.pending.clear();

    const exited = new Promise<boolean>((resolve) =>
      child.once("exit", () => resolve(true)),
    );
    child.stdin.end();

    const stopped = await Promise.race([
      exited,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);

    if (!stopped) {
      spawnSync(
        "docker",
        [
          "rm",
          "--force",
          `integral-mcp-${this.spec.sessionId}-${this.connection.name.replace(/[^A-Za-z0-9_.-]/g, "-")}`,
        ],
        { stdio: "ignore" },
      );
      await exited;
    }
  }
}

import { createHash } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Connection } from "../../stores/connection-store.ts";
import type { ResourceProjection } from "../../stores/resource-store.ts";
import { IntegralError } from "../../platform/errors.ts";
import { atomicWrite, ensureDir } from "../../platform/files.ts";
import { type McpCatalog } from "../mcp.ts";
import { packageFile } from "../../platform/package-files.ts";

export async function writeMcpExtension(
  sessionHome: string,
  catalogs: McpCatalog[],
): Promise<void> {
  const directory = join(sessionHome, ".integral", "extensions");
  await ensureDir(directory);

  const declarations = catalogs.flatMap((catalog) =>
    catalog.tools.map((tool) => ({
      connection: catalog.connection.name,
      name: mcpToolName(catalog.connection.name, tool.name),
      remoteName: tool.name,
      label: tool.title ?? `${catalog.connection.name}: ${tool.name}`,
      description:
        tool.description ??
        `Call ${tool.name} on the ${catalog.connection.name} MCP server`,
      parameters: tool.inputSchema,
    })),
  );

  const source = `import { request } from "node:http";
import { Type } from "typebox";
const tools = ${JSON.stringify(declarations)};
function control(path) { const proxy = new URL(process.env.HTTP_PROXY), target = new URL(path, "http://integral.control"), authorization = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64"); proxy.username = ""; proxy.password = ""; proxy.pathname = target.pathname; proxy.search = target.search; return { url: proxy.toString(), authorization }; }
function controlRequest(path, method, body, signal) { return new Promise((resolve, reject) => { const target = control(path), payload = body === undefined ? undefined : JSON.stringify(body), chunks = []; let settled = false; const finish = (action) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); action(); }, req = request(target.url, { agent: false, method, headers: { "content-type": "application/json", "proxy-authorization": target.authorization, ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }) } }, (res) => { res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => finish(() => resolve({ status: res.statusCode || 500, text: Buffer.concat(chunks).toString("utf8") }))); res.on("error", (error) => finish(() => reject(error))); }), abort = () => req.destroy(new Error("schedule request was cancelled")); signal?.addEventListener("abort", abort, { once: true }); req.on("error", (error) => finish(() => reject(error))); req.end(payload); }); }
async function schedule(path, method, body, signal) { const response = await controlRequest(path, method, body, signal), text = response.text; if (response.status < 200 || response.status >= 300) throw new Error("Schedule request failed: " + response.status + " " + text.trim()); return text ? JSON.parse(text) : null; }
async function mcp(tool, args, signal) { const response = await controlRequest("/integral/mcp", "POST", { connection: tool.connection, tool: tool.remoteName, arguments: args }, signal), text = response.text; if (response.status < 200 || response.status >= 300) throw new Error(text.trim() || "MCP tool call failed"); return text ? JSON.parse(text) : {}; }
function result(value) { return { content: [{ type: "text", text: JSON.stringify(value) }], details: value }; }
export default function (pi) {
  for (const tool of tools) pi.registerTool({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, async execute(_id, params, signal) { const value = await mcp(tool, params, signal); return { content: value.content || [{ type: "text", text: JSON.stringify(value.structuredContent ?? value) }], details: { connection: tool.connection, tool: tool.remoteName, structuredContent: value.structuredContent, isError: value.isError === true } }; } });
  pi.registerTool({ name: "schedule_list", label: "List schedules", description: "List schedules managed by Integral", parameters: Type.Object({}), async execute(_id, _params, signal) { return result(await schedule("/integral/control/schedules", "GET", undefined, signal)); } });
  pi.registerTool({ name: "schedule_show", label: "Show schedule", description: "Show one Integral schedule definition", parameters: Type.Object({ id: Type.String() }), async execute(_id, params, signal) { return result(await schedule("/integral/control/schedules/" + encodeURIComponent(params.id), "GET", undefined, signal)); } });
  pi.registerTool({ name: "schedule_history", label: "Schedule history", description: "Show committed definition history for one Integral schedule", parameters: Type.Object({ id: Type.String() }), async execute(_id, params, signal) { return result(await schedule("/integral/control/schedules/" + encodeURIComponent(params.id) + "/history", "GET", undefined, signal)); } });
  pi.registerTool({ name: "schedule_runs", label: "Schedule runs", description: "List task occurrences, optionally for one schedule", parameters: Type.Object({ scheduleId: Type.Optional(Type.String()) }), async execute(_id, params, signal) { const suffix = params.scheduleId ? "?scheduleId=" + encodeURIComponent(params.scheduleId) : ""; return result(await schedule("/integral/control/occurrences" + suffix, "GET", undefined, signal)); } });
  pi.registerTool({ name: "schedule_create", label: "Create schedule", description: "Create a recurring cron schedule or one-time task", parameters: Type.Object({ prompt: Type.String(), cron: Type.Optional(Type.String()), timezone: Type.Optional(Type.String()), runAt: Type.Optional(Type.String()) }), async execute(_id, params, signal) { const trigger = params.runAt ? { type: "once", runAt: params.runAt } : { type: "recurring", cron: params.cron, timezone: params.timezone }; return result(await schedule("/integral/control/schedules", "POST", { prompt: params.prompt, trigger }, signal)); } });
  for (const action of ["enable", "disable"]) pi.registerTool({ name: "schedule_" + action, label: action + " schedule", description: action + " a schedule", parameters: Type.Object({ id: Type.String(), expectedRevision: Type.Integer() }), async execute(_id, params, signal) { return result(await schedule("/integral/control/schedules/" + encodeURIComponent(params.id) + "/" + action, "POST", { expectedRevision: params.expectedRevision }, signal)); } });
  pi.registerTool({ name: "schedule_update", label: "Update schedule", description: "Update a schedule using its current revision", parameters: Type.Object({ id: Type.String(), expectedRevision: Type.Integer(), prompt: Type.Optional(Type.String()), cron: Type.Optional(Type.String()), timezone: Type.Optional(Type.String()), runAt: Type.Optional(Type.String()) }), async execute(_id, params, signal) { const trigger = params.runAt ? { type: "once", runAt: params.runAt } : params.cron || params.timezone ? { type: "recurring", cron: params.cron, timezone: params.timezone } : undefined; return result(await schedule("/integral/control/schedules/" + encodeURIComponent(params.id), "PATCH", { expectedRevision: params.expectedRevision, prompt: params.prompt, trigger }, signal)); } });
  pi.registerTool({ name: "schedule_restore", label: "Restore schedule", description: "Restore a committed schedule definition as a new revision", parameters: Type.Object({ id: Type.String(), commit: Type.String(), expectedRevision: Type.Integer() }), async execute(_id, params, signal) { return result(await schedule("/integral/control/schedules/" + encodeURIComponent(params.id) + "/restore", "POST", { commit: params.commit, expectedRevision: params.expectedRevision }, signal)); } });
  pi.registerTool({ name: "schedule_delete", label: "Delete schedule", description: "Delete a schedule using its current revision", parameters: Type.Object({ id: Type.String(), expectedRevision: Type.Integer() }), async execute(_id, params, signal) { return result(await schedule("/integral/control/schedules/" + encodeURIComponent(params.id), "DELETE", { expectedRevision: params.expectedRevision }, signal)); } });
  pi.registerTool({ name: "task_list", label: "List tasks", description: "List durable Integral task executions and their current states", parameters: Type.Object({}), async execute(_id, _params, signal) { return result(await schedule("/integral/control/tasks", "GET", undefined, signal)); } });
  pi.registerTool({ name: "task_show", label: "Show task", description: "Show attempts, declarations, results, retry timing, and failure reason for one task execution", parameters: Type.Object({ id: Type.String() }), async execute(_id, params, signal) { return result(await schedule("/integral/control/tasks/" + encodeURIComponent(params.id), "GET", undefined, signal)); } });
  pi.registerTool({ name: "task_cancel", label: "Cancel task", description: "Cancel an active one-time task execution", parameters: Type.Object({ id: Type.String() }), async execute(_id, params, signal) { return result(await schedule("/integral/control/tasks/" + encodeURIComponent(params.id) + "/cancel", "POST", {}, signal)); } });
  pi.registerTool({ name: "container_package_list", label: "List container packages", description: "List the governed Debian package set and current revision for the managed Pi image", parameters: Type.Object({}), async execute(_id, _params, signal) { return result(await schedule("/integral/control/container-packages", "GET", undefined, signal)); } });
  for (const operation of ["install", "upgrade"]) pi.registerTool({ name: "container_package_" + operation, label: operation + " container packages", description: operation + " Debian packages through Integral's governed immutable-image builder; the current container is replaced after this turn", parameters: Type.Object({ packages: Type.Array(Type.String()), expectedRevision: Type.Integer() }), async execute(_id, params, signal) { return result(await schedule("/integral/control/container-packages", "POST", { operation, packages: params.packages, expectedRevision: params.expectedRevision }, signal)); } });
}

`;

  await atomicWrite(join(directory, "integral-mcp.ts"), source);
}

export async function writeWebExtension(sessionHome: string): Promise<void> {
  const directory = join(sessionHome, ".integral", "extensions"),
    source = await readFile(packageFile("dist/src/integral-web.mjs"));
  await ensureDir(directory);
  await atomicWrite(join(directory, "integral-web.mjs"), source);
}

export function mcpToolName(connection: string, tool: string): string {
  const readable = `mcp_${connection}_${tool}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .slice(0, 54);
  const suffix = createHash("sha256")
    .update(`${connection}\0${tool}`)
    .digest("hex")
    .slice(0, 8);

  return `${readable}_${suffix}`;
}

export async function writeEmailExtension(
  sessionHome: string,
  connections: Connection[],
): Promise<void> {
  if (!connections.length) return;

  const directory = join(sessionHome, ".integral", "extensions");
  await ensureDir(directory);

  const declarations = connections.map((connection) => ({
    name: connection.name,
    toolName: connection.name.replace(/[^A-Za-z0-9_]/g, "_"),
    capabilities: connection.capabilities,
  }));

  const source = `import { request } from "node:http";
import { Type } from "typebox";
const accounts = ${JSON.stringify(declarations)};
function endpoint() { const proxy = new URL(process.env.HTTP_PROXY); const authorization = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64"); proxy.username = ""; proxy.password = ""; proxy.pathname = "/integral/email"; return { url: proxy.toString(), authorization }; }
function transportFailure(error, signal) { if (signal?.aborted) return new Error("email gateway request was cancelled"); const cause = error && typeof error === "object" && error.cause && typeof error.cause === "object" ? error.cause : error; const code = cause && typeof cause === "object" && typeof cause.code === "string" && /^[A-Z0-9_]{1,40}$/.test(cause.code) ? cause.code : undefined; return new Error("email gateway request failed" + (code ? ": " + code : "")); }
function post(target, body, signal) { return new Promise((resolve, reject) => { if (signal?.aborted) { reject(transportFailure(undefined, signal)); return; } const chunks = []; let size = 0, settled = false; const finish = (action) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); action(); }; const req = request(target.url, { agent: false, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "proxy-authorization": target.authorization } }, (res) => { res.on("data", (chunk) => { size += chunk.length; if (size > 500000) req.destroy(new Error("email gateway response exceeded limit")); else chunks.push(chunk); }); res.on("end", () => finish(() => resolve({ status: res.statusCode || 500, text: Buffer.concat(chunks).toString("utf8") }))); res.on("error", (error) => finish(() => reject(error))); }); const abort = () => req.destroy(transportFailure(undefined, signal)); signal?.addEventListener("abort", abort, { once: true }); req.on("error", (error) => finish(() => reject(error))); req.end(body); }); }
async function call(connection, operation, params, signal) { const target = endpoint(); let response; try { response = await post(target, JSON.stringify({ connection, operation, ...params }), signal); } catch (error) { throw transportFailure(error, signal); } if (response.status < 200 || response.status >= 300) throw new Error(response.text.trim() || "email operation failed"); return JSON.parse(response.text); }
const schemas = {
  search: Type.Object({ query: Type.String(), maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })) }),
  read: Type.Object({ messageId: Type.String() }),
  send: Type.Object({ to: Type.Array(Type.String()), cc: Type.Optional(Type.Array(Type.String())), bcc: Type.Optional(Type.Array(Type.String())), subject: Type.String(), text: Type.String() })
};
export default function (pi) { for (const account of accounts) for (const capability of account.capabilities) pi.registerTool({ name: "email_" + account.toolName + "_" + capability, label: "Email " + account.name + " " + capability, description: capability + " email using the " + account.name + " account", parameters: schemas[capability], async execute(_id, params, signal) { const result = await call(account.name, capability, params, signal); return { content: [{ type: "text", text: JSON.stringify(result) }], details: { account: account.name, capability } }; } }); }
`;

  await atomicWrite(join(directory, "integral-email.ts"), source);
}

export async function writeDiscordExtension(
  sessionHome: string,
  connections: Connection[],
): Promise<void> {
  if (!connections.length) return;
  if (connections.length !== 1)
    throw new IntegralError("only one Discord channel connection is supported");

  const directory = join(sessionHome, ".integral", "extensions");
  await ensureDir(directory);

  const source = `import { request } from "node:http";
import { Type } from "typebox";
function endpoint() { const proxy = new URL(process.env.HTTP_PROXY); const authorization = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64"); proxy.username = ""; proxy.password = ""; proxy.pathname = "/integral/discord"; proxy.search = ""; return { url: proxy.toString(), authorization }; }
function send(text, signal) { return new Promise((resolve, reject) => { const target = endpoint(), payload = JSON.stringify({ text }), chunks = []; let settled = false; const finish = (action) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); action(); }, req = request(target.url, { agent: false, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "proxy-authorization": target.authorization } }, (res) => { res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => finish(() => { const body = Buffer.concat(chunks).toString("utf8"); if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) reject(new Error(body.trim() || "Discord delivery failed")); else resolve(body ? JSON.parse(body) : { delivered: true }); })); res.on("error", (error) => finish(() => reject(error))); }), abort = () => req.destroy(new Error("Discord delivery was cancelled")); signal?.addEventListener("abort", abort, { once: true }); req.on("error", (error) => finish(() => reject(error))); req.end(payload); }); }
export default function (pi) { pi.registerTool({ name: "discord_send", label: "Send Discord message", description: "Send text to the deployment's one configured Discord DM", parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 100000 }) }), async execute(_id, params, signal) { const value = await send(params.text, signal); return { content: [{ type: "text", text: "Discord message sent." }], details: value }; } }); }
`;

  await atomicWrite(join(directory, "integral-discord.ts"), source);
}

export async function writeResourceExtension(
  sessionHome: string,
  projection: ResourceProjection,
): Promise<void> {
  const directory = join(sessionHome, ".integral", "extensions");
  await ensureDir(directory);

  const repositories = projection.repositories.map(({ resource }) => ({
    id: resource.id,
    name: resource.connection,
    mount: resource.mount,
  }));
  const stores = projection.stores.map((resource) => ({
    id: resource.id,
    name: resource.connection,
    mount: resource.mount,
  }));

  const source = `import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
const run = promisify(execFile), repositories = ${JSON.stringify(repositories)};
function endpoint(path) { const proxy = new URL(process.env.HTTP_PROXY), authorization = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64"); proxy.username = ""; proxy.password = ""; proxy.pathname = path; proxy.search = ""; return { url: proxy.toString(), authorization }; }
function call(path, method, body, signal) { return new Promise((resolve, reject) => { const target = endpoint(path), payload = body === undefined ? undefined : JSON.stringify(body), chunks = []; let settled = false; const finish = (action) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); action(); }, req = request(target.url, { agent: false, method, headers: { "content-type": "application/json", "proxy-authorization": target.authorization, ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }) } }, (res) => { res.on("data", chunk => chunks.push(chunk)); res.on("end", () => finish(() => { const text = Buffer.concat(chunks).toString("utf8"); if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) reject(new Error(text.trim() || "resource operation failed")); else resolve(text ? JSON.parse(text) : null); })); }), abort = () => req.destroy(new Error("resource request was cancelled")); signal?.addEventListener("abort", abort, { once: true }); req.on("error", error => finish(() => reject(error))); req.end(payload); }); }
function result(value) { return { content: [{ type: "text", text: JSON.stringify(value) }], details: value }; }
export default function (pi) {
  for (const kind of ["repo", "store"]) {
    pi.registerTool({ name: kind + "_list", label: "List governed " + kind + "s", description: "List governed " + kind + " resources without exposing host paths", parameters: Type.Object({}), async execute(_id, _params, signal) { return result(await call("/integral/control/resources/" + kind + "s", "GET", undefined, signal)); } });
    pi.registerTool({ name: kind + "_create", label: "Create governed " + kind, description: "Create and attach a host-managed " + kind + "; the current session is replaced after success", parameters: Type.Object({ name: Type.String(), mount: Type.String() }), async execute(_id, params, signal) { return result(await call("/integral/control/resources/" + kind + "s", "POST", params, signal)); } });
    pi.registerTool({ name: kind + "_delete", label: "Soft-delete governed " + kind, description: "Remove this resource from future sessions while the current session keeps its mount", parameters: Type.Object({ id: Type.String(), expectedRevision: Type.Integer() }), async execute(_id, params, signal) { return result(await call("/integral/control/resources/" + kind + "s/" + encodeURIComponent(params.id), "DELETE", params, signal)); } });
    pi.registerTool({ name: kind + "_restore", label: "Restore governed " + kind, description: "Restore a soft-deleted resource at a mount path; the current session is replaced after success", parameters: Type.Object({ id: Type.String(), expectedRevision: Type.Integer(), mount: Type.String() }), async execute(_id, params, signal) { return result(await call("/integral/control/resources/" + kind + "s/" + encodeURIComponent(params.id) + "/restore", "POST", params, signal)); } });
  }
  pi.registerTool({ name: "repo_push", label: "Push governed repository", description: "Land committed work on the canonical repository. A local commit exists only in this run until this tool succeeds; call it before reporting repository work complete. If you decide not to land your commits, undo them and their file changes instead. The protected image-recipe repository requires human approval.", parameters: Type.Object({ id: Type.String() }), async execute(_id, params, signal) { const repository = repositories.find(value => value.id === params.id || value.name === params.id); if (!repository) throw new Error("repository is not mounted in this session"); const checkout = repository.mount, dirty = (await run("git", ["status", "--porcelain"], { cwd: checkout, signal })).stdout.trim(); if (dirty) throw new Error("repository has uncommitted changes; commit them before repo_push"); const proposed = (await run("git", ["rev-parse", "HEAD"], { cwd: checkout, signal })).stdout.trim(), bundle = join(tmpdir(), "integral-" + crypto.randomUUID() + ".bundle"); try { await run("git", ["bundle", "create", bundle, "HEAD"], { cwd: checkout, signal }); const encoded = (await readFile(bundle)).toString("base64"); return result(await call("/integral/control/resources/repos/" + encodeURIComponent(repository.id) + "/push", "POST", { proposed, bundle: encoded }, signal)); } finally { await rm(bundle, { force: true }); } } });
  pi.registerTool({ name: "repo_recovery_discard", label: "Discard recovered repository work", description: "Remove one host-owned recovery ref after examining the originating run log and deciding the recovered work should not land", parameters: Type.Object({ id: Type.String(), recoveryId: Type.String() }), async execute(_id, params, signal) { const repository = repositories.find(value => value.id === params.id || value.name === params.id); if (!repository) throw new Error("repository is not mounted in this session"); await call("/integral/control/resources/repos/" + encodeURIComponent(repository.id) + "/recovery/" + encodeURIComponent(params.recoveryId), "DELETE", undefined, signal); return result({ discarded: params.recoveryId }); } });
  pi.registerTool({ name: "container_image_rebuild", label: "Rebuild managed Pi image", description: "Request a fresh pull and no-cache rebuild of the active Dockerfile; this requires human approval and replaces the container after resolution", parameters: Type.Object({}), async execute(_id, _params, signal) { return result(await call("/integral/control/image-rebuild", "POST", {}, signal)); } });
  pi.registerTool({ name: "store_snapshot_list", label: "List store snapshots", description: "List retained snapshots for a governed store", parameters: Type.Object({ id: Type.String() }), async execute(_id, params, signal) { return result(await call("/integral/control/resources/stores/" + encodeURIComponent(params.id) + "/snapshots", "GET", undefined, signal)); } });
  pi.registerTool({ name: "store_snapshot_restore", label: "Restore store snapshot", description: "Restore retained store bytes using the current lifecycle revision", parameters: Type.Object({ id: Type.String(), snapshotId: Type.String(), expectedRevision: Type.Integer() }), async execute(_id, params, signal) { return result(await call("/integral/control/resources/stores/" + encodeURIComponent(params.id) + "/snapshots/" + encodeURIComponent(params.snapshotId) + "/restore", "POST", params, signal)); } });
}
`;
  await atomicWrite(join(directory, "integral-resources.ts"), source);

  const bin = join(sessionHome, ".local", "bin"),
    helper = join(bin, "integral-lock"),
    lockSource = `#!/usr/bin/env node
import { request } from "node:http";
const stores = ${JSON.stringify(stores)};
function usage() { console.error("usage: integral-lock <store-id|name|mount> <lock-name> -- <command> [args...]"); process.exit(2); }
function call(path, method, body) { return new Promise((resolve, reject) => { const proxy = new URL(process.env.HTTP_PROXY), authorization = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64"), payload = body === undefined ? undefined : JSON.stringify(body), chunks = []; proxy.username = ""; proxy.password = ""; proxy.pathname = path; proxy.search = ""; const req = request(proxy, { method, headers: { "content-type": "application/json", "proxy-authorization": authorization, ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }) } }, res => { res.on("data", chunk => chunks.push(chunk)); res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) reject(new Error(text.trim() || "store lock request failed")); else resolve(text ? JSON.parse(text) : null); }); }); req.on("error", reject); req.end(payload); }); }
const separator = process.argv.indexOf("--"), selector = process.argv[2], name = process.argv[3];
if (!selector || !name || separator !== 4 || !process.argv[5]) usage();
const store = stores.find(value => value.id === selector || value.name === selector || value.mount === selector);
if (!store) throw new Error("store is not mounted in this session: " + selector);
const path = "/integral/control/resources/stores/" + encodeURIComponent(store.id) + "/locks/" + encodeURIComponent(name), acquired = await call(path, "POST"), command = process.argv[5], args = process.argv.slice(6);
let code = 1;
try { code = await new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: "inherit", env: process.env }); child.on("error", reject); child.on("exit", (value, signal) => resolve(value ?? (signal ? 128 : 1))); }); }
finally { await call(path, "DELETE", { lease: acquired.lease }).catch(error => console.error("integral-lock: " + error.message)); }
process.exitCode = code;
`;

  await ensureDir(bin);
  await atomicWrite(helper, lockSource, 0o700);
  await chmod(helper, 0o700);
}

export async function writeTaskExtension(sessionHome: string): Promise<void> {
  const directory = join(sessionHome, ".integral", "extensions");
  await ensureDir(directory);

  const source = `import { request } from "node:http";
import { Type } from "typebox";
let declaredOutcome;
function endpoint() { const proxy = new URL(process.env.HTTP_PROXY); const authorization = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64"); proxy.username = ""; proxy.password = ""; proxy.pathname = "/integral/task-outcome"; return { url: proxy.toString(), authorization }; }
function post(body, signal) { return new Promise((resolve, reject) => { const target = endpoint(), payload = JSON.stringify(body), chunks = []; let settled = false; const finish = (action) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); action(); }, req = request(target.url, { agent: false, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "proxy-authorization": target.authorization } }, (res) => { res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => finish(() => resolve({ status: res.statusCode || 500, text: Buffer.concat(chunks).toString("utf8") }))); res.on("error", (error) => finish(() => reject(error))); }), abort = () => req.destroy(new Error("task outcome request was cancelled")); signal?.addEventListener("abort", abort, { once: true }); req.on("error", (error) => finish(() => reject(error))); req.end(payload); }); }
async function declare(outcome, message, signal) { const response = await post({ outcome, message }, signal); if (response.status < 200 || response.status >= 300) throw new Error(response.text.trim() || "task outcome declaration failed"); declaredOutcome = outcome; return { content: [{ type: "text", text: outcome === "complete" ? "Task completion recorded." : "Task failure recorded." }], details: { outcome, message }, terminate: true }; }
export default function (pi) {
  pi.registerTool({ name: "task_complete", label: "Complete task", description: "Declare that the isolated scheduled task completed successfully. This must be your final action when the task succeeded.", promptSnippet: "Declare successful completion of the scheduled task", promptGuidelines: ["Call task_complete as the final action when the scheduled task has succeeded."], parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 100000 }) }), async execute(_id, params, signal) { return declare("complete", params.summary, signal); } });
  pi.registerTool({ name: "task_fail", label: "Fail task", description: "Declare that the isolated scheduled task could not be completed. This must be your final action when the task failed.", promptSnippet: "Declare failure of the scheduled task", promptGuidelines: ["Call task_fail as the final action when the scheduled task cannot be completed."], parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 100000 }) }), async execute(_id, params, signal) { return declare("failed", params.reason, signal); } });
  pi.on("turn_end", async (event) => { if (declaredOutcome || event.toolResults?.length) return; pi.sendMessage({ customType: "integral-task-outcome-required", content: "You attempted to finish this scheduled task without declaring its outcome. Review the work and call exactly one of task_complete or task_fail now. Do not answer with ordinary text.", display: true }, { deliverAs: "steer", triggerTurn: true }); });
}
`;

  await atomicWrite(join(directory, "integral-task.ts"), source);
}

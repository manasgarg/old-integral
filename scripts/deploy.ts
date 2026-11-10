import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { CURRENT_DEPLOYMENT_FORMAT } from "../src/stores/deployment-format.ts";
import { RELEASE_STAMP_PATH } from "../src/platform/release-identity.ts";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Everything deploy does outside the filesystem goes through here. */
export interface DeployHost {
  run(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  /** Whether integral's components for `home` are running, from their own records. */
  deploymentStatus(home: string): Promise<"healthy" | "degraded" | "stopped">;
  sleep(ms: number): Promise<void>;
  now(): Date;
  report(line: string): void;
}

export interface DeploySettings {
  /** The repository checkout deploy runs from. */
  worktree: string;
  releaseRoot: string;
  /** The production deployment home. Never taken from `INTEGRAL_HOME`. */
  deploymentHome: string;
  systemdUnitDirectory: string;
  serviceName: string;
  nodeExecutable: string;
  /** `PATH` for the service: the Node.js directory first, then deploy's own. */
  servicePath: string;
  drainTimeoutMs: number;
  healthTimeoutMs: number;
  stepTimeoutMs: number;
  pollIntervalMs: number;
  backupsKept: number;
}

/**
 * The server runs `npm`, `git` and `docker`, and systemd starts user services
 * with a minimal `PATH` that usually holds none of a version manager's tools.
 */
export function servicePath(
  nodeExecutable: string,
  deployPath: string | undefined,
): string {
  const entries = [
    dirname(nodeExecutable),
    ...(deployPath ?? "").split(delimiter),
  ];
  return [...new Set(entries.filter((entry) => entry !== ""))].join(delimiter);
}

export function defaultDeploySettings(
  worktree: string,
  env: NodeJS.ProcessEnv = process.env,
): DeploySettings {
  const home = env.HOME ?? homedir();
  return {
    worktree,
    releaseRoot:
      env.INTEGRAL_RELEASE_ROOT ?? join(home, ".local", "share", "integral"),
    deploymentHome: env.INTEGRAL_DEPLOY_HOME ?? join(home, ".integral"),
    systemdUnitDirectory: join(home, ".config", "systemd", "user"),
    serviceName: "integral",
    nodeExecutable: process.execPath,
    servicePath: servicePath(process.execPath, env.PATH),
    drainTimeoutMs: 10 * 60_000,
    healthTimeoutMs: 2 * 60_000,
    stepTimeoutMs: 30 * 60_000,
    pollIntervalMs: 2_000,
    backupsKept: 3,
  };
}

export class DeployError extends Error {
  readonly step: string;

  constructor(message: string, step: string) {
    super(message);
    this.name = "DeployError";
    this.step = step;
  }
}

/** Reinstallable downloads that backups and rehearsals leave out. */
const REINSTALLABLE_DATA = "pi-runtime";

export interface BackupRecord {
  previousRelease: string | null;
  deploymentFormat: number | null;
  createdAt: string;
}

export interface DeployLogRecord {
  kind: "deploy" | "rollback";
  id: string;
  /** For a rollback, the deploy it undid. */
  undoes?: string;
  previousRelease: string | null;
  release: string | null;
  previousFormat: number | null;
  format: number | null;
  backup: string | null;
  startedAt: string;
  finishedAt: string;
  result: "deployed" | "rolled-back" | "rollback-failed" | "failed";
  failedStep?: string;
}

const releasesDirectory = (s: DeploySettings) =>
  join(s.releaseRoot, "releases");
const currentLink = (s: DeploySettings) => join(s.releaseRoot, "current");
const backupsDirectory = (s: DeploySettings) => join(s.releaseRoot, "backups");
const rehearsalsDirectory = (s: DeploySettings) =>
  join(s.releaseRoot, "rehearsals");
const deployLog = (s: DeploySettings) =>
  join(s.releaseRoot, "deploy-log.jsonl");
const unitName = (s: DeploySettings) => `${s.serviceName}.service`;
const integralBin = (release: string) => join(release, "bin", "integral.js");

function timestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function outputOf(result: CommandResult): string {
  return `${result.stdout}${result.stderr}`.trim();
}

async function required(
  host: DeployHost,
  step: string,
  command: string,
  args: string[],
  options?: CommandOptions,
): Promise<string> {
  const result = await host.run(command, args, options);
  if (result.code !== 0)
    throw new DeployError(
      `${step}: \`${[command, ...args].join(" ")}\` failed\n${outputOf(result)}`,
      step,
    );
  return result.stdout.trim();
}

function runIntegral(
  settings: DeploySettings,
  host: DeployHost,
  release: string,
  home: string,
  args: string[],
): Promise<CommandResult> {
  return host.run(settings.nodeExecutable, [integralBin(release), ...args], {
    env: { INTEGRAL_HOME: home },
    timeoutMs: settings.stepTimeoutMs,
  });
}

/** The release `current` points at, or null before the first deploy. */
export async function activeRelease(
  settings: DeploySettings,
): Promise<string | null> {
  try {
    return basename(await readlink(currentLink(settings)));
  } catch {
    return null;
  }
}

async function deploymentFormatOf(home: string): Promise<number | null> {
  const data = join(home, "data");
  if (!(await exists(data))) return null;

  const text = await readFile(join(data, "deployment-format.json"), "utf8")
    .then((value) => value)
    .catch(() => undefined);
  if (text === undefined) return 0;

  const format: unknown = Reflect.get(JSON.parse(text) as object, "format");
  return typeof format === "number" ? format : null;
}

// ---------------------------------------------------------------------------
// Check

/** Refuse to deploy anything but a clean, pushed, CI-green, accepted `main`. */
export async function checkReadyToDeploy(
  settings: DeploySettings,
  host: DeployHost,
): Promise<string> {
  const git = (args: string[]) =>
      required(host, "check", "git", ["-C", settings.worktree, ...args]),
    fail = (message: string): never => {
      throw new DeployError(message, "check");
    };

  if ((await git(["rev-parse", "--abbrev-ref", "HEAD"])) !== "main")
    fail("deploy runs only from a worktree on `main`");

  await git(["fetch", "--quiet", "origin", "main"]);
  const head = await git(["rev-parse", "HEAD"]),
    origin = await git(["rev-parse", "origin/main"]);
  if (head !== origin)
    fail(`\`main\` (${head}) differs from \`origin/main\` (${origin})`);

  if (await git(["status", "--porcelain", "--untracked-files=no"]))
    fail("the worktree has uncommitted changes to tracked files");

  const runs = await required(host, "check", "gh", [
    "run",
    "list",
    "--commit",
    head,
    "--workflow",
    "CI",
    "--json",
    "status,conclusion",
    "--limit",
    "1",
  ]);
  const latest = (
    JSON.parse(runs || "[]") as Array<{
      status?: unknown;
      conclusion?: unknown;
    }>
  )[0];
  if (latest?.status !== "completed" || latest.conclusion !== "success")
    fail(`GitHub CI has not succeeded for ${head}`);

  host.report(`running the Docker acceptance tests for ${head}\n`);
  const acceptance = await host.run("npm", ["run", "test:acceptance:docker"], {
    cwd: settings.worktree,
    timeoutMs: settings.stepTimeoutMs,
  });
  if (acceptance.code !== 0)
    fail(
      `the Docker acceptance tests failed or could not run\n${outputOf(acceptance)}`,
    );

  return head;
}

// ---------------------------------------------------------------------------
// Build

/** Install the release for `commit`, or reuse it when it is already installed. */
export async function buildRelease(
  settings: DeploySettings,
  host: DeployHost,
  commit: string,
): Promise<string> {
  const release = join(releasesDirectory(settings), commit);
  if (await exists(release)) {
    host.report(`reusing installed release ${commit}\n`);
    return release;
  }

  host.report(`building release ${commit}\n`);
  const staging = join(
      releasesDirectory(settings),
      `.staging-${commit}-${randomUUID()}`,
    ),
    source = join(staging, "source");
  await mkdir(source, { recursive: true });

  try {
    const tarball = join(staging, "source.tar");
    await required(host, "build", "git", [
      "-C",
      settings.worktree,
      "archive",
      "--format=tar",
      `--output=${tarball}`,
      commit,
    ]);
    await required(host, "build", "tar", ["-xf", tarball, "-C", source]);
    await required(host, "build", "npm", ["ci"], {
      cwd: source,
      timeoutMs: settings.stepTimeoutMs,
    });

    await writeFile(
      join(source, RELEASE_STAMP_PATH),
      `${JSON.stringify({ commit, deploymentFormat: CURRENT_DEPLOYMENT_FORMAT })}\n`,
    );

    const packed = await required(
      host,
      "build",
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", staging],
      { cwd: source },
    );
    const packageFile = join(staging, packed.split("\n").at(-1)!.trim());
    await required(host, "build", "tar", ["-xzf", packageFile, "-C", staging]);

    const installed = join(staging, "package");
    await cp(
      join(source, "package-lock.json"),
      join(installed, "package-lock.json"),
    );
    await required(
      host,
      "build",
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts"],
      { cwd: installed, timeoutMs: settings.stepTimeoutMs },
    );

    await rename(installed, release);
    return release;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Service

export function serviceUnit(settings: DeploySettings): string {
  return `[Unit]
Description=Integral server (${settings.deploymentHome})

[Service]
Type=simple
Environment=INTEGRAL_HOME=${settings.deploymentHome}
Environment="PATH=${settings.servicePath}"
ExecStart=${settings.nodeExecutable} ${integralBin(currentLink(settings))} server start
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=120

[Install]
WantedBy=default.target
`;
}

const systemctl = (host: DeployHost, step: string, ...args: string[]) =>
  required(host, step, "systemctl", ["--user", ...args]);

async function installService(
  settings: DeploySettings,
  host: DeployHost,
): Promise<void> {
  await mkdir(settings.systemdUnitDirectory, { recursive: true });
  await writeFile(
    join(settings.systemdUnitDirectory, unitName(settings)),
    serviceUnit(settings),
  );
  await systemctl(host, "start", "daemon-reload");
  await systemctl(host, "start", "enable", unitName(settings));
  host.report(`service ${unitName(settings)} is installed\n`);
}

async function serviceActive(
  settings: DeploySettings,
  host: DeployHost,
): Promise<boolean> {
  const result = await host.run("systemctl", [
    "--user",
    "is-active",
    "--quiet",
    unitName(settings),
  ]);
  return result.code === 0;
}

// ---------------------------------------------------------------------------
// Rehearse

/** Migrate and doctor a copy of the production deployment with the new release. */
export async function rehearseUpgrade(
  settings: DeploySettings,
  host: DeployHost,
  release: string,
): Promise<void> {
  const copy = join(
    rehearsalsDirectory(settings),
    `${timestamp(host.now())}-${basename(release)}`,
  );
  host.report(`rehearsing the upgrade on a copy at ${copy}\n`);

  const keep = (message: string): never => {
    throw new DeployError(
      `${message}\nthe rehearsal copy is kept at ${copy}`,
      "rehearse",
    );
  };

  try {
    await copyDeployment(settings.deploymentHome, copy);
  } catch (error) {
    keep(`copying the deployment failed: ${(error as Error).message}`);
  }

  for (const command of ["migrate", "doctor"]) {
    const result = await runIntegral(settings, host, release, copy, [command]);
    if (result.code !== 0)
      keep(
        `\`integral ${command}\` failed on the rehearsal copy\n${outputOf(result)}`,
      );
  }

  await rm(copy, { recursive: true, force: true });
}

/** Copy `config/` and `data/` except reinstallable downloads. */
async function copyDeployment(home: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });

  for (const part of ["config", "data"]) {
    const from = join(home, part);
    if (!(await exists(from))) continue;

    await cp(from, join(target, part), {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      filter: (source) =>
        part !== "data" ||
        relative(from, source).split(sep)[0] !== REINSTALLABLE_DATA,
    });
  }
}

/** Replace `config/` and `data/` with `backup`, keeping reinstallable downloads. */
async function restoreDeployment(home: string, backup: string): Promise<void> {
  await rm(join(home, "config"), { recursive: true, force: true });
  if (await exists(join(backup, "config")))
    await cp(join(backup, "config"), join(home, "config"), {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });

  const data = join(home, "data");
  await mkdir(data, { recursive: true });
  for (const entry of await readdir(data))
    if (entry !== REINSTALLABLE_DATA)
      await rm(join(data, entry), { recursive: true, force: true });

  if (await exists(join(backup, "data")))
    for (const entry of await readdir(join(backup, "data")))
      await cp(join(backup, "data", entry), join(data, entry), {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
}

// ---------------------------------------------------------------------------
// Stop and back up

async function drain(
  settings: DeploySettings,
  host: DeployHost,
  previous: string,
): Promise<void> {
  const deadline = host.now().getTime() + settings.drainTimeoutMs;

  for (;;) {
    const result = await runIntegral(
      settings,
      host,
      join(releasesDirectory(settings), previous),
      settings.deploymentHome,
      ["status", "--json"],
    );
    if (result.code !== 0) return;

    const status = JSON.parse(result.stdout) as {
      inFlight?: unknown;
      taskInFlight?: unknown;
    };
    if (!status.inFlight && !status.taskInFlight) return;

    if (host.now().getTime() >= deadline) {
      host.report(
        "work is still in flight after the drain timeout; stopping anyway (an interrupted message returns to the queue)\n",
      );
      return;
    }

    host.report("waiting for in-flight work to finish\n");
    await host.sleep(settings.pollIntervalMs);
  }
}

/** Refuse when integral is running for the deployment outside the service. */
async function requireOnlyServiceRunning(
  settings: DeploySettings,
  host: DeployHost,
): Promise<boolean> {
  const active = await serviceActive(settings, host);
  if (
    !active &&
    (await host.deploymentStatus(settings.deploymentHome)) !== "stopped"
  )
    throw new DeployError(
      `integral is running for ${settings.deploymentHome} but not as ${unitName(settings)}; stop that integral server first`,
      "stop",
    );
  return active;
}

async function stopService(
  settings: DeploySettings,
  host: DeployHost,
  step: string,
): Promise<void> {
  await systemctl(host, step, "stop", unitName(settings));
}

async function takeBackup(
  settings: DeploySettings,
  host: DeployHost,
  previous: string | null,
  label = previous ?? "none",
): Promise<string> {
  const backup = join(
    backupsDirectory(settings),
    `${timestamp(host.now())}-${label}`,
  );
  await copyDeployment(settings.deploymentHome, backup);

  const record: BackupRecord = {
    previousRelease: previous,
    deploymentFormat: await deploymentFormatOf(settings.deploymentHome),
    createdAt: host.now().toISOString(),
  };
  await writeFile(
    join(backup, "backup.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );

  const backups = (await readdir(backupsDirectory(settings))).sort();
  for (const old of backups.slice(0, -settings.backupsKept))
    await rm(join(backupsDirectory(settings), old), {
      recursive: true,
      force: true,
    });

  host.report(`backed up the deployment to ${backup}\n`);
  return backup;
}

// ---------------------------------------------------------------------------
// Activate and roll back

async function pointCurrentAt(
  settings: DeploySettings,
  release: string | null,
): Promise<void> {
  const link = currentLink(settings);
  if (!release) {
    await rm(link, { force: true });
    return;
  }

  const next = `${link}.${randomUUID()}`;
  await symlink(join("releases", release), next);
  await rename(next, link);
}

async function waitUntilHealthy(
  settings: DeploySettings,
  host: DeployHost,
): Promise<boolean> {
  const deadline = host.now().getTime() + settings.healthTimeoutMs;
  for (;;) {
    if ((await host.deploymentStatus(settings.deploymentHome)) === "healthy")
      return true;
    if (host.now().getTime() >= deadline) return false;
    await host.sleep(settings.pollIntervalMs);
  }
}

async function appendDeployLog(
  settings: DeploySettings,
  record: DeployLogRecord,
): Promise<void> {
  await mkdir(settings.releaseRoot, { recursive: true });
  await appendFile(deployLog(settings), `${JSON.stringify(record)}\n`);
}

export async function readDeployLog(
  settings: DeploySettings,
): Promise<DeployLogRecord[]> {
  const text = await readFile(deployLog(settings), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DeployLogRecord);
}

/** Restore `backup` and `previous`, then start the service if there is a previous release. */
async function restore(
  settings: DeploySettings,
  host: DeployHost,
  backup: string,
  previous: string | null,
): Promise<void> {
  // The service may never have been installed, so a failed stop is not fatal.
  await host.run("systemctl", ["--user", "stop", unitName(settings)]);
  await restoreDeployment(settings.deploymentHome, backup);
  await pointCurrentAt(settings, previous);
  if (previous) await systemctl(host, "rollback", "start", unitName(settings));
}

/** Run the whole deploy. Returns the process exit code. */
export async function deploy(
  settings: DeploySettings,
  host: DeployHost,
): Promise<number> {
  const startedAt = host.now().toISOString(),
    id = randomUUID();

  const commit = await checkReadyToDeploy(settings, host);
  const release = await buildRelease(settings, host, commit);
  await rehearseUpgrade(settings, host, release);

  const previous = await activeRelease(settings),
    previousFormat = await deploymentFormatOf(settings.deploymentHome);
  const wasActive = await requireOnlyServiceRunning(settings, host);
  if (wasActive && previous) await drain(settings, host, previous);
  if (wasActive) await stopService(settings, host, "stop");

  const backup = await takeBackup(settings, host, previous);
  const record = (
    result: DeployLogRecord["result"],
    failedStep?: string,
  ): DeployLogRecord => ({
    kind: "deploy",
    id,
    previousRelease: previous,
    release: commit,
    previousFormat,
    format: CURRENT_DEPLOYMENT_FORMAT,
    backup,
    startedAt,
    finishedAt: host.now().toISOString(),
    result,
    ...(failedStep ? { failedStep } : {}),
  });

  let step = "migrate";
  try {
    const migrated = await runIntegral(
      settings,
      host,
      release,
      settings.deploymentHome,
      ["migrate"],
    );
    if (migrated.code !== 0)
      throw new DeployError(
        `\`integral migrate\` failed\n${outputOf(migrated)}`,
        step,
      );

    step = "start";
    await pointCurrentAt(settings, commit);
    await installService(settings, host);
    await systemctl(host, step, "start", unitName(settings));

    step = "health";
    if (!(await waitUntilHealthy(settings, host)))
      throw new DeployError(
        `integral did not report healthy in time; see \`journalctl --user -u ${settings.serviceName}\``,
        step,
      );

    step = "doctor";
    const doctor = await runIntegral(
      settings,
      host,
      release,
      settings.deploymentHome,
      ["doctor"],
    );
    if (doctor.code !== 0)
      throw new DeployError(
        `\`integral doctor\` failed\n${outputOf(doctor)}`,
        step,
      );
  } catch (error) {
    host.report(`${(error as Error).message}\nrolling back\n`);
    try {
      await restore(settings, host, backup, previous);
    } catch (rollbackError) {
      await host
        .run("systemctl", ["--user", "stop", unitName(settings)])
        .catch(() => undefined);
      await appendDeployLog(settings, record("rollback-failed", step));
      host.report(
        `rollback failed: ${(rollbackError as Error).message}\nthe service is stopped; restore ${backup} and point ${currentLink(settings)} at release ${previous ?? "(none)"} by hand\n`,
      );
      return 1;
    }

    await appendDeployLog(settings, record("rolled-back", step));
    host.report(
      `deploy failed at ${step}; restored ${backup} and release ${previous ?? "(none)"}\n`,
    );
    return 1;
  }

  await appendDeployLog(settings, record("deployed"));
  host.report(`deployed release ${commit}\n`);
  return 0;
}

/** Undo the most recent deploy that has not been rolled back. */
export async function rollbackDeploy(
  settings: DeploySettings,
  host: DeployHost,
): Promise<number> {
  const startedAt = host.now().toISOString(),
    log = await readDeployLog(settings),
    undone = new Set(log.flatMap((entry) => entry.undoes ?? []));
  const target = log.findLast(
    (entry) =>
      entry.kind === "deploy" &&
      entry.result === "deployed" &&
      !undone.has(entry.id),
  );
  if (!target?.backup || !(await exists(target.backup)))
    throw new DeployError(
      "there is no retained backup from a successful deploy to roll back to",
      "rollback",
    );

  const current = await activeRelease(settings);
  if (await requireOnlyServiceRunning(settings, host))
    await stopService(settings, host, "rollback");
  const safety = await takeBackup(
    settings,
    host,
    current,
    `${current ?? "none"}-before-rollback`,
  );

  const formatBefore = await deploymentFormatOf(settings.deploymentHome);
  const record = (result: DeployLogRecord["result"]): DeployLogRecord => ({
    kind: "rollback",
    id: randomUUID(),
    undoes: target.id,
    previousRelease: current,
    release: target.previousRelease,
    previousFormat: formatBefore,
    format: target.previousFormat,
    backup: safety,
    startedAt,
    finishedAt: host.now().toISOString(),
    result,
  });

  await restore(settings, host, target.backup, target.previousRelease);
  const healthy =
    !target.previousRelease || (await waitUntilHealthy(settings, host));

  host.report(
    `restored the deployment from ${target.backup}; anything that changed since that deploy is not in the restored deployment (it is kept in ${safety})\n`,
  );
  await appendDeployLog(settings, record(healthy ? "rolled-back" : "failed"));
  if (!healthy)
    host.report("integral did not report healthy after the rollback\n");
  return healthy ? 0 : 1;
}

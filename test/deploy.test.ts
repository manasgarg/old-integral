import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  buildRelease,
  checkReadyToDeploy,
  deploy,
  DeployError,
  readDeployLog,
  rehearseUpgrade,
  rollbackDeploy,
  serviceUnit,
  type CommandOptions,
  type CommandResult,
  type DeployHost,
  type DeploySettings,
} from "../scripts/deploy.ts";
import { CURRENT_DEPLOYMENT_FORMAT } from "../src/stores/deployment-format.ts";
import { directorySnapshot } from "./helpers.ts";

const COMMIT = "1111111111111111111111111111111111111111";
const PREVIOUS = "0000000000000000000000000000000000000000";

interface Call {
  command: string;
  args: string[];
  options: CommandOptions;
}

type IntegralHandler = (
  release: string,
  home: string,
  args: string[],
) => Promise<CommandResult> | CommandResult;

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const failed = (stderr: string, code = 1): CommandResult => ({
  code,
  stdout: "",
  stderr,
});

/**
 * A deploy host that simulates git, gh, npm, tar, systemd and integral itself.
 * Each scenario changes the fields it cares about.
 */
class FakeDeployHost implements DeployHost {
  calls: Call[] = [];
  events: string[] = [];
  reports: string[] = [];
  branch = "main";
  head = COMMIT;
  origin = COMMIT;
  dirty = "";
  ci: unknown[] = [{ status: "completed", conclusion: "success" }];
  acceptance = ok();
  serviceActive = false;
  startResults: CommandResult[] = [];
  outsideServiceRunning = false;
  healthy = true;
  clock = Date.parse("2026-11-10T12:00:00.000Z");
  integral: IntegralHandler = (_release, home, args) =>
    args[0] === "migrate" ? migrateHome(home) : ok(statusJson(args));
  statusSequence: Array<{
    inFlight: string | null;
    taskInFlight: string | null;
  }> = [];

  constructor(readonly settings: DeploySettings) {}

  async run(
    command: string,
    args: string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({ command, args, options });

    if (command === this.settings.nodeExecutable) {
      const release = dirname(dirname(args[0]!)),
        rest = args.slice(1);
      this.events.push(`integral ${rest[0]}`);
      return this.integral(release, options.env?.INTEGRAL_HOME ?? "", rest);
    }

    if (command === "git") return this.git(args.slice(2));
    if (command === "gh") return ok(JSON.stringify(this.ci));
    if (command === "tar") return this.tar(args);
    if (command === "npm") return this.npm(args, options);
    if (command === "systemctl") return this.systemctl(args.slice(1));
    throw new Error(`unexpected command ${command}`);
  }

  async deploymentStatus(): Promise<"healthy" | "degraded" | "stopped"> {
    if (this.outsideServiceRunning) return "healthy";
    if (!this.serviceActive) return "stopped";
    return this.healthy ? "healthy" : "degraded";
  }

  async sleep(ms: number): Promise<void> {
    this.clock += ms;
  }

  now(): Date {
    this.clock += 1000;
    return new Date(this.clock);
  }

  report(line: string): void {
    this.reports.push(line);
  }

  private git(args: string[]): CommandResult {
    const [verb] = args;
    if (verb === "rev-parse" && args[1] === "--abbrev-ref")
      return ok(this.branch);
    if (verb === "rev-parse" && args[1] === "HEAD") return ok(this.head);
    if (verb === "rev-parse" && args[1] === "origin/main")
      return ok(this.origin);
    if (verb === "status") return ok(this.dirty);
    if (verb === "fetch") return ok();
    if (verb === "archive") {
      this.events.push(`git archive ${args.at(-1)}`);
      return ok();
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  }

  private async tar(args: string[]): Promise<CommandResult> {
    const target = args.at(-1)!;
    if (args[0] === "-xf") {
      await mkdir(join(target, "dist", "src"), { recursive: true });
      await writeFile(join(target, "package-lock.json"), "{}\n");
      return ok();
    }

    // Unpacking the packed tarball: the package is the export's shipped files.
    const source = join(target, "source"),
      installed = join(target, "package");
    await mkdir(join(installed, "bin"), { recursive: true });
    await mkdir(join(installed, "dist", "src"), { recursive: true });
    await writeFile(join(installed, "bin", "integral.js"), "// integral\n");
    await writeFile(
      join(installed, "dist", "src", "release.json"),
      await readFile(join(source, "dist", "src", "release.json")),
    );
    return ok();
  }

  private npm(args: string[], options: CommandOptions): CommandResult {
    this.events.push(`npm ${args.join(" ")} in ${basename(options.cwd ?? "")}`);
    if (args[0] === "run" && args[1] === "test:acceptance:docker")
      return this.acceptance;
    if (args[0] === "pack")
      return ok("npm notice\npirogram-integral-0.1.0.tgz\n");
    return ok();
  }

  private systemctl(args: string[]): CommandResult {
    this.events.push(`systemctl ${args.join(" ")}`);
    const [verb] = args;
    if (verb === "is-active") return this.serviceActive ? ok() : failed("", 3);
    if (verb === "stop") {
      this.serviceActive = false;
      return ok();
    }
    if (verb === "start") {
      const result = this.startResults.shift() ?? ok();
      if (result.code === 0) this.serviceActive = true;
      return result;
    }
    return ok();
  }
}

function statusJson(args: string[]): string {
  return args[0] === "status"
    ? JSON.stringify({ inFlight: null, taskInFlight: null })
    : "";
}

async function migrateHome(home: string): Promise<CommandResult> {
  await mkdir(join(home, "data"), { recursive: true });
  await writeFile(
    join(home, "data", "deployment-format.json"),
    JSON.stringify({
      format: CURRENT_DEPLOYMENT_FORMAT,
      release: COMMIT,
      writtenAt: "2026-11-10T12:00:00.000Z",
    }),
  );
  return ok("deployment is now at the current format\n");
}

async function scenario(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), "integral-deploy-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const settings: DeploySettings = {
    worktree: join(root, "worktree"),
    releaseRoot: join(root, "release-root"),
    deploymentHome: join(root, "home"),
    systemdUnitDirectory: join(root, "systemd"),
    serviceName: "integral",
    nodeExecutable: "/usr/bin/node-for-integral",
    drainTimeoutMs: 10_000,
    healthTimeoutMs: 10_000,
    stepTimeoutMs: 60_000,
    pollIntervalMs: 1_000,
    backupsKept: 3,
  };

  const home = settings.deploymentHome;
  await mkdir(join(home, "config"), { recursive: true });
  await mkdir(join(home, "data", "pi-runtime", "versions"), {
    recursive: true,
  });
  await mkdir(join(home, "data", "channels", "discord-1"), { recursive: true });
  await writeFile(join(home, "config", "integral.toml"), "# config\n");
  await writeFile(join(home, "data", "queue.json"), '{"items":[]}\n');
  await writeFile(
    join(home, "data", "channels", "discord-1", "queue.json"),
    "{}\n",
  );
  await writeFile(
    join(home, "data", "pi-runtime", "versions", "big.bin"),
    "reinstallable",
  );

  return { settings, host: new FakeDeployHost(settings) };
}

/** Pretend an earlier deploy installed `PREVIOUS` and the service runs it. */
async function withPreviousRelease(
  settings: DeploySettings,
  host: FakeDeployHost,
): Promise<void> {
  const release = join(settings.releaseRoot, "releases", PREVIOUS);
  await mkdir(join(release, "bin"), { recursive: true });
  await writeFile(join(release, "bin", "integral.js"), "// previous\n");
  const { symlink } = await import("node:fs/promises");
  await symlink(
    join("releases", PREVIOUS),
    join(settings.releaseRoot, "current"),
  );
  host.serviceActive = true;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/* @covers UPGRADE-43A028B5
Given the developer runs `npm run deploy` from a repository worktree
	When the worktree is not on `main`
		Or `main` differs from `origin/main`
		Or the worktree has uncommitted changes to tracked files
		Or GitHub CI has not succeeded for that commit
		Then deploy stops before building anything
			And says which check failed
			And leaves the running release and the deployment unchanged
	When every check passes
		Then deploy runs the Docker acceptance profile against that commit
			And stops without changing the running release or the deployment if any acceptance test fails or cannot run
*/
test("[UPGRADE-43A028B5] deploy refuses anything but a clean, pushed, CI-green, accepted main", async (t) => {
  const cases: Array<[string, (host: FakeDeployHost) => void, RegExp]> = [
    ["branch", (h) => (h.branch = "feature"), /only from a worktree on `main`/],
    ["behind", (h) => (h.origin = PREVIOUS), /differs from `origin\/main`/],
    ["dirty", (h) => (h.dirty = " M src/cli/main.ts"), /uncommitted changes/],
    [
      "ci",
      (h) => (h.ci = [{ status: "completed", conclusion: "failure" }]),
      /CI has not succeeded/,
    ],
    ["no-ci", (h) => (h.ci = []), /CI has not succeeded/],
    [
      "acceptance",
      (h) => (h.acceptance = failed("docker unavailable")),
      /acceptance tests failed or could not run\ndocker unavailable/,
    ],
  ];

  for (const [name, change, message] of cases) {
    const { settings, host } = await scenario(t);
    const before = await directorySnapshot(settings.deploymentHome);
    change(host);

    await assert.rejects(deploy(settings, host), (error: unknown) => {
      assert.ok(error instanceof DeployError, name);
      assert.equal(error.step, "check", name);
      assert.match(error.message, message, name);
      return true;
    });
    assert.equal(
      await exists(join(settings.releaseRoot, "releases")),
      false,
      name,
    );
    assert.equal(
      host.events.some((event) => event.startsWith("systemctl")),
      false,
      name,
    );
    assert.deepEqual(
      await directorySnapshot(settings.deploymentHome),
      before,
      name,
    );
    if (name !== "acceptance")
      assert.equal(
        host.events.includes("npm run test:acceptance:docker in worktree"),
        false,
        name,
      );
  }

  const { settings, host } = await scenario(t);
  assert.equal(await checkReadyToDeploy(settings, host), COMMIT);
  assert.ok(host.events.includes("npm run test:acceptance:docker in worktree"));
});

/* @covers UPGRADE-A9D593DA
Given the commit passed the deploy checks
	When deploy builds the release
		Then it builds from a clean export of that commit, never from the developer's worktree
			And stamps the release with the commit SHA and the current format
			And packs it with `npm pack`
			And installs the package with production dependencies into `<release-root>/releases/<sha>/`
			And never changes a release directory after it is installed
	When `<release-root>/releases/<sha>/` already exists
		Then deploy reuses it without rebuilding
*/
test("[UPGRADE-A9D593DA] deploy builds an immutable release from a clean export of the commit", async (t) => {
  const { settings, host } = await scenario(t);
  const release = await buildRelease(settings, host, COMMIT);

  assert.equal(release, join(settings.releaseRoot, "releases", COMMIT));
  assert.ok(host.events.includes(`git archive ${COMMIT}`));
  assert.ok(host.events.includes("npm ci in source"));
  assert.equal(
    host.calls.some((call) => call.options.cwd === settings.worktree),
    false,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(release, "dist", "src", "release.json"), "utf8"),
    ),
    { commit: COMMIT, deploymentFormat: CURRENT_DEPLOYMENT_FORMAT },
  );
  assert.ok(host.events.some((event) => event.startsWith("npm pack ")));
  assert.ok(
    host.events.includes("npm ci --omit=dev --ignore-scripts in package"),
  );
  assert.ok(await exists(join(release, "bin", "integral.js")));
  assert.deepEqual(
    (await readdir(join(settings.releaseRoot, "releases"))).sort(),
    [COMMIT],
  );

  const installed = await directorySnapshot(release);
  host.events = [];
  assert.equal(await buildRelease(settings, host, COMMIT), release);
  assert.deepEqual(host.events, []);
  assert.deepEqual(await directorySnapshot(release), installed);
});

/* @covers UPGRADE-1F1E078F
Given deploy has installed a release
	When deploy sets up the service
		Then it writes a systemd user unit named `integral.service`
			And the unit runs `<release-root>/current/bin/integral.js server start`
			And the unit sets `INTEGRAL_HOME` to the production deployment home
			And deploy reloads systemd before starting the service
	When the integral server exits unexpectedly
		Then systemd starts it again
	When the user logs in after the machine restarts
		Then systemd starts the integral server
	When the integral server writes output
		Then the user can read it with `journalctl --user -u integral`
*/
test("[UPGRADE-1F1E078F] deploy runs the production release as an enabled systemd user service", async (t) => {
  const { settings, host } = await scenario(t);
  assert.equal(await deploy(settings, host), 0);

  const unit = await readFile(
    join(settings.systemdUnitDirectory, "integral.service"),
    "utf8",
  );
  assert.equal(unit, serviceUnit(settings));
  assert.match(
    unit,
    new RegExp(
      `^ExecStart=${settings.nodeExecutable} ${join(settings.releaseRoot, "current", "bin", "integral.js")} server start$`,
      "m",
    ),
  );
  assert.match(
    unit,
    new RegExp(`^Environment=INTEGRAL_HOME=${settings.deploymentHome}$`, "m"),
  );
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(unit, /StandardOutput|StandardError/);

  const reload = host.events.indexOf("systemctl daemon-reload"),
    enable = host.events.indexOf("systemctl enable integral.service"),
    start = host.events.indexOf("systemctl start integral.service");
  assert.ok(reload >= 0 && enable > reload && start > enable);
  assert.ok(host.reports.some((line) => line.includes("integral.service")));
});

/* @covers UPGRADE-E93D63FA
Given the new release is installed
	When deploy rehearses the upgrade
		Then it copies the production deployment's `config/` and `data/` into a temporary deployment home under `<release-root>/rehearsals/`
			And leaves out `data/pi-runtime/`, which integral reinstalls when it is missing
			And runs the new release's `integral migrate` against the copy
			And then runs the new release's `integral doctor` against the copy
			And does this while the running release keeps serving
	When the copy completes
		And `integral migrate` exits successfully
		And `integral doctor` exits successfully
		Then the rehearsal succeeded
			And deploy removes the copy
	When the copy fails
		Or `integral migrate` exits unsuccessfully
		Or `integral doctor` exits unsuccessfully
		Or a step runs longer than its bounded timeout
		Then the rehearsal failed
			And deploy stops before touching the running release or the deployment
			And reports the failed step with its output
			And keeps the copy for inspection and names its path
*/
test("[UPGRADE-E93D63FA] deploy rehearses migrate and doctor on a copy and stops when either fails", async (t) => {
  const { settings, host } = await scenario(t);
  const release = await buildRelease(settings, host, COMMIT);
  const seen: Array<{
    home: string;
    command: string;
    piRuntime: boolean;
    config: boolean;
  }> = [];
  host.integral = async (_release, home, args) => {
    seen.push({
      home,
      command: args[0]!,
      piRuntime: await exists(join(home, "data", "pi-runtime")),
      config: await exists(join(home, "config", "integral.toml")),
    });
    return args[0] === "migrate" ? migrateHome(home) : ok();
  };
  host.events = [];

  await rehearseUpgrade(settings, host, release);
  assert.deepEqual(
    seen.map((entry) => entry.command),
    ["migrate", "doctor"],
  );
  for (const entry of seen) {
    assert.equal(dirname(entry.home), join(settings.releaseRoot, "rehearsals"));
    assert.equal(entry.piRuntime, false);
    assert.equal(entry.config, true);
  }
  assert.equal(await exists(seen[0]!.home), false);
  assert.equal(
    host.events.some((event) => event.startsWith("systemctl")),
    false,
  );
  assert.ok(
    host.calls
      .filter((call) => call.command === settings.nodeExecutable)
      .every((call) => call.options.timeoutMs === settings.stepTimeoutMs),
  );

  const failures: Array<[string, IntegralHandler | undefined, RegExp]> = [
    [
      "migrate",
      (_r, h, a) =>
        a[0] === "migrate" ? failed("migration 0002 failed") : migrateHome(h),
      /`integral migrate` failed on the rehearsal copy\nmigration 0002 failed/,
    ],
    [
      "doctor",
      (_r, h, a) =>
        a[0] === "migrate"
          ? migrateHome(h)
          : { code: 1, stdout: "problem: message queue: bad", stderr: "" },
      /`integral doctor` failed on the rehearsal copy\nproblem: message queue: bad/,
    ],
    [
      "timeout",
      (_r, _h, a) =>
        a[0] === "migrate"
          ? failed("stopped by SIGTERM (timed out?)", -1)
          : ok(),
      /timed out/,
    ],
    ["copy", undefined, /copying the deployment failed/],
  ];

  for (const [name, handler, message] of failures) {
    const { settings: s, host: h } = await scenario(t);
    const before = await directorySnapshot(s.deploymentHome);
    const built = await buildRelease(s, h, COMMIT);
    if (handler) h.integral = handler;
    else await chmod(join(s.deploymentHome, "data", "queue.json"), 0o000);

    await assert.rejects(rehearseUpgrade(s, h, built), (error: unknown) => {
      assert.ok(error instanceof DeployError, name);
      assert.equal(error.step, "rehearse", name);
      assert.match(error.message, message, name);
      const kept = /kept at (.+)$/.exec(error.message)?.[1];
      assert.ok(kept, name);
      return true;
    });
    const kept = await readdir(join(s.releaseRoot, "rehearsals"));
    assert.equal(kept.length, 1, name);

    h.events = [];
    await assert.rejects(deploy(s, h), { step: "rehearse" });
    assert.equal(
      h.events.some((event) => event.startsWith("systemctl")),
      false,
      name,
    );
    assert.equal(await exists(join(s.releaseRoot, "backups")), false, name);

    await chmod(join(s.deploymentHome, "data", "queue.json"), 0o600);
    assert.deepEqual(await directorySnapshot(s.deploymentHome), before, name);
  }
});

/* @covers UPGRADE-6C26AF47
Given the rehearsal succeeded
	When integral is running for the deployment but not as the systemd service
		Then deploy stops before changing anything
			And asks the developer to stop that integral server first
	When deploy stops the running release
		Then it first waits for the message queue and task queue to have no in-flight work, up to a bounded drain timeout
			And then stops the service
			And relies on clean shutdown to return any interrupted in-flight message to the queue
	When the service has stopped
		Then deploy copies the deployment's `config/` and `data/` into `<release-root>/backups/<time>-<previous-sha>/`
			And leaves out `data/pi-runtime/`, which integral reinstalls when it is missing
			And records the previous release and deployment format with the backup
			And keeps the three most recent backups
			And does not migrate until the backup is complete
*/
test("[UPGRADE-6C26AF47] deploy drains, stops, and backs up before it migrates", async (t) => {
  const outside = await scenario(t);
  outside.host.outsideServiceRunning = true;
  const outsideBefore = await directorySnapshot(
    outside.settings.deploymentHome,
  );
  await assert.rejects(
    deploy(outside.settings, outside.host),
    (error: unknown) => {
      assert.ok(error instanceof DeployError);
      assert.equal(error.step, "stop");
      assert.match(
        error.message,
        /running .* but not as integral\.service; stop that integral server first/,
      );
      return true;
    },
  );
  assert.equal(
    await exists(join(outside.settings.releaseRoot, "backups")),
    false,
  );
  assert.deepEqual(
    await directorySnapshot(outside.settings.deploymentHome),
    outsideBefore,
  );
  assert.equal(
    outside.host.events.includes("systemctl stop integral.service"),
    false,
  );

  const { settings, host } = await scenario(t);
  await withPreviousRelease(settings, host);
  host.statusSequence = [
    { inFlight: "message-1", taskInFlight: null },
    { inFlight: null, taskInFlight: "task-1" },
    { inFlight: null, taskInFlight: null },
  ];
  const sleeps: number[] = [];
  const sleep = host.sleep.bind(host);
  host.sleep = async (ms) => {
    sleeps.push(ms);
    await sleep(ms);
  };
  const drainedWith: string[] = [];
  host.integral = (release, home, args) => {
    if (args[0] === "status") {
      drainedWith.push(basename(release));
      return ok(
        JSON.stringify(
          host.statusSequence.shift() ?? { inFlight: null, taskInFlight: null },
        ),
      );
    }
    return args[0] === "migrate" ? migrateHome(home) : ok();
  };

  assert.equal(await deploy(settings, host), 0);
  assert.deepEqual(drainedWith, [PREVIOUS, PREVIOUS, PREVIOUS]);
  assert.equal(sleeps.length, 2);
  const firstMigrate = host.events.indexOf(
    "integral migrate",
    host.events.indexOf("systemctl stop integral.service"),
  );
  assert.deepEqual(
    host.events
      .slice(0, firstMigrate + 1)
      .filter((event) =>
        [
          "integral status",
          "systemctl stop integral.service",
          "integral migrate",
        ].includes(event),
      ),
    [
      "integral migrate",
      "integral status",
      "integral status",
      "integral status",
      "systemctl stop integral.service",
      "integral migrate",
    ],
  );
  const firstBackup = (
    await readdir(join(settings.releaseRoot, "backups"))
  )[0]!;
  assert.ok(firstBackup.endsWith(`-${PREVIOUS}`));

  for (let deployment = 0; deployment < 3; deployment++)
    assert.equal(await deploy(settings, host), 0);

  const backups = (await readdir(join(settings.releaseRoot, "backups"))).sort();
  assert.equal(backups.length, 3);
  const latest = join(settings.releaseRoot, "backups", backups.at(-1)!);
  assert.ok(backups[0]!.endsWith(`-${COMMIT}`));
  assert.ok(await exists(join(latest, "config", "integral.toml")));
  assert.ok(
    await exists(join(latest, "data", "channels", "discord-1", "queue.json")),
  );
  assert.equal(await exists(join(latest, "data", "pi-runtime")), false);
  const record = JSON.parse(
    await readFile(join(latest, "backup.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(record.previousRelease, COMMIT);
  assert.equal(record.deploymentFormat, CURRENT_DEPLOYMENT_FORMAT);

  const slow = await scenario(t);
  await withPreviousRelease(slow.settings, slow.host);
  slow.host.integral = (_release, home, args) =>
    args[0] === "status"
      ? ok(JSON.stringify({ inFlight: "stuck", taskInFlight: null }))
      : args[0] === "migrate"
        ? migrateHome(home)
        : ok();
  assert.equal(await deploy(slow.settings, slow.host), 0);
  assert.ok(
    slow.host.reports.some((line) =>
      /still in flight after the drain timeout; stopping anyway \(an interrupted message returns to the queue\)/.test(
        line,
      ),
    ),
  );
  assert.ok(slow.host.events.includes("systemctl stop integral.service"));
});

/* @covers UPGRADE-03673EA9
Given the deployment is stopped and backed up
	When deploy activates the new release
		Then it runs the new release's `integral migrate` against the deployment
			And points `<release-root>/current` at the new release atomically
			And starts the service
			And waits, up to a bounded timeout, for `integral status` to report every component healthy
			And runs `integral doctor`
			And appends a record to `<release-root>/deploy-log.jsonl` with both releases, both formats, the backup, the times, and the result
			And reports success
*/
test("[UPGRADE-03673EA9] deploy migrates, switches, starts, checks health and doctor, and logs the result", async (t) => {
  const { settings, host } = await scenario(t);
  await withPreviousRelease(settings, host);
  const healthChecks: string[] = [];
  const status = host.deploymentStatus.bind(host);
  host.deploymentStatus = async () => {
    const result = await status();
    healthChecks.push(result);
    return result;
  };

  assert.equal(await deploy(settings, host), 0);

  const live = host.events.slice(
    host.events.lastIndexOf("systemctl stop integral.service"),
  );
  assert.deepEqual(
    live.filter((event) =>
      /^integral (migrate|doctor)$|^systemctl start/.test(event),
    ),
    ["integral migrate", "systemctl start integral.service", "integral doctor"],
  );
  assert.equal(
    await readlink(join(settings.releaseRoot, "current")),
    join("releases", COMMIT),
  );
  assert.equal(healthChecks.at(-1), "healthy");

  const [record] = await readDeployLog(settings);
  assert.equal(record?.kind, "deploy");
  assert.equal(record?.previousRelease, PREVIOUS);
  assert.equal(record?.release, COMMIT);
  assert.equal(record?.previousFormat, 0);
  assert.equal(record?.format, CURRENT_DEPLOYMENT_FORMAT);
  assert.ok(record?.backup?.startsWith(join(settings.releaseRoot, "backups")));
  assert.ok(record?.startedAt && record.finishedAt);
  assert.equal(record?.result, "deployed");
  assert.ok(
    host.reports.some((line) => line === `deployed release ${COMMIT}\n`),
  );
});

/* @covers UPGRADE-7F1EFAD0
Given deploy has stopped the previous release
	When the migration, the service start, the health wait, or the doctor check fails
		Then deploy stops the service
			And replaces the deployment's `config/` and `data/` with the backup
			And keeps the deployment's `data/pi-runtime/`
			And points `<release-root>/current` back at the previous release
			And starts the service
			And records the failure and the rollback in `<release-root>/deploy-log.jsonl`
			And exits unsuccessfully naming the step that failed
	When the rollback itself fails
		Then deploy leaves the service stopped
			And names the backup and the previous release so the developer can restore them by hand
*/
test("[UPGRADE-7F1EFAD0] a failed activation restores the backup and the previous release", async (t) => {
  const failures: Array<[string, (host: FakeDeployHost) => void]> = [
    [
      "migrate",
      (h) =>
        (h.integral = async (_r, home, a) => {
          if (a[0] !== "migrate") return ok(statusJson(a));
          if (home !== h.settings.deploymentHome) return migrateHome(home);
          await writeFile(join(home, "data", "queue.json"), "half-migrated");
          return failed("migration failed");
        }),
    ],
    ["start", (h) => (h.startResults = [failed("unit failed")])],
    ["health", (h) => (h.healthy = false)],
    [
      "doctor",
      (h) =>
        (h.integral = (_r, home, a) =>
          a[0] === "migrate"
            ? migrateHome(home)
            : a[0] === "doctor" && home === h.settings.deploymentHome
              ? failed("problem: approvals")
              : ok(statusJson(a))),
    ],
  ];

  for (const [step, breakIt] of failures) {
    const { settings, host } = await scenario(t);
    await withPreviousRelease(settings, host);
    const before = await directorySnapshot(
      join(settings.deploymentHome, "config"),
    );
    const dataBefore = await directorySnapshot(
      join(settings.deploymentHome, "data"),
    );
    breakIt(host);

    assert.equal(await deploy(settings, host), 1, step);

    assert.deepEqual(
      await directorySnapshot(join(settings.deploymentHome, "config")),
      before,
      step,
    );
    assert.deepEqual(
      await directorySnapshot(join(settings.deploymentHome, "data")),
      dataBefore,
      step,
    );
    assert.ok(
      await exists(
        join(
          settings.deploymentHome,
          "data",
          "pi-runtime",
          "versions",
          "big.bin",
        ),
      ),
      step,
    );
    assert.equal(
      await readlink(join(settings.releaseRoot, "current")),
      join("releases", PREVIOUS),
      step,
    );
    const tail = host.events.slice(
      host.events.lastIndexOf("systemctl stop integral.service"),
    );
    assert.ok(tail.includes("systemctl start integral.service"), step);
    assert.equal(host.serviceActive, true, step);
    const record = (await readDeployLog(settings)).at(-1);
    assert.equal(record?.result, "rolled-back", step);
    assert.equal(record?.failedStep, step, step);
    assert.ok(
      host.reports.some((line) => line.includes(`deploy failed at ${step}`)),
      step,
    );
  }

  const { settings, host } = await scenario(t);
  await withPreviousRelease(settings, host);
  host.healthy = false;
  host.startResults = [ok(), failed("cannot start the previous release")];
  assert.equal(await deploy(settings, host), 1);
  assert.equal(host.serviceActive, false);
  assert.equal(
    (await readDeployLog(settings)).at(-1)?.result,
    "rollback-failed",
  );
  const message = host.reports.join("");
  assert.match(message, /rollback failed/);
  assert.match(
    message,
    new RegExp(`restore ${join(settings.releaseRoot, "backups")}`),
  );
  assert.match(message, new RegExp(`release ${PREVIOUS}`));
});

/* @covers UPGRADE-25417B4B
Given a deploy succeeded and its backup is retained
	When the developer runs `npm run deploy -- --rollback`
		Then deploy stops the service
			And copies the current `config/` and `data/` into a new backup first
			And restores the backup taken before the most recent deploy
			And points `<release-root>/current` at the release recorded with that backup
			And starts the service and waits for it to report healthy
			And warns that changes made since that deploy are not in the restored deployment
			And records the rollback in `<release-root>/deploy-log.jsonl`
*/
test("[UPGRADE-25417B4B] rollback restores the backup and release from before the latest deploy", async (t) => {
  const { settings, host } = await scenario(t);
  await withPreviousRelease(settings, host);
  const beforeDeploy = await directorySnapshot(
    join(settings.deploymentHome, "data"),
  );
  assert.equal(await deploy(settings, host), 0);
  const deployed = (await readDeployLog(settings))[0]!;

  await writeFile(
    join(settings.deploymentHome, "data", "queue.json"),
    "changed after deploy",
  );
  host.events = [];

  assert.equal(await rollbackDeploy(settings, host), 0);

  assert.equal(host.events[0], "systemctl is-active --quiet integral.service");
  assert.ok(host.events.includes("systemctl stop integral.service"));
  const backups = await readdir(join(settings.releaseRoot, "backups"));
  const safety = backups.find((name) =>
    name.endsWith(`${COMMIT}-before-rollback`),
  );
  assert.ok(safety);
  assert.equal(
    await readFile(
      join(settings.releaseRoot, "backups", safety, "data", "queue.json"),
      "utf8",
    ),
    "changed after deploy",
  );
  const restored = await directorySnapshot(
    join(settings.deploymentHome, "data"),
  );
  delete restored["deployment-format.json"];
  delete beforeDeploy["deployment-format.json"];
  assert.deepEqual(restored, beforeDeploy);
  assert.equal(
    await readlink(join(settings.releaseRoot, "current")),
    join("releases", PREVIOUS),
  );
  assert.equal(host.serviceActive, true);
  assert.match(
    host.reports.join(""),
    /anything that changed since that deploy is not in the restored deployment/,
  );

  const rollback = (await readDeployLog(settings)).at(-1);
  assert.equal(rollback?.kind, "rollback");
  assert.equal(rollback?.undoes, deployed.id);
  assert.equal(rollback?.release, PREVIOUS);
  assert.equal(rollback?.result, "rolled-back");

  await assert.rejects(rollbackDeploy(settings, host), /no retained backup/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildContainerSpec,
  createLockedNetwork,
  dockerNetworkGateway,
  dockerRunArgs,
  freshSessionHome,
  newSessionIdentity,
} from "../../src/integrations/docker/pi-container.ts";
import { writeWebExtension } from "../../src/integrations/pi/session-extensions.ts";
import { ensureReleasePiImage } from "../../src/integrations/docker/managed-image.ts";
import { loadConfig } from "../../src/stores/config.ts";
import { validateConnection } from "../../src/stores/connection-store.ts";
import { deploymentId } from "../../src/platform/component-identity.ts";
import { fixture } from "../helpers.ts";
import { ensurePiRuntime } from "../../src/integrations/pi/host-runtime.ts";
import { PI_VERSION } from "../../src/platform/constants.ts";

/* @covers WEB-65AA5DDC
Given an authenticated Pi session uses `web_search` or `fetch_pages`
	When software in the container attempts to bypass the gateway
		Then the locked network still prevents direct external access
*/
test("[BOX-601613D4] [GATEWAY-EC79406A] [RUN-01CA16F2] [RUN-79BACB0C] [WEB-2ED07A71] [WEB-65AA5DDC] live Pi container exposes web tools while enforcing the declared identity, mounts, resources, and internal network", async (t) => {
  assert.doesNotThrow(
    () => execFileSync("docker", ["info"], { stdio: "ignore" }),
    "Docker acceptance requires a reachable Docker daemon",
  );
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    network = `integral-acceptance-${deploymentId(paths)}`,
    sessionHome = await freshSessionHome(paths.root),
    historyArchive = join(paths.root, "runs"),
    currentRun = join(historyArchive, "current-run"),
    caCert = join(paths.root, "ca.pem"),
    caBundle = join(paths.root, "bundle.pem");
  await mkdir(join(sessionHome, ".integral"), { recursive: true });
  await mkdir(join(sessionHome, ".pi", "agent"), { recursive: true });
  await writeFile(join(sessionHome, ".integral", "auth.json"), "{}\n");
  await writeWebExtension(sessionHome);
  await mkdir(currentRun, { recursive: true });
  await writeFile(
    join(historyArchive, "index.json"),
    '{"runs":[{"runId":"current-run","status":"running"}]}\n',
  );
  await writeFile(join(currentRun, "run.json"), '{"status":"running"}\n');
  await writeFile(caCert, "acceptance CA fixture\n");
  await writeFile(caBundle, "acceptance CA fixture\n");
  const image = ensureReleasePiImage();
  await createLockedNetwork(network);
  const identity = newSessionIdentity(),
    spec = buildContainerSpec({
      config,
      selectedModel: "claude-sonnet-4-6",
      image,
      gatewayUrl: "http://host.integral.internal:7310",
      gatewayAddress: dockerNetworkGateway(network),
      caCert,
      caBundle,
      sessionHome,
      historyArchive,
      currentRun,
      ...identity,
      model: validateConnection({
        name: "acceptance-model",
        kind: "model",
        provider: "anthropic",
        auth: "key",
      }),
      mcp: [],
    }),
    name = `integral-${identity.sessionId}`,
    runArgs = dockerRunArgs(spec, config, network),
    imageIndex = runArgs.indexOf(spec.image),
    createArgs = runArgs
      .slice(0, imageIndex + 1)
      .filter((argument) => argument !== "--rm");
  createArgs[0] = "create";
  createArgs.push("node", "-e", "setInterval(() => undefined, 60_000)");
  t.after(() => {
    try {
      execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
    } catch {
      /* container did not reach creation */
    }
    try {
      execFileSync("docker", ["network", "rm", network], {
        stdio: "ignore",
      });
    } catch {
      /* network did not reach creation */
    }
  });
  execFileSync("docker", createArgs);
  execFileSync("docker", ["start", name], { stdio: "ignore" });
  assert.deepEqual(
    JSON.parse(
      execFileSync(
        "docker",
        [
          "exec",
          name,
          "node",
          "--input-type=module",
          "--eval",
          `const tools=[]; const extension=(await import("file:///home/pi/.integral/extensions/integral-web.mjs")).default; extension({registerTool(tool){tools.push(tool.name)}}); process.stdout.write(JSON.stringify(tools));`,
        ],
        { encoding: "utf8" },
      ),
    ),
    ["web_search", "fetch_pages"],
  );
  const sessionOwner = (await stat(sessionHome)).uid;
  assert.equal(
    (await stat(join(sessionHome, "history", "runs"))).uid,
    sessionOwner,
  );
  assert.equal(
    (await stat(join(sessionHome, "history", "current"))).uid,
    sessionOwner,
  );
  const inspection = JSON.parse(
    execFileSync("docker", ["inspect", name], {
      encoding: "utf8",
    }),
  )[0] as {
    Config: { User: string; Env: string[]; OpenStdin: boolean };
    HostConfig: {
      ReadonlyRootfs: boolean;
      CapDrop: string[];
      Memory: number;
      NetworkMode: string;
      Tmpfs: Record<string, string>;
      SecurityOpt: string[];
    };
    Mounts: { Source: string; Destination: string; RW: boolean }[];
  };
  assert.equal(inspection.Config.User, "1000:1000");
  assert.equal(inspection.Config.OpenStdin, true);
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
  assert.equal(
    inspection.HostConfig.Memory,
    config.runner.memoryMb * 1024 ** 2,
  );
  assert.equal(inspection.HostConfig.NetworkMode, network);
  assert.match(inspection.HostConfig.Tmpfs["/tmp"] ?? "", /noexec/);
  assert.ok(
    inspection.HostConfig.SecurityOpt.some((value) =>
      value.includes("no-new-privileges"),
    ),
  );
  assert.doesNotMatch(inspection.Config.Env.join("\n"), /acceptance-secret/);
  assert.equal(
    inspection.Mounts.some((mount) => mount.Source === process.cwd()),
    false,
  );
  assert.equal(
    inspection.Mounts.find(
      (mount) => mount.Destination === "/home/pi/history/runs",
    )?.RW,
    false,
  );
  assert.equal(
    inspection.Mounts.find(
      (mount) => mount.Destination === "/home/pi/history/current",
    )?.RW,
    false,
  );
  assert.doesNotThrow(() =>
    execFileSync(
      "docker",
      [
        "exec",
        name,
        "node",
        "-e",
        `require("node:fs").readFileSync("/home/pi/history/runs/index.json"); try { require("node:fs").writeFileSync("/home/pi/history/runs/change", "bad"); process.exit(1); } catch (error) { process.exit(error.code === "EROFS" || error.code === "EACCES" ? 0 : 2); }`,
      ],
      { stdio: "ignore" },
    ),
  );
  await writeFile(
    join(currentRun, "run.json"),
    '{"status":"finalized","termination":"completed"}\n',
  );
  const laterRun = join(historyArchive, "later-run");
  await mkdir(laterRun);
  await writeFile(
    join(laterRun, "run.json"),
    '{"runId":"later-run","status":"finalized","termination":"failed"}\n',
  );
  await writeFile(join(laterRun, "activity.jsonl"), '{"type":"failure"}\n');
  await writeFile(join(laterRun, "signals.json"), '{"outcome":"failed"}\n');
  await writeFile(
    join(historyArchive, "index.json"),
    '{"runs":[{"runId":"current-run","status":"finalized"},{"runId":"later-run","status":"finalized"}]}\n',
  );
  assert.equal(
    execFileSync(
      "docker",
      [
        "exec",
        name,
        "node",
        "-e",
        `process.stdout.write(require("node:fs").readFileSync("/home/pi/history/runs/later-run/run.json", "utf8"))`,
      ],
      { encoding: "utf8" },
    ),
    '{"runId":"later-run","status":"finalized","termination":"failed"}\n',
  );
  assert.equal(
    execFileSync(
      "docker",
      [
        "exec",
        name,
        "node",
        "-e",
        `process.stdout.write(require("node:fs").readFileSync("/home/pi/history/current/run.json", "utf8"))`,
      ],
      { encoding: "utf8" },
    ),
    '{"status":"finalized","termination":"completed"}\n',
  );
  assert.doesNotThrow(
    () =>
      execFileSync(
        "docker",
        [
          "exec",
          name,
          "node",
          "-e",
          `for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[key]; fetch("http://1.1.1.1", { signal: AbortSignal.timeout(1000) }).then(() => process.exit(1), () => process.exit(0));`,
        ],
        { stdio: "ignore", timeout: 5_000 },
      ),
    "an internal-network container must not have a direct route to the internet",
  );
});

test("[BOX-E1F472A1] managed Pi image exposes its model catalog through integral's JSON bridge", async () => {
  assert.doesNotThrow(
    () => execFileSync("docker", ["info"], { stdio: "ignore" }),
    "Docker acceptance requires a reachable Docker daemon",
  );
  const image = ensureReleasePiImage(),
    output = execFileSync(
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
    ),
    catalog = JSON.parse(output) as Array<{
      provider?: unknown;
      model?: unknown;
    }>;
  assert.ok(
    catalog.some(
      (entry) =>
        entry.provider === "openai-codex" &&
        typeof entry.model === "string" &&
        entry.model.startsWith("gpt-"),
    ),
  );
});

test("[CONNECTION-12C87631] managed Pi image includes Git and GitHub clients", async () => {
  assert.doesNotThrow(
    () => execFileSync("docker", ["info"], { stdio: "ignore" }),
    "Docker acceptance requires a reachable Docker daemon",
  );
  const image = ensureReleasePiImage();
  for (const command of [
    ["git", "--version"],
    ["gh", "--version"],
  ])
    assert.doesNotThrow(() =>
      execFileSync(
        "docker",
        ["run", "--rm", "--network", "none", image, ...command],
        {
          stdio: "ignore",
        },
      ),
    );
});

/* @covers BOX-E1F472A1
Given the integral release ships the Dockerfile for its Pi image
	When integral needs the Pi image
		Then it uses the image built from the release's Dockerfile
			And builds that image only when it is not present locally
*/
test("[BOX-E1F472A1] the release's Pi image contains exactly the pinned Pi release", async (t) => {
  assert.doesNotThrow(
    () => execFileSync("docker", ["info"], { stdio: "ignore" }),
    "Docker acceptance requires a reachable Docker daemon",
  );
  const paths = await fixture(t),
    runtime = await ensurePiRuntime(paths),
    image = ensureReleasePiImage(),
    piVersion = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        image,
        "node",
        "-e",
        'process.stdout.write(require("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json").version)',
      ],
      { encoding: "utf8" },
    );
  assert.equal(piVersion, runtime.version);
  assert.equal(piVersion, PI_VERSION);
  assert.equal(ensureReleasePiImage(), image);
});

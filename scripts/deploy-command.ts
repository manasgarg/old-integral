import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { pathsFor } from "../src/platform/deployment-paths.ts";
import { serverStatus } from "../src/services/launcher.ts";
import { readComponentRecord } from "../src/platform/component-identity.ts";
import { COMPONENTS } from "../src/platform/constants.ts";
import {
  defaultDeploySettings,
  deploy,
  deploymentHealth,
  DeployError,
  rollbackDeploy,
  type CommandOptions,
  type CommandResult,
  type DeployHost,
} from "./deploy.ts";

function run(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Never let the developer's INTEGRAL_HOME (the development home) leak
    // into commands deploy runs against production.
    const env = { ...process.env };
    delete env.INTEGRAL_HOME;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) =>
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.on("close", (code, signal) =>
      resolve({
        code: code ?? -1,
        stdout,
        stderr: signal
          ? `${stderr}\nstopped by ${signal} (timed out?)`
          : stderr,
      }),
    );
  });
}

export const productionDeployHost: DeployHost = {
  run,
  deploymentStatus: async (home) => {
    const paths = pathsFor(home);
    return deploymentHealth(
      await serverStatus(paths),
      await Promise.all(
        COMPONENTS.map((component) => readComponentRecord(paths, component)),
      ),
    );
  },
  sleep: (ms) => sleep(ms),
  now: () => new Date(),
  report: (line) => process.stdout.write(line),
};

const DEPLOY_HELP = `Usage: npm run deploy [-- --rollback]

Deploy the current \`main\` to the production deployment, or roll back the
most recent deploy. See docs/upgrades.md.

Environment:
  INTEGRAL_DEPLOY_HOME   production deployment home (default: ~/.integral)
  INTEGRAL_RELEASE_ROOT  releases, backups and the deploy log
                         (default: ~/.local/share/integral)
`;

export async function deployCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(DEPLOY_HELP);
    return 0;
  }

  const settings = defaultDeploySettings(process.cwd());
  try {
    return args.includes("--rollback")
      ? await rollbackDeploy(settings, productionDeployHost)
      : await deploy(settings, productionDeployHost);
  } catch (error) {
    if (!(error instanceof DeployError)) throw error;
    process.stderr.write(`deploy stopped at ${error.step}: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await deployCommand(process.argv.slice(2));

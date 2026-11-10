import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  pathsFor,
  type IntegralPaths,
} from "../src/platform/deployment-paths.ts";
import {
  CURRENT_DEPLOYMENT_FORMAT,
  writeDeploymentFormat,
} from "../src/stores/deployment-format.ts";

type TestContext = { after(fn: () => unknown): void };

/** A new, empty deployment at the current deployment format. */
export async function fixture(t: TestContext): Promise<IntegralPaths> {
  const root = await mkdtemp(join(tmpdir(), "integral-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const paths = pathsFor(root);
  await writeDeploymentFormat(paths, CURRENT_DEPLOYMENT_FORMAT, "development");
  return paths;
}

/** Where the sample deployment for each format lives in the repository. */
export const SAMPLE_DEPLOYMENTS = join("test", "fixtures", "deployments");

/** A temporary copy of the sample deployment for `format`. */
export async function sampleDeployment(
  t: TestContext,
  format: number,
): Promise<IntegralPaths> {
  const root = await mkdtemp(join(tmpdir(), "integral-sample-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await cp(join(SAMPLE_DEPLOYMENTS, `format-${format}`), root, {
    recursive: true,
  });
  return pathsFor(root);
}

/** Every file below `root` and its bytes, for before-and-after comparisons. */
export async function directorySnapshot(
  root: string,
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  const visit = async (directory: string) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else
        snapshot[relative(root, path)] = (await readFile(path)).toString(
          "base64",
        );
    }
  };

  await visit(root);
  return snapshot;
}

/** Run `fn` with `INTEGRAL_HOME` set to `root`, restoring it afterwards. */
export async function withIntegralHome<T>(
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.INTEGRAL_HOME;
  process.env.INTEGRAL_HOME = root;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.INTEGRAL_HOME;
    else process.env.INTEGRAL_HOME = previous;
  }
}

/** Run the CLI in-process and capture what it prints. */
export async function runCli(
  main: (args: string[]) => Promise<number>,
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "",
    stderr = "";
  const out = process.stdout.write,
    err = process.stderr.write;
  process.stdout.write = (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  };

  try {
    const code = await withIntegralHome(root, () => main(args));
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

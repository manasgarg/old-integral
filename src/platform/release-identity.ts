import { readFileSync } from "node:fs";
import { packageFile } from "./package-files.ts";

/** The file deploy writes into a release before packing it. */
export const RELEASE_STAMP_PATH = "dist/src/release.json";

export const DEVELOPMENT_RELEASE = "development";

export interface ReleaseStamp {
  commit: string;
  deploymentFormat: number;
}

export function parseReleaseStamp(text: string): ReleaseStamp | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return undefined;

    const commit: unknown = Reflect.get(value, "commit"),
      deploymentFormat: unknown = Reflect.get(value, "deploymentFormat");
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit))
      return undefined;
    if (!Number.isInteger(deploymentFormat)) return undefined;

    return { commit, deploymentFormat: deploymentFormat as number };
  } catch {
    return undefined;
  }
}

/**
 * The commit this installed release was built from, or `development` when it
 * was not built by deploy.
 */
export function releaseIdentity(
  stampFile: string = packageFile(RELEASE_STAMP_PATH),
): string {
  try {
    return (
      parseReleaseStamp(readFileSync(stampFile, "utf8"))?.commit ??
      DEVELOPMENT_RELEASE
    );
  } catch {
    return DEVELOPMENT_RELEASE;
  }
}

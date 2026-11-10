import { fileURLToPath } from "node:url";

// This module runs compiled from dist/src/platform/, three levels below the
// package root. Resolve every shipped file through here so source files can
// move without breaking their paths.
const packageRoot = new URL("../../../", import.meta.url);

/** Absolute path of a file shipped in the integral package, such as `Dockerfile.pi`. */
export function packageFile(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, packageRoot));
}

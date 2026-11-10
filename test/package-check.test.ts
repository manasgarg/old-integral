import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

/* @covers DEV-8A71E49C
Given a developer runs the package validation command with an unusable inherited npm cache location
	When the command packages Integral for validation
		Then it uses an owned temporary npm cache
			And completes package validation without writing to the inherited cache location
*/
test("[DEV-8A71E49C] package validation owns its npm cache", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "integral-package-check-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const unusableCache = join(home, "not-a-directory");
  await writeFile(unusableCache, "not a directory");

  const result = await run(process.execPath, ["scripts/package-check.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: unusableCache },
  });

  // npm reports pack progress as `npm notice` lines on stderr, so success is
  // judged by the absence of warnings and errors rather than an empty stream.
  assert.doesNotMatch(result.stderr, /^npm (?:warn|error|ERR!)/im);
  assert.match(
    result.stderr,
    /^npm notice filename: pirogram-integral-.*\.tgz$/m,
  );
  assert.equal(await readFile(unusableCache, "utf8"), "not a directory");
});

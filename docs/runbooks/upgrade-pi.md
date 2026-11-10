# Upgrade Pi

Integral runs one pinned version of Pi
(`@earendil-works/pi-coding-agent`). Pi releases are not backward compatible,
so integral never installs `latest`. Moving to a new Pi version is a
deliberate change that goes through this runbook.

## Where the pin lives

Keep these two values identical. A test fails if they differ.

- `PI_VERSION` in `src/constants.ts` is the version integral installs on the
  host (for OAuth and the model catalog) and passes to default image builds.
- `ARG PI_VERSION` in `Dockerfile.pi` is the default for the managed Pi image
  recipe. A new deployment's image recipe starts from this file.

An operator can still set a different version in their deployment's own image
recipe (`integral image edit`). That is their choice and is not affected by the
pin.

## What integral depends on in Pi

Check each of these against the release notes. Most breaking changes in Pi do
not affect integral, but these do:

- The package entry point `dist/index.js` and its `ModelRuntime` API
  (`create`, `getModels`, `getAuth`, `login`), with the older `AuthStorage` and
  `ModelRegistry` API as a fallback. Used by `src/pi-runtime.ts`,
  `src/oauth.ts` and `bin/integral-pi-models.mjs`.
- The command-line flags integral starts Pi with: `--mode rpc`,
  `--no-session`, `--approve`, `--offline`, `--provider`, `--api-key`,
  `--model` and `--extension` (see `src/container.ts`).
- The RPC protocol: the `prompt` command and the events integral reads back.
- The extension API used by integral's extensions: `registerTool` with
  `typebox` schemas, `pi.on("turn_end")` with `event.toolResults`, and
  `pi.sendMessage` with `deliverAs` and `triggerTurn` (see
  `src/web-extension.ts` and `writeTaskExtension` in `src/container.ts`).
- The location of credentials, `~/.pi/agent/auth.json`, and the provider names
  integral supports.
- `pi --version` output, which integral parses to record the installed version.

## Steps

1. **Pick the version.** Find the target version and its release date:

   ```sh
   npm view @earendil-works/pi-coding-agent versions time --json
   ```

   Prefer a release that has been out for a few days, so urgent follow-up
   fixes have landed.

2. **Read the release notes.** Read every `Breaking Changes` and `Removed`
   section between the current pin and the target in Pi's `CHANGELOG.md`
   (in the published package, or `packages/coding-agent/CHANGELOG.md` in
   [earendil-works/pi](https://github.com/earendil-works/pi)). To print just
   those sections from the package:

   ```sh
   mkdir -p /tmp/pi-upgrade && cd /tmp/pi-upgrade
   npm pack @earendil-works/pi-coding-agent@<target> && tar xzf *.tgz
   awk '/^## \[/{v=$2} /^### (Breaking Changes|Removed)/{p=1; print "== " v; next} /^### /{p=0} p' package/CHANGELOG.md
   ```

   Compare each entry with the list in "What integral depends on in Pi". Fix
   anything integral needs to change in the same branch as the bump.

3. **Bump the pin.** On a new branch, set the target version in both
   `src/constants.ts` and `Dockerfile.pi`.

4. **Run the default checks.**

   ```sh
   npm run check
   ```

5. **Run the acceptance tests.** These build the real image with the new
   version and start real Pi containers, so they need Docker:

   ```sh
   npm run test:acceptance:docker
   npm run test:acceptance
   ```

   Report any profile that could not run. Do not count a skipped acceptance
   test as passed.

6. **Try it by hand.** With a development deployment:
   - Run `integral version` and confirm it prints the new Pi version.
   - Run `integral talk`, open the model chooser, and confirm models are
     listed. Send a message and confirm Pi answers.
   - If you use an OAuth model connection, sign in again with it to confirm
     login still works.
   - Run a scheduled task that uses the task outcome tools, if you have one.

7. **Merge.** Open a pull request that names the old and new versions and
   lists the breaking changes you checked and any code you changed for them.

## What changes for running deployments

When a deployment picks up the new pin, integral installs the new version
under its runtime state (`pi-runtime/versions/<version>`) and builds a new
managed image the next time the model chooser or OAuth needs Pi. Each
conversation records the Pi version and image it selected; integral treats a
change of Pi runtime as a change of model selection. Older installed versions
stay on disk until removed.

## Roll back

1. Revert the pull request that bumped the pin (or set both values back to the
   previous version) and release.
2. The previous version is usually still installed under
   `pi-runtime/versions/`, and its image may still be present, so integral can
   use it again without downloading. If not, integral installs it again.
3. If an operator edited their image recipe for the new version, they revert
   that change with `integral image edit` as well.
4. Open an issue that records what broke, so the next upgrade checks for it.

# Upgrade behaviors

These behaviors cover how a deployment's durable data is versioned and
migrated, how migrations are proven before they run, and how a new release of
Integral replaces the running one. [`docs/upgrades.md`](../docs/upgrades.md)
describes the whole workflow.

Terms used below:

- **Deployment home**: the directory `INTEGRAL_HOME` names. Its `config/` and
  `data/` hold everything a deployment keeps. The production deployment home
  is `$HOME/.integral`.
- **Release**: one installed build of Integral, identified by the Git commit
  it was built from.
- **Deployment format**: a whole number recorded in the deployment's data. It
  says which layout the files under `data/` and `config/` follow. A release
  that changes that layout raises the number.
- **Current format**: the deployment format a release reads and writes. Each
  release supports exactly one.
- **Migration**: code in a release that rewrites a deployment's files from one
  format to the next. Migrations only move forward. Going back to an older
  release means restoring the backup taken before the upgrade.
- **Release root**: `<release-root>`, where deploy keeps installed releases,
  the `current` symlink to the active release, backups, and the deploy log. It
  defaults to `$HOME/.local/share/integral` and sits outside the deployment
  home, so restoring a backup never overwrites the backups or the log.

## UPGRADE-13E4E25F — Record the deployment format

```text
Given a deployment home whose `data/` directory does not exist yet
	When integral creates `data/` for a new deployment
		Then it writes `data/deployment-format.json` atomically
			And records the release's current format as the deployment format
			And records the release that wrote it
Given a deployment home whose `data/` was created before deployment formats existed
	When integral reads the deployment format
		Then it finds no `data/deployment-format.json`
			And treats the deployment format as 0
			And leaves `integral migrate` as the only command that writes the format file for that deployment
```

## UPGRADE-687E186E — Refuse to run on an older deployment format

```text
Given the deployment format is older than the current format
	When the user runs any command that reads or writes deployment state other than `integral migrate` and `integral doctor`
		Then integral exits unsuccessfully before starting any component or opening any store
			And leaves the deployment's files unchanged
			And names the deployment format and the current format
			And tells the user to run `integral migrate`
	When a separately started component starts
		Then it refuses to start in the same way
```

## UPGRADE-FB9B1FDA — Refuse to run on a newer deployment format

```text
Given the deployment format is newer than the current format
	When the user runs any command that reads or writes deployment state
		Then integral exits unsuccessfully before starting any component or opening any store
			And leaves the deployment's files unchanged
			And names the release that wrote the deployment format
			And explains that the deployment must be restored from the backup taken before that upgrade or run with that release
	When the user runs `integral migrate`
		Then integral refuses in the same way
			And does not offer a reverse migration
```

## UPGRADE-95CAFD74 — Migrate a deployment to the current format

```text
Given the deployment format is older than the current format
	And no integral component is running for the deployment
	When the user runs `integral migrate`
		Then integral holds the deployment lock for the whole operation
			And applies each migration from the deployment format to the current format in order
			And advances `data/deployment-format.json` atomically after each migration completes
			And appends one record per migration to `data/migration-audit.jsonl` with the migration, both formats, the release, the start and end times, and the result
			And prints each migration as it runs
			And exits successfully when the deployment reaches the current format
	When the deployment format already equals the current format
		Then integral reports that there is nothing to migrate
			And exits successfully without changing any file
	When any integral component is running for the deployment
		Then integral refuses to migrate
			And names the running components
			And leaves the deployment's files unchanged
```

## UPGRADE-51A0EA97 — Resume a failed migration

```text
Given `integral migrate` is applying a migration
	When the migration fails or the process stops before it completes
		Then the deployment format remains at the last completed migration
			And integral records the failed migration and a bounded reason in `data/migration-audit.jsonl`
			And exits unsuccessfully naming the failed migration
	When the user runs `integral migrate` again
		Then integral starts from the first migration that has not completed
			And that migration completes correctly even though it was partly applied before
```

## UPGRADE-D1B8C002 — Check a deployment with integral doctor

```text
Given a deployment at any format
	When the user runs `integral doctor`
		Then integral reports the deployment format and the current format
			And, when they match, reads every durable store with the current release's own readers
			And reports each store it could not read or that failed validation, with a bounded reason and without secrets
			And never changes deployment files
			And exits successfully only when the formats match and every store is readable and valid
	When the deployment format differs from the current format
		Then integral reports the difference
			And exits unsuccessfully without reading the stores
```

## UPGRADE-7FE91DD6 — Prove every migration against sample deployments

```text
Given the repository contains a sample deployment for each format from 0 to the current format under `test/fixtures/deployments/format-<N>/`
	And the sample deployments contain no real credentials or personal data
	When the default test suite runs
		Then it migrates a temporary copy of each sample deployment to the current format
			And runs the `integral doctor` checks on each migrated copy
			And migrates each copy a second time to show that a finished migration changes nothing
			And fails when any migration or check fails
	When the current format has no sample deployment
		Then the default test suite fails
			And names the missing sample deployment
```

## UPGRADE-4BC437DA — Keep development off the production deployment

```text
Given a developer works in a repository worktree with the project's mise environment active
	When they run integral from the worktree without setting `INTEGRAL_HOME`
		Then integral uses `$HOME/.integral-dev` as the deployment home
			And never reads or writes the production deployment
	When they build or test in the worktree
		Then the running production release is unaffected
```

## UPGRADE-43A028B5 — Check that a commit is ready to deploy

```text
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
```

## UPGRADE-A9D593DA — Build an immutable release

```text
Given the commit passed the deploy checks
	When deploy builds the release
		Then it builds from a clean export of that commit, never from the developer's worktree
			And stamps the release with the commit SHA and the current format
			And packs it with `npm pack`
			And installs the package with production dependencies into `<release-root>/releases/<sha>/`
			And never changes a release directory after it is installed
	When `<release-root>/releases/<sha>/` already exists
		Then deploy reuses it without rebuilding
```

## UPGRADE-1F1E078F — Keep the production release running with systemd

```text
Given deploy has installed a release
	When deploy sets up the service
		Then it writes a systemd user unit named `integral.service`
			And the unit runs `<release-root>/current/bin/integral.js server start`
			And the unit sets `INTEGRAL_HOME` to the production deployment home
			And the unit sets `PATH` to the directory of the Node.js that ran deploy followed by deploy's own `PATH` without `node_modules` directories
			And deploy reloads systemd before starting the service
	When the integral server exits unexpectedly
		Then systemd starts it again
	When the user logs in after the machine restarts
		Then systemd starts the integral server
	When the integral server writes output
		Then the user can read it with `journalctl --user -u integral`
```

## UPGRADE-E93D63FA — Rehearse the upgrade on a copy

```text
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
```

## UPGRADE-6C26AF47 — Stop and back up the deployment

```text
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
```

## UPGRADE-03673EA9 — Activate the new release

```text
Given the deployment is stopped and backed up
	When deploy activates the new release
		Then it runs the new release's `integral migrate` against the deployment
			And points `<release-root>/current` at the new release atomically
			And starts the service
			And waits, up to a bounded timeout, for `integral status` to report every component healthy
			And runs `integral doctor`
			And appends a record to `<release-root>/deploy-log.jsonl` with both releases, both formats, the backup, the times, and the result
			And reports success
	When every component runs the new release at the end of the health wait
		And the gateway's only problem is a connection it could not authorize or reach
		Then deploy continues as though the release were healthy
			And reports each connection problem so the developer can reconnect it
```

## UPGRADE-7F1EFAD0 — Roll back a failed upgrade automatically

```text
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
```

## UPGRADE-25417B4B — Roll back to the previous release on request

```text
Given a deploy succeeded and its backup is retained
	When the developer runs `npm run deploy -- --rollback`
		Then deploy stops the service
			And copies the current `config/` and `data/` into a new backup first
			And restores the backup taken before the most recent deploy
			And points `<release-root>/current` at the release recorded with that backup
			And starts the service and waits for it to report healthy
			And warns that changes made since that deploy are not in the restored deployment
			And records the rollback in `<release-root>/deploy-log.jsonl`
```

## UPGRADE-D773FC7C — Keep managed repositories and stores usable across a restore

```text
Given the deployment has governed repositories or stores whose backing directories Integral created under the deployment's `data/`
	When deploy backs up the deployment
		Then it records with the backup each such resource whose backing directory still has the filesystem identity recorded for it
	When deploy restores that backup, after a failed upgrade or on request
		Then it records the restored backing directory's filesystem identity for each resource recorded with the backup
			And reports each resource it re-recorded
			And leaves every other resource record as the backup holds it
	When a resource's backing directory already had a different identity when the backup was taken
		Then the restore does not re-record it
			And Integral keeps reporting it as `identity_changed`
	When the backup was taken by a release that recorded no resources
		Then the restore re-records nothing
```

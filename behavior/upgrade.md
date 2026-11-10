# Upgrade behaviors

These behaviors cover how a deployment's durable data is versioned and
migrated, how migrations are proven before they run, and how a new release of
Integral replaces the running one. A deployment's data carries one deployment
format number. Each release of Integral supports exactly one format, called
its current format. Migrations only move a deployment forward. Going back to an
older release means restoring the backup taken before the upgrade, never
running a reverse migration.

`<release-root>` is where deploy keeps installed releases, the `current`
symlink, backups, and the deploy log. It defaults to
`$HOME/.local/share/integral` and sits outside the deployment home, so
restoring a backup never overwrites the backups or the log.

## UPGRADE-13E4E25F — Record the deployment format

```text
Given a deployment home
	When integral creates the deployment's data directory for the first time
		Then it writes `data/deployment-format.json` atomically
			And records the current format
			And records the release that wrote it
	When the data directory exists without `data/deployment-format.json`
		Then integral treats the deployment as format 0
			And does not create the format file outside `integral migrate`
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

## UPGRADE-1F1E078F — Run the deployment as a user service

```text
Given a release is active
	When the service manager starts integral
		Then it runs `<release-root>/current/bin/integral.js server start`
			And sets `INTEGRAL_HOME` explicitly to the production deployment home
			And restarts it after an unexpected exit
			And sends its output to the user journal
	When deploy installs or updates the service definition
		Then it does so before starting the new release
			And reports the service's name
```

## UPGRADE-E93D63FA — Rehearse the upgrade on a copy

```text
Given the new release is installed
	When deploy rehearses the upgrade
		Then it copies the production deployment's `config/` and `data/` into a temporary deployment home
			And runs the new release's `integral migrate` against the copy
			And runs the new release's `integral doctor` against the copy
			And removes the copy afterwards
			And does this while the running release keeps serving
	When the rehearsal fails
		Then deploy stops before touching the running release or the deployment
			And reports the failed migration or doctor finding
			And keeps the failed copy for inspection and names its path
```

## UPGRADE-6C26AF47 — Stop and back up the deployment

```text
Given the rehearsal succeeded
	When deploy stops the running release
		Then it first waits for the message queue and task queue to have no in-flight work, up to a bounded drain timeout
			And then stops the service
			And relies on clean shutdown to return any interrupted in-flight message to the queue
	When the service has stopped
		Then deploy copies the deployment's `config/` and `data/` in full into `<release-root>/backups/<time>-<previous-sha>/`
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
```

## UPGRADE-7F1EFAD0 — Roll back a failed upgrade automatically

```text
Given deploy has stopped the previous release
	When the migration, the service start, the health wait, or the doctor check fails
		Then deploy stops the service
			And replaces the deployment's `config/` and `data/` with the backup
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

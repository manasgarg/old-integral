# Upgrades

This document describes how a change to Integral's code reaches the
production deployment safely, including changes that need the deployment's
data to be migrated. The exact behavior is specified in
[`behavior/upgrade.md`](../behavior/upgrade.md), which also defines the terms
used here.

## The problem

Integral keeps durable state on disk: the conversation, queues, run history,
approvals, schedules, connections, stores and more, about 1.7 GB in a
long-lived deployment. Code changes often change how that state is written.
Without a plan, three things go wrong:

- The running server's code changes under it when you build in the same
  folder.
- New code reads old data it does not understand, or old code reads data that
  new code has already rewritten.
- A migration that works on test data fails on real data, and there is no
  clean way back.

## The design in one paragraph

Every deployment records a **deployment format** number. Each release of
Integral supports exactly one format and refuses to run on any other.
**Migrations** move a deployment forward one format at a time and are proven
against sample deployments in the test suite. Production runs from an
immutable **release** installed by `npm run deploy`, never from a development
worktree. Deploy first rehearses the migration on a copy of the real data,
then backs up, migrates, switches and checks health. If anything fails, it
restores the backup and the previous release.

## Parts

| Part               | What it is                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Format file        | `data/deployment-format.json` records the deployment format and the release that wrote it. A missing file means format 0. |
| Format check       | Every command that touches deployment state, and every component, refuses to run when the format is not the current one.  |
| `integral migrate` | Applies the migrations from the deployment format to the current format, one at a time, saving progress after each.       |
| `integral doctor`  | Reads every store with the current release's code and reports anything it cannot read. Never changes files.               |
| Sample deployments | `test/fixtures/deployments/format-<N>/`. The test suite migrates a copy of each to the current format and runs doctor.    |
| Release root       | `$HOME/.local/share/integral`: installed releases, the `current` symlink, backups and the deploy log.                     |
| `integral.service` | A systemd user unit that runs `current/bin/integral.js server start` against `$HOME/.integral` and restarts it on exit.   |
| `npm run deploy`   | The only way a new release reaches production.                                                                            |
| Development home   | Worktrees use `$HOME/.integral-dev` through mise, so development never touches production data.                           |

## Changing how data is stored

When a change alters what any store writes to disk, the same pull request:

1. Raises the current format by one.
2. Adds a migration from the previous format. It must work when run again
   after a partial run, because a crash can stop it partway.
3. Adds a sample deployment for the new format. The test suite fails until it
   exists.
4. Updates the behavior specification and tests as usual.

A change that does not alter stored data does not touch the format.

## Deploying

`npm run deploy` runs from a worktree on `main`:

```text
check ──▶ build ──▶ rehearse ──▶ drain + stop ──▶ back up ──▶ migrate ──▶ switch ──▶ start ──▶ verify
  │         │          │                                         │                    │         │
  └─────────┴──────────┴── stop; production untouched            └──── on failure: restore backup,
                                                                       switch back, start ───────┘
```

1. **Check.** `main` is clean, matches `origin/main`, and GitHub CI passed for
   that commit. The Docker acceptance tests pass.
2. **Build.** Build from a clean export of the commit, `npm pack`, and install
   into `releases/<sha>/`. A release directory is never changed afterwards.
3. **Rehearse.** Copy production `config/` and `data/` (without
   `data/pi-runtime/`) to a temporary home under `rehearsals/`,
   then run the new release's `integral migrate` and `integral doctor` on the
   copy. The rehearsal succeeds only if the copy and both commands succeed
   within their time limits. Production keeps running throughout.
4. **Drain and stop.** Refuse if integral is running for the deployment
   outside the service, for example started by hand. Otherwise wait, up to a time limit, for no message or task to be
   in progress, then stop the service. A clean stop returns any interrupted
   message to the queue.
5. **Back up.** Copy `config/` and `data/` into
   `backups/<time>-<previous-sha>/`, leaving out `data/pi-runtime/` (Pi
   installs that integral downloads again when they are missing; they are
   most of a deployment's size). Keep the three most recent backups.
6. **Migrate.** Run the new release's `integral migrate` on production.
7. **Switch.** Point `current` at the new release.
8. **Start and verify.** Start the service, wait for every component to report
   healthy, and run `integral doctor`. A connection the gateway cannot
   authorize, such as an expired OAuth login, is reported instead of rolled
   back: the previous release would have the same problem.
9. **Record.** Append the result to `deploy-log.jsonl`.

Steps 1 to 3 never touch production, so a failure there just stops the
deploy. A failure in steps 6 to 8 triggers an automatic rollback.

## Running it

```sh
npm run deploy                 # deploy the current main
npm run deploy -- --rollback   # undo the most recent deploy
```

`INTEGRAL_DEPLOY_HOME` overrides the production deployment home (default
`~/.integral`) and `INTEGRAL_RELEASE_ROOT` overrides the release root (default
`~/.local/share/integral`). Deploy never uses `INTEGRAL_HOME`, which `mise.toml`
points at the development home.

The service starts when you log in. To keep it running while you are logged
out, enable lingering once: `loginctl enable-linger $USER`. Its logs are in
`journalctl --user -u integral`.

To use the production deployment from a shell, run the active release against
it:

```sh
INTEGRAL_HOME=~/.integral ~/.local/share/integral/current/bin/integral.js talk
```

## Rolling back

There are no reverse migrations. Rolling back always restores data and code
together:

- **Automatic:** when migrate, start, health or doctor fails during a deploy,
  deploy stops the service, restores the backup, points `current` back at the
  previous release and starts it.
- **By hand:** `npm run deploy -- --rollback` does the same for the most recent
  deploy. It backs up the current data first, because anything that happened
  since that deploy is lost from the restored deployment.

Because a release refuses to run on a newer format, old code can never be
started on migrated data by mistake.

A restore copies `data/` back, which gives every directory in it a new inode.
Integral marks a governed repository or store unavailable (`identity_changed`)
when its backing directory's inode changes, so each backup lists the managed
repositories and stores under `data/` that matched at backup time, and the
restore re-records just those. One that had already drifted before the backup
stays unavailable.

## Pi upgrades

A Pi pin bump is an ordinary release. Follow
[`runbooks/upgrade-pi.md`](runbooks/upgrade-pi.md) to prepare the change, then
deploy it like any other. The rehearsal shows that real conversations move to
the new Pi correctly before production is touched.

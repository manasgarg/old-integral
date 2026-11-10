# Project instructions

Speak in plain English.

## TypeScript workflow

- Use the project-local Node.js and npm tooling. Do not rely on globally
  installed formatters, linters, compilers, or test runners.
- Run `npm run check` before committing a completed increment. The gate checks
  formatting, TypeScript types, typed lint rules, tests and coverage, behavior
  references, and package metadata.
- Run `npm run format` after editing supported source or documentation files.
  Never auto-format files under `behavior/`; their literal tab indentation is
  part of the executable product contract.
- Keep TypeScript strict. Do not weaken compiler options or lint rules to make a
  change pass. Narrow unknown values, model data explicitly, and keep unsafe
  assertions at validated system boundaries.
- Separate logical blocks of code with one blank line so a reader can see
  where one step ends and the next begins, for example setup, validation, the
  main work, and the result. Keep a block's related statements together, and
  do not add blank lines that split a single step or pad short functions.
- Prefer Node.js built-ins over adding dependencies when they provide the
  required behavior. Use `node:test` for automated tests and keep tests
  deterministic and isolated from external services.
- Add tests for changed behavior and include the relevant stable behavior ID in
  each test name.
- Pin development-tool versions exactly. Review lockfile changes and do not add
  overlapping tools that perform the same job.
- Use `npm run package:check` after changing package entry points or published
  files, and use `npm run pack:check` to inspect the package tarball before a
  release.

## Architecture and naming

- Follow the layers in `docs/architecture.md`. A module imports only from its
  own layer and the layers below it; `npm run lint` rejects imports from a
  higher layer. Do not disable that rule to make a change pass. Move the shared
  type down a layer or pass the dependency in instead.
- Give every folder, file and symbol (types, functions, variables) a name that
  says what it is or does in Integral's domain, for example `message-queue.ts`
  and `MessageQueue` rather than `queue.ts` and `DurableQueue`.
- Avoid generic names such as `state`, `utils`, `helpers`, `resources`,
  `runtime` or `manager` on their own. Say whose state or which runtime.
- Do not put two names side by side that are easy to mix up, such as
  `runner.ts` and `runtime.ts`. If two things are distinct, name the
  difference.
- Name a test file after the module it covers.

## Deployment data and upgrades

`docs/upgrades.md` describes how changes reach the production deployment.

- When a change alters what any store writes to disk, raise
  `CURRENT_DEPLOYMENT_FORMAT` in `src/stores/deployment-format.ts` by one in
  the same pull request, add the migration from the previous format to
  `src/stores/deployment-migrations.ts`, and add a sample deployment for the
  new format under `test/fixtures/deployments/format-<N>/`.
- Write each migration so it finishes correctly when run again after a crash
  stopped it partway. Migrations only move forward.
- Generate sample deployments with the store code itself, never by copying a
  real deployment, and keep credentials and personal data out of them. Never
  edit an existing sample deployment; it records what older releases wrote.
- Work against `$HOME/.integral-dev` (set by `mise.toml`), never the
  production deployment. Production changes only through `npm run deploy`.

Keep the behavior specification, implementation, and tests synchronized as one
increment.

- Start a product change by locating the applicable behavior ID and every
  affected `When` path. Add or revise the behavior specification before relying
  on implementation details as the contract.
- Preserve existing behavior IDs. Give genuinely new behavior a collision-free
  ID and retire removed behavior IDs as described below.
- Implement production code through explicit boundaries for external systems,
  including time, processes, Docker, terminals, signals, and network peers.
  Production implementations must remain the default; tests may provide
  deterministic implementations through the same interfaces.
- Keep lifecycle ownership explicit. A successful start must return an owned
  resource that can be stopped, and a failed start must clean up everything it
  acquired. Cleanup operations must be safe to call after partial startup.
- Add at least one executable test for each changed `When` path. Put the stable
  behavior ID in the test name and assert observable outcomes, not source-code
  spelling or implementation structure.
- Use unit tests for pure policy, in-process integration tests for filesystem
  and component boundaries, subprocess tests for CLI and signal behavior, and
  Docker or PTY acceptance tests for operating-system guarantees.
- Do not count a skipped acceptance test as verified. Document why it is not in
  the default suite, give it a dedicated runnable command, and make that command
  fail clearly when its explicitly requested prerequisite is unavailable.
- When implementation and specification disagree, first establish which
  behavior is intentional. Then update the specification, implementation, and
  tests together; never weaken an assertion merely to preserve current output.
- Before completing a behavior change, run `npm run check` and every relevant
  acceptance profile. Review the behavior diff beside the implementation and
  test diff, and report any acceptance profile that could not run.

## Git workflow

- This project uses Git from the beginning.
- Commit each coherent, completed increment immediately after its required
  checks pass. Do this as work progresses rather than waiting until the end of
  a task or review.
- Treat commits as review points. Put corrections or requested revisions in
  follow-up commits instead of keeping a completed increment uncommitted.
- Before committing, inspect the working tree and include only changes that
  belong to the current increment.
- Use a concise commit message that states the completed outcome.
- Do not batch several independently completed increments into one later
  commit, and do not leave completed work uncommitted.

## Behavior specifications

Behavior specifications are the executable product contract and should be
organized the same way as test cases.

- Keep all behavior specifications under `behavior/`.
- Group closely related behaviors in one file. Split files by product area,
  not by individual behavior.
- Give every behavior a unique, stable ID formed from an uppercase product-area
  prefix, a hyphen, and eight randomly generated uppercase hexadecimal
  characters, for example `CHAT-7A3F19C2`.
- The random suffix must not encode sequence, file position, title, or priority.
  Adding, moving, or removing a behavior must never change another behavior's
  ID.
- Check the whole `behavior/` directory for a collision before assigning a new
  ID.
- Never change or reuse an assigned behavior ID. When a behavior is removed,
  record its ID in the retired-ID list in `behavior/README.md`.
- Use one level-two heading per behavior in the form
  `## <ID> — <short description>`.
- Wrap each behavior's complete Given/When/Then clause body in a fenced `text`
  code block so Markdown preserves and visibly renders its literal indentation.
- Express each behavior as Given/When/Then, using literal tab indentation.
- Write `Given` with no indentation, each `When` with one tab, and each `Then`
  with two tabs. This allows several sibling `When` clauses to share one
  `Given`.
- Put every `And` or `Or` condition on its own line. Indent it beneath the
  clause it extends: one tab for a `Given` condition, two tabs for a `When`
  condition, and three tabs for a `Then` condition.
- Keep setup, action, and outcome distinct. Do not combine Given, When, Then,
  And, or Or clauses on one line.
- Tests should reference the behavior ID they implement.

Use this exact layout:

````text
## CHAT-7A3F19C2 — Hold an interactive conversation

```text
Given the server is healthy
	And the terminal is interactive
	When the user runs `integral talk`
		And submits a non-empty message
		Then integral sends the message to Pi
			And displays Pi's response
```
````

Each behavior file may start with a level-one heading and a short scope note,
but normative outcomes belong in identified Given/When/Then behaviors.

## Lifecycle specifications

A behavior describes one path through the product. A lifecycle specification
describes every path a long-lived resource can take, so a missing case shows up
as a gap in a table instead of a bug in production. Write one for any resource
that exists outside a single function call and has more than one way to end:
processes, containers, sidecars, session homes, gateway identities, claimed
work, timers, and connections. Stateless policy stays in ordinary behaviors.

- Keep lifecycle specifications under `behavior/lifecycle/`, one file per
  resource, named after the resource.
- Start a change to such a resource with its lifecycle file. A new state adds a
  row for every event and a new event adds a row for every state; fill them all
  before writing behaviors or code.
- Each file has these level-two sections, in order: `Ownership`, `States`,
  `Events`, `Transitions`, `Invariants`, `Restart reconciliation`, and
  `Diagram`.
- `Ownership` names the component that creates the resource, the component that
  destroys it, what identifies one instance, and the child resources it owns.
- `States` is a table whose first column is a backticked kebab-case state name.
  Include transient states such as provisioning and ending, say where each
  state is recorded, and say what a restarting component finds after a crash.
- `Events` is a table whose first column is a backticked kebab-case event name.
  Include commands, timers, completions and failures of the resource's own
  operations, failures of external systems, shutdown, and crash recovery.
- `Transitions` is a table with the columns `From`, `Event`, `To`, `Outcome`,
  and `Contract`. Every state and event pair must appear exactly once. Several
  states that react the same way may share one row as a comma-separated list.
- The `Contract` cell is one of:
  - one or more behavior IDs that specify the outcome in Given/When/Then, with a
    known target state in `To`;
  - `impossible`, with `—` in `To` and the reason the event cannot occur in
    that state in `Outcome`;
  - `ignored`, with `—` in `To` and the reason nothing needs to happen in
    `Outcome`;
  - `open`, with `?` in `To` and the undecided question in `Outcome`.
- Resolve an `open` row by deciding the outcome, writing or extending the
  behavior that specifies it, and citing that behavior.
- `Invariants` lists statements that hold in every state, each followed by the
  behavior IDs that enforce it or by `open`.
- `Diagram` holds a Mermaid `stateDiagram-v2` block with one
  `<from> --> <to> : <event>` line for each specified transition that changes
  state. Rows that keep the state, and `impossible`, `ignored`, and `open` rows,
  are not drawn.
- Do not put behaviors in a lifecycle file. Teardown and other procedures that
  several transitions share belong in an ordinary behavior, written once and
  cited from every row that uses it. Other behaviors cite it rather than
  repeating its steps.
- `npm run lifecycle:check` validates names, pair coverage, cited IDs, and the
  diagram, and reports how many pairs are still open.

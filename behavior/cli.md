# CLI behaviors

These behaviors cover command discovery, implementation information, and the
deliberate overlap between shell commands and local commands in `integral talk`.

## CLI-6001FE46 — Show top-level help

```text
Given integral is installed
	When the user runs `integral`, `integral --help`, `integral -h`, or `integral help`
		Then the command exits successfully
			And lists `server`, `talk`, `status`, `model`, `queue`, `task`, `schedule`, `connection`, `config`, `migrate`, `doctor`, and `version`
			And describes each command in plain English
	When npm reads the package metadata
		Then the package is named `@pirogram/integral`
			And it exposes `integral` through `bin/integral.js`
```

## CLI-04301CCA — Report the implementation version

```text
Given integral is installed
	When the user runs `integral version`
		Then the command prints the integral version
			And prints the release's commit SHA, or `development` when it was not built by deploy
			And prints the deployment format the release supports
			And prints the Node.js version
			And prints the pinned Pi version
			And exits successfully
	When the user runs `integral --version` or `integral -V`
		Then the command prints the same implementation versions
			And exits successfully
```

## CLI-A7D3E91B — Accept short help on every command

```text
Given integral is installed
	When the user adds `-h` to any integral command or subcommand
		Then integral prints the applicable help
			And exits successfully
			And does not perform the command operation
```

## CLI-7A87D55B — Share conversation status between the CLI and talk

```text
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When the user invokes `integral status` or enters `/status` in `integral talk`
		Then integral reports the same conversation and component status from either surface
```

## CLI-E3D01B8A — Share model selection between the CLI and talk

```text
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When the user invokes `integral model [<pattern>...]` or enters `/model [<pattern>...]` in `integral talk`
		Then integral uses the same model chooser and changes the same durable conversation selection from either surface
```

## CLI-DF545C68 — Share connection discovery between the CLI and talk

```text
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When the user invokes `integral connection catalog` or enters `/connection catalog` in `integral talk`
		Then integral shows the same public connection types and authentication methods from either surface
	When the user invokes `integral connection ls` or enters `/connection ls` in `integral talk`
		Then integral shows the same connection names, types, authentication methods, and states from either surface
			And neither surface prints secret values
```

## CLI-FCE41B12 — Share durable queues between the CLI and talk

```text
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When the user invokes `integral queue ls`, `integral queue edit <id> <text>`, or `integral queue delete <id>`
		And the user could instead enter the corresponding `/queue` command in `integral talk`
		Then integral reads or changes the same durable queue from either surface
	When the user invokes `integral task ls`, `integral task show <id>`, or `integral task cancel <id>`
		And the user could instead enter the corresponding `/tasks` command in `integral talk`
		Then integral reads or changes the same durable task queue from either surface
```

## CLI-D1B5816E — Keep shared operations local to each command surface

```text
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When a shared operation succeeds or fails
		Then both surfaces report the same essential result or actionable error
			And the shell form exits without attaching a talk session
			And the slash form keeps the current talk session attached
			And the slash form handles the operation on the host without sending it to Pi
```

## CLI-6453A00A — Explain shared commands and command-specific boundaries

```text
Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When integral shows top-level CLI help or local talk help
		Then it identifies the equivalent spelling for every shared operation on the other surface
Given an operation is specific to host administration, scripting, or an attached terminal
	When integral shows top-level CLI help or local talk help
		Then `server`, `talk`, `schedule`, `config`, `migrate`, `doctor`, and `version` remain CLI-only
			And connection setup, credential rotation, and removal remain CLI-only
			And structured-output flags remain CLI-only
			And `/exit` remains talk-only
			And integral does not treat an arbitrary top-level CLI command as a local talk command
```

## TASK-FC4DA418 — Inspect and cancel durable tasks

```text
Given the durable task queue contains zero or more scheduled task executions
	When the user runs `integral task ls` or enters `/tasks` or `/tasks ls` in `integral talk`
		Then Integral lists every task in queue order
			And shows each task's state, execution ID, scheduled time, and prompt
			And reports an empty task queue without error
	When the user runs `integral task show <id>` or enters `/tasks show <id>` in `integral talk`
		Then Integral shows the complete task record for that execution ID
			And reports when the task does not exist
	When the user runs `integral task cancel <id>` or enters `/tasks cancel <id>` in `integral talk`
		Then Integral asks the coordinator to cancel that task
			And shows the resulting task state
	When the user runs `integral task ls --json` or `integral task show <id> --json`
		Then Integral prints the selected task data as JSON
	When the user includes `--json` in a `/tasks` command
		Then Integral explains that structured output is available only in the CLI
	When Integral handles a `/tasks` command locally
		Then it does not send the command to Pi
```

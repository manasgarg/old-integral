# Architecture

Integral runs Pi in a locked-down Docker container and governs everything Pi
does through four host components: the coordinator, the runner, the gateway
and the scheduler. The source in `src/` is organized into layers so that its
folders show this design.

## Layers

Each layer may import from itself and from layers below it, never from a layer
above it. `npm run lint` enforces this with `no-restricted-imports` rules in
`eslint.config.mjs`.

| Layer        | Folder              | What lives there                                                                      |
| ------------ | ------------------- | ------------------------------------------------------------------------------------- |
| Entry points | `src/cli/`          | The `integral` command and its subcommands                                            |
| Services     | `src/services/`     | The four long-running components and the launcher that starts and stops them          |
| Integrations | `src/integrations/` | Adapters to outside systems: Docker, Pi, MCP servers, OAuth providers, Discord, email |
| Stores       | `src/stores/`       | Durable state on disk: queues, conversations, runs, schedules, connections |
| Domain       | `src/domain/`       | Types and pure policy with no I/O                                                     |
| Platform     | `src/platform/`     | Files, paths, logging, errors, timers and servers, internal HTTP, component identity  |

`src/pi-extensions/` stands apart. Its code is bundled with esbuild and runs
inside the Pi container, not on the host, so it imports nothing else from
`src/`.

Tests stay flat in `test/`, named after the module they cover, so that
`dist/test/*.test.js` keeps acceptance tests in `test/acceptance/` out of the
default suite.

## Functional blocks

### Entry points (`cli/`)

- `main.ts` parses the command line and holds `integral talk`.
- `conversation.ts`, `queue.ts`, `task.ts` and `schedule.ts` hold the
  subcommands.
- `coordinator-client.ts` sends the CLI's requests to the coordinator.

### Services (`services/`)

- `coordinator/` owns the conversation: the message and task queues, model
  selection, and the event stream that attached terminals follow.
- `runner/` claims queued work, runs it in a Pi container, and manages MCP
  sidecars for each session.
- `gateway/` is the only way out of the container network. It checks each
  request against the egress policy (`egress-policy.ts`), swaps credential
  sentinels for real credentials, and terminates TLS with its own certificate
  authority (`certificate-authority.ts`).
- `scheduler/` turns schedules into occurrences and dispatches them as tasks.
- `launcher.ts` starts the components together or one at a time and reports
  their status.

### Integrations (`integrations/`)

- `docker/pi-container.ts` runs one Pi session in a container over Pi's RPC
  mode. `docker/managed-image.ts` builds the release's Pi image from
  `Dockerfile.pi` and inspects it. `docker/mcp-sidecar.ts` runs a stdio MCP server beside the session.
- `pi/host-runtime.ts` installs the pinned Pi version on the host, and
  `pi/model-catalog.ts` discovers which models it offers.
  `pi/session-extensions.ts` writes the extensions each session loads.
- `mcp.ts`, `oauth.ts`, `discord.ts` and `email.ts` talk to MCP servers, OAuth
  providers, Discord and Mailgun.

### Stores (`stores/`)

Each store owns one kind of durable state and is the only code that reads or
writes its files. For example, `message-queue.ts` holds messages waiting for
Pi, `conversation-store.ts` holds the conversation log and its model
selection, and `run-history/` records every run with secrets redacted.

### Domain (`domain/`)

Types and rules that several layers share: model selection, schedules and cron
expressions, credential sentinels, and the parser for Pi's RPC protocol.

### Platform (`platform/`)

General-purpose building blocks with no knowledge of Integral's domain, plus
`constants.ts`, which holds the Integral and pinned Pi versions and the
default ports.

## Adding code

- Put a module in the lowest layer that has everything it needs. If it needs
  something from a higher layer, the dependency usually points the wrong way:
  move the shared type down to `domain/`, or pass the dependency in.
- Name files and symbols after what they hold or do in the domain (see
  "Naming" in `AGENTS.md`).
- Resolve files shipped in the package, such as `Dockerfile.pi`, with
  `packageFile()` from `platform/package-files.ts`, never with a path relative
  to the calling module.

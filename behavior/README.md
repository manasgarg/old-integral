# Phase 1 behaviors

This directory contains the normative, test-case-oriented behavior
specifications for Phase 1.

## System model

Integral has two parts. Each behavior file belongs to one of them.

- **Core** runs Pi in a disposable box and owns the mechanisms everything else
  plugs into. Its concepts are the box, the session, the conversation and its
  queue, the channel, the gateway rule, the approval, the volume, the run
  record, and the extension host. Channels — the terminal, the configured
  Discord DM, and the scheduler — are part of core.
- **Extensions** are what Pi can do. An extension is a bundle that may
  contribute a Pi package, default gateway rules, rule plugins, Integral
  control operations, volumes, host services, and connection kinds. The box
  half of an extension runs beside software Pi can change, so it enforces
  nothing. The host half is trusted code and enforces only through the hooks
  core provides. Adding a bundled extension does not change core.

A connection contributes something core or an extension can enforce or mount:
gateway rules and their credentials, a governed repository, a store volume, or
a channel. Where a limit depends on what a request means rather than where it
goes, the matching gateway rule names a rule plugin from an extension's host
half.

### Core

- [`server.md`](server.md) — combined and separate component lifecycle
- [`container.md`](container.md) — the box: provisioning, restrictions, RPC, and session lifecycle
- [`gateway.md`](gateway.md) — gateway rules, sentinels, rule plugins, the control API, and approvals
- [`extension.md`](extension.md) — the extension host and the contract every extension follows
- [`channel.md`](channel.md) — the contract every channel follows
- [`chat.md`](chat.md) — the terminal channel
- [`discord.md`](discord.md) — the Discord DM channel and the Discord-send extension
- [`schedule.md`](schedule.md) — the scheduler channel and isolated task execution
- [`queue.md`](queue.md) — durable message ordering, editing, and deletion
- [`run.md`](run.md) — durable run records and agent-visible execution history
- [`connection.md`](connection.md) — connection setup, credentials, and roles
- [`environment.md`](environment.md) — deployment selection and container environment
- [`config.md`](config.md) — configuration files, validation, and options
- [`logging.md`](logging.md) — component diagnostics, structure, and redaction
- [`failure.md`](failure.md) — cross-cutting failure handling and cleanup
- [`upgrade.md`](upgrade.md) — deployment format, migrations, releases, and upgrades
- [`cli.md`](cli.md) — command discovery and version reporting
- [`development.md`](development.md) — local verification commands

### Bundled extensions

- [`web.md`](web.md) — web search and page retrieval, and the public web rule
- [`mcp.md`](mcp.md) — remote and stdio MCP servers
- [`email.md`](email.md) — Gmail and Mailgun accounts and the email rule plugin
- [`repository.md`](repository.md) — governed Git repositories, the Git endpoint, and landing
- [`profile.md`](profile.md) — the Pi profile repository, served by the repository extension
- [`store.md`](store.md) — durable store volumes, lifecycle, and snapshots

The Discord-send extension is specified in `discord.md`, and the task
extension in `schedule.md`.

Behavior formatting and ID rules are defined in [`AGENTS.md`](../AGENTS.md).

## Retired IDs

All sequential IDs used before the opaque-ID migration are permanently retired
and must not be assigned again. Retired opaque IDs:

- `CONNECTION-04D019E7` — rejected generic connections before they entered scope
- `BOX-64D9E7BA` — described the message queue as in-memory container state
- `CHAT-A2EAD40A` — made terminal exit destroy the shared conversation
- `CHAT-7C6DE818` — made each terminal invocation start a blank conversation
- `CONFIG-9D37B5A0` — moved logging configuration into the logging behavior group
- `CONNECTION-B4E83C2D` — defaulted Anthropic to OAuth instead of asking the user
- `CONFIG-A5D19E72` — selected the model connection and model from the main configuration
- `REPO-EB7BFD7A` — deferred repository attachment after connection creation
- `STORE-B76FB6B3` — deferred store attachment after connection creation
- `CONNECTION-11EE2FC9` — attached a configured host resource in a separate CLI operation
- `PIPKG-32C46F41` — made Integral build and understand a special untrusted Pi runtime package
- `PIPKG-B67EF4A2` — refreshed a special Integral Pi runtime outside ordinary repository lifecycle
- `PIPKG-F8406EF8` — built and activated special Integral Pi runtime artifacts
- `PIPKG-E98253F5` — gave Pi a separate source checkout for a special runtime artifact
- `PIPKG-FDA7D1DD` — routed local Integral Pi development through the retired artifact pipeline
- `SKILL-9CF01380` — specified skill layout inside profile content owned by Pi
- `SKILL-608366EB` — specified Pi's loading behavior for profile skills
- `SKILL-F9858AF9` — specified how Pi should author skills
- `SKILL-C7C81A86` — specified how Pi should version related untrusted code
- `SKILL-6D9299C4` — duplicated ordinary repository recovery for skill-specific work
- `JOURNAL-4A436073` — specified journal content and lifecycle owned by Pi
- `PREF-DEF97F16` — specified user-preference behavior owned by Pi
- `LEARN-8073E4CC` — specified a self-improvement loop owned by Pi
- `DEV-79F36207` — specified software-development behavior owned by Pi
- `PROFILE-97C5C7BA` — duplicated the ordinary repository lifecycle for Pi's profile
- `MCP-0A804DA4` — ran stdio MCP servers in a separate sidecar container instead of inside the box

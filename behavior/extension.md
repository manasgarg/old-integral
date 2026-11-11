# Extension behaviors

These behaviors define Integral extensions and the core extension host that
installs them. An extension is a bundle that may contribute any of:

- a Pi package that runs inside the box: tools, guidance, and preparation and
  shutdown steps;
- default gateway rules;
- rule plugins that the gateway calls for limits that depend on what a request
  means;
- operations on the Integral control API;
- volumes for core to mount into the box;
- host services that core starts and stops with the server;
- connection kinds and their setup.

An extension has two halves with different trust. The box half runs beside
software Pi can change, so it enforces nothing. The host half is trusted code
and enforces only through the hooks core provides. Integral bundles the web,
MCP, email, repository, store, Discord-send, and task extensions. Packages in
the Pi profile repository are plain Pi packages, not Integral extensions, and
have no host half.

## EXT-BB0DC93B — Install bundled extensions from their declarations

```text
Given each bundled extension declares the Pi package, default gateway rules, rule plugins, control operations, volumes, host services, and connection kinds it contributes
	When the server starts
		Then the extension host reads every bundled extension's declaration
			And registers each contribution with the core mechanism that owns it
			And does not need a core change to install another bundled extension with a declaration
	When a declaration is malformed or names a contribution type that core does not support
		Then the server refuses to start
			And identifies the extension and the invalid contribution
Given the Pi profile repository contains Pi packages
	When Pi loads them
		Then they run only inside the box
			And contribute no gateway rule, rule plugin, control operation, volume, host service, or connection kind
```

## EXT-DC838A48 — Split extension trust between the box and the host

```text
Given an extension's box half runs beside software that Pi can change
	When Pi or other box software modifies, bypasses, or replaces the box half
		Then the session gains no destination, credential, approval bypass, host path, or host operation beyond what core and host halves grant the session
			And every limit that an extension behavior states is enforced by a gateway rule, a rule plugin, a control operation, or the box boundary
	When an extension behavior describes a limit that its host half does not enforce
		Then that behavior labels the limit as guidance for Pi rather than a guarantee
Given an extension's host half is trusted code
	When it enforces a limit or changes host state
		Then it acts only through rule plugins, control operations, host services, and volumes registered with core
			And receives only its own connections' credentials and its own data directory from core
			And has no access to the box except through the gateway and the volumes it declared
```

## EXT-F9E9D037 — Activate extensions from active connections

```text
Given each bundled extension declares the session kinds and connection kinds it requires
	When the server starts or the connection generation changes
		Then the extension host activates the web, repository, and store extensions unconditionally
			And activates the MCP extension when at least one MCP connection is active
			And activates the email extension when at least one email connection is active
			And activates the Discord-send extension when a Discord connection is active
			And activates the task extension for isolated scheduled-task attempts
			And registers an active extension's gateway rules, plugins, control operations, volumes, and services
			And withdraws an inactive extension's contributions from sessions started afterward
	When integral provisions a session
		Then it loads the Pi package of every extension that is active for that session kind
```

## EXT-E7210F7C — Run extension host services with the server

```text
Given an active extension declares one or more host services
	When the server starts in combined or separate-component mode
		Then the extension host starts each service after the coordinator and gateway are ready and before the runner claims work
			And gives each service a loopback listener that only the gateway and core components can reach
			And reports each service's health in `integral server status`
	When a host service fails to start or later becomes unhealthy
		Then the extension host reports that extension as degraded with a bounded reason
			And keeps core and other extensions running
			And integral provisions later sessions without that extension and tells Pi it is unavailable
	When the server stops
		Then the extension host stops every host service before the gateway stops
```

## EXT-98E62846 — Give each extension its own durable state

```text
Given an active extension keeps durable host state
	When the extension host starts it
		Then it gives the extension one data directory owned by that extension under the deployment data directory
			And the extension writes durable state only there and in its declared volumes
			And the extension's on-disk format is part of the deployment format
			And a change to that format follows the deployment migration and upgrade behaviors
	When an extension becomes inactive
		Then the extension host keeps its data directory unchanged
```

## EXT-86804433 — Refuse conflicting extension contributions

```text
Given two active extensions contribute the same Pi tool name, gateway rule boundary, control operation, volume mount path, or connection kind
	When the extension host registers their contributions
		Then it refuses the conflicting contributions
			And identifies both extensions and the conflicting name or path
			And does not let either contribution silently replace the other
```

## EXT-BF55C5C2 — Describe a session's connections to its extensions

```text
Given an active extension requires one or more connection kinds
	When integral provisions a session
		Then it gives the extension's box half a read-only description of each active connection of those kinds
			And each description includes the connection name, kind, gateway boundary, non-secret settings, and credential sentinels
			And excludes real credentials, host paths, and connections of other kinds
			And lists configured but unavailable connections of those kinds with a bounded reason
	When a connection changes while a session is running
		Then the running box half keeps its original description
			And integral applies the change to the session that replaces it
```

## EXT-5C3E0B44 — Prepare extensions before Pi starts

```text
Given an active extension's Pi package declares a preparation step
	When integral provisions a session
		Then it runs the step inside the box after the mounts and gateway route are ready and before Pi starts
			And the step runs as the same non-root user and with the same gateway identity and limits as Pi
			And integral starts Pi only after every preparation step finishes or reaches its bounded deadline
	When a preparation step fails or reaches its deadline
		Then integral starts Pi without the resources that step would have prepared
			And tells Pi which extension preparation failed with a bounded reason
			And records the failure in the run record
			And does not fail the session for an optional extension
```

## EXT-6559927A — Give extensions a bounded shutdown step

```text
Given an active extension's Pi package declares a shutdown step
	When integral ends a session for idle recycling, stale-connection replacement, server shutdown, or a turn timeout
		Then it stops Pi before running any shutdown step
			And runs each shutdown step inside the box within one bounded shutdown deadline
			And then removes the box
	When the box exits, crashes, or is force-removed before every shutdown step completes
		Then integral treats the session home as unrecovered as described by `BOX-87993E3C`
```

## EXT-E75B8D10 — Let extensions supply their own guidance

```text
Given an active extension's Pi package supplies guidance text for Pi
	When integral provisions a session
		Then it adds that guidance to Pi's system prompt
			And core adds no extension-specific guidance of its own
			And an inactive extension contributes no guidance
```

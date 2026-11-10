# Extension behaviors

These behaviors define how capabilities reach Pi. An extension is a Pi package
that runs inside the box, together with the connections it uses. Extensions
give Pi convenient tools and guidance; they never enforce anything. Every limit
on what Pi can reach or change is enforced by core at the gateway or the box
boundary, so an extension that is modified, bypassed, or replaced grants
nothing extra. Adding an extension must not require a change to core.

Integral bundles the web, MCP, email, repository, store, Discord-send, and task
extensions. Further Pi extensions come from the Pi profile repository through
Pi's own package mechanism.

## EXT-BB0DC93B — Deliver extensions as Pi packages

```text
Given an extension is enabled for a session
	When integral provisions an interactive session or an isolated scheduled-task attempt
		Then it makes the extension's Pi package readable inside the box from a location outside the profile checkout
			And loads it through Pi's ordinary extension mechanism
			And mounts bundled extension packages read-only
			And gives the extension no real credential, host path, or component identity
	When an enabled extension's package is missing or fails to load
		Then integral starts Pi without that extension
			And tells Pi which extension is unavailable with a bounded reason
			And records the failure in the run record
```

## EXT-DC838A48 — Enforce nothing inside an extension

```text
Given an extension runs inside the box beside software that Pi can change
	When Pi or other box software modifies, bypasses, or replaces the extension
		Then the session gains no destination, credential, approval bypass, host path, or host operation beyond what core grants the session
			And every limit that an extension behavior states is also enforced by a gateway rule, a rule plugin, a control operation, or the box boundary
	When an extension behavior describes a limit that core does not enforce
		Then that behavior labels the limit as guidance for Pi rather than a guarantee
```

## EXT-F9E9D037 — Enable bundled extensions from active connections

```text
Given each bundled extension declares the session kinds and connection kinds it requires
	When integral provisions a session
		Then it enables the web, repository, and store extensions in every session
			And enables the MCP extension when at least one MCP connection is active
			And enables the email extension when at least one email connection is active
			And enables the Discord-send extension when a Discord connection is active
			And enables the task extension only in an isolated scheduled-task attempt
			And decides which extensions to enable from those declarations alone
			And does not need a core change to bundle another extension with a declaration
```

## EXT-BF55C5C2 — Describe a session's connections to its extensions

```text
Given an enabled extension requires one or more connection kinds
	When integral provisions a session
		Then it gives the extension a read-only description of each active connection of those kinds
			And each description includes the connection name, kind, gateway boundary, non-secret settings, and credential sentinels
			And excludes real credentials, host paths, and connections of other kinds
			And lists configured but unavailable connections of those kinds with a bounded reason
	When a connection changes while a session is running
		Then the running extension keeps its original description
			And integral applies the change to the session that replaces it
```

## EXT-5C3E0B44 — Prepare extensions before Pi starts

```text
Given an enabled extension declares a preparation step
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
Given an enabled extension declares a shutdown step
	When integral ends a session for idle recycling, stale-connection replacement, server shutdown, or a turn timeout
		Then it stops Pi before running any shutdown step
			And runs each shutdown step inside the box within one bounded shutdown deadline
			And then removes the box
	When the box exits, crashes, or is force-removed before every shutdown step completes
		Then integral treats the session home as unrecovered as described by `BOX-87993E3C`
```

## EXT-E75B8D10 — Let extensions supply their own guidance

```text
Given an enabled extension supplies guidance text for Pi
	When integral provisions a session
		Then it adds that guidance to Pi's system prompt
			And core adds no capability-specific guidance of its own
			And a disabled extension contributes no guidance
```

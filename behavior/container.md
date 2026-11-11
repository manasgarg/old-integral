# Container behaviors

These behaviors cover core's box: provisioning the Pi container from its
image, restricting it, running Pi over RPC, and ending the session. The box is
disposable. Anything that must outlive it leaves through the conversation
record, the run record, a governed repository, a store, or the gateway.

<!-- Automation note (BOX-AB639757): The image, RPC command, session restoration, and lifecycle orchestration are automated; launching the real image is not run in the default suite because its execution environment has no Docker-daemon access. -->
<!-- Automation note (BOX-601613D4): The default suite verifies the complete Docker argument and mount specification; `npm run test:acceptance:docker` inspects the live container's kernel-enforced identity, filesystem, capabilities, resources, mounts, and network. -->
<!-- Automation note (BOX-B45DEA9B): Single-session reuse is tested at the runner lifecycle boundary; a live multi-turn provider call is not made by the offline suite. -->
<!-- Automation note (BOX-BE26C696): Timeout, release, and cleanup paths are automated at the protocol boundary; real container termination is not exercised without a Docker daemon. -->
<!-- Automation note (BOX-7D3A19E4): Idle timer and session cleanup paths are automated without waiting five real minutes or launching Docker. -->
<!-- Automation note (BOX-C28F4A61): Provisioning-failure release behavior is automated without deliberately failing a live Docker daemon. -->
<!-- Automation note (BOX-40521095): Package policy, authenticated control routing, immutable image replacement, and recipe identity are automated; the Docker acceptance profile verifies packages in a live image. -->
<!-- Automation note (BOX-6A91C3E7): Host-managed image-recipe projection, Git proposal approval, constrained build context, fresh floating resolution, and exact-tree activation are automated, with live builds covered by the Docker acceptance profile. -->

## BOX-AB639757 — Start Pi for the first message

```text
Given the coordinator, runner, and gateway are healthy
	And no Pi session is active
	And the durable queue contains a message ready for delivery
	When the runner claims the next queued message from the coordinator
		Then integral creates a fresh temporary session home
			And starts one non-root Docker container for Pi on the locked network
			And runs each enabled extension's preparation step before starting Pi
			And runs the immutable Pi image recorded with the conversation selection in RPC mode with session persistence and approval prompts disabled
			And runs Pi offline so Pi does not perform its own startup network operations
			And loads every enabled extension into Pi
			And keeps container standard input attached for the lifetime of the RPC session
			And supplies the conversation's selected model connection and model
			And supplies only a sentinel credential in the authentication shape required by the selected provider
			And omits API-key environment variables when the selected model connection uses OAuth
			And restores conversational context from the durable conversation record
			And sends the claimed message as a Pi `prompt` command
```

## BOX-E1F472A1 — Take the Pi version from the release's base image

```text
Given each Integral release names exactly one base image as described by `UPGRADE-79DEFC3A`
	And that base image contains exactly one Pi version
	When integral builds or selects a Pi image for the deployment
		Then the Pi in that image is the base image's Pi version
			And never installs a floating `latest` Pi version
	When integral begins Pi-specific OAuth or opens the model chooser
		Then it uses exactly the base image's Pi version
			And installs that version under deployment runtime state when no valid host runtime for it is installed
			And reuses an installed host runtime for that version without querying the npm registry
			And the chooser discovers providers and models from the selected image
			And records the immutable image identity when the user selects a model
	When installing that Pi version on the host fails
		Then the Pi-dependent operation exits non-zero
			And explains that the release's Pi version could not be installed
			And does not fall back to another installed Pi version
Given a conversation selection records an immutable image identity
	When the runner provisions or reuses a Pi container
		Then it uses that immutable image identity
			And reports the Pi version contained in that image
			And treats an image identity change as a model-selection change
			And never substitutes another locally tagged Pi image
```

## BOX-601613D4 — Apply container restrictions

```text
Given integral is provisioning a Pi container
	When Docker receives the container specification
		Then the container runs as a non-root user
			And disables privilege escalation
			And drops additional Linux capabilities
			And uses a read-only root filesystem
			And mounts `/tmp` as a size-bounded `tmpfs` with execution and set-user-ID disabled
			And mounts one fresh session home and explicitly configured host stores as the only writable host filesystems
			And keeps every repository clone inside that fresh session home
			And mounts each host store only at its recorded mount path
			And does not mount canonical repositories or unconfigured host directories
			And does not mount the Docker socket
			And does not mount control-plane configuration or credentials
			And mounts only the gateway CA, bundled extension packages, curated read-only run history, unrecovered session homes, fresh temporary session home, store lock namespace, and configured store directories as required
			And mounts bundled extension packages, run history, and unrecovered session homes read-only
			And uses server-created history mount destinations that remain removable during session cleanup
```

## BOX-B45DEA9B — Keep one warm Pi conversation

```text
Given integral has an active Pi RPC session
	When the runner claims another message after the prior turn completes
		Then integral sends it to the same Pi process
			And sends it to the same Pi session
			And preserves preceding turns as conversational context
			And cancels a pending idle shutdown before starting the turn
			And does not start a second Pi container or rerun extension preparation
```

## BOX-BE26C696 — Bound a stuck turn

```text
Given Pi does not finish a turn within the configured turn timeout
	When the timeout expires
		Then integral stops Pi
			And reports that the turn timed out
			And durably returns the in-flight message to the queue
			And runs extension shutdown steps within the bounded shutdown deadline
			And revokes temporary session credentials
			And force-removes the Docker container if it has not exited five seconds after the shutdown deadline
			And removes temporary session data unless the session home is unrecovered
```

## BOX-7D3A19E4 — Recycle an idle Pi session without ending the conversation

```text
Given the durable queue is empty
	And the Pi session has no turn in flight
	When the Pi idle timeout expires
		Then integral stops Pi
			And runs extension shutdown steps within the bounded shutdown deadline
			And terminates the Pi container
			And revokes its temporary session token
			And preserves the durable conversation record and queue
			And keeps attached terminals connected
			And starts a replacement session when another message is queued
```

## BOX-C28F4A61 — Return a message when Pi provisioning fails

```text
Given the runner has claimed a queued message
	When it cannot provision or start the Pi container
		Then integral durably returns the message to its prior queue position
			And removes the partially started container
			And records the provisioning failure
			And reports the failure on the message's reply route
```

## BOX-40521095 — Govern Pi image package changes

```text
Given Pi runs in an immutable managed image without host Docker access
	When Pi lists the image's Debian packages through the Integral control API
		Then Integral returns the durable desired package set and its revision
			And includes the packages the base image provides
	When Pi requests installation of valid Debian package names at the current revision
		Then Integral builds a replacement image on the release's base image
			And obtains packages only through the base image's configured APT repositories
			And records the new desired package set and immutable image identity
			And replaces the current container after the active turn completes
	When Pi requests an upgrade of desired packages at the current revision
		Then Integral rebuilds the replacement image without cached package layers
			And records a new revision and immutable image identity
	When Pi submits command syntax, an unknown package for upgrade, or a stale revision
		Then Integral rejects the request without changing package state or the selected image
```

## BOX-6A91C3E7 — Let Pi author its next managed image

```text
Given Integral owns a dedicated governed Git repository for the deployment's Pi image overlay
	And Integral's base image, runtime user, gateway trust, entrypoint, and security constraints are outside that repository
	And the image repository has an immutable host-managed `approval-required` write policy
	When Integral provisions a Pi session
		Then it gives Pi a writable per-run checkout of the active image-recipe commit at a documented container path
			And includes a Dockerfile whose `FROM` line names the release's base image by digest
			And tells Pi that it runs in an ephemeral managed container
			And tells Pi that edits affect only a future replacement image after human approval
			And does not mount the canonical host repository, Docker socket, build credentials, or host Dockerfile into the container
	When Pi commits an image-recipe change and submits it through `repo_push`
		Then Integral treats the commit as an image proposal governed by `REPO-7B0E2F4A`
			And presents the exact Dockerfile and artifact diff, base commit, proposed commit, and tree digest for approval
			And keeps the active recipe ref and selected image unchanged before approval
	When the active Dockerfile declares an exact package version or immutable image digest
		Then Integral uses that exact declaration on every build
	When the active Dockerfile declares a floating package version, mutable image tag, or unversioned operating-system package
		Then Integral treats resolution at build time as intentional recipe behavior
			And does not describe the recipe commit as a reproducible package lock
			And tells an approving human that repository state may resolve differently at execution time
	When Pi requests a fresh rebuild of the active image recipe
		Then Integral creates an approval request bound to the active recipe commit, base image reference, and floating-resolution intent
			And does not build or select an image before approval
	When a trusted local operator runs `integral image edit`
		Then Integral validates and commits the Dockerfile change directly through the host boundary
			And records the operator and exact Git change without creating an approval request
	When a trusted local operator runs `integral image rebuild`
		Then Integral treats the command itself as direct human authorization to rebuild the active recipe
			And records the operator without creating an approval request or inventing a Pi session
	When host automation or a remote API requests a fresh rebuild without starting Pi
		Then Integral creates the same governed rebuild request used for Pi
			And records the external actor instead of inventing a Pi session
			And requires human approval before building
	When a human approves the exact image proposal
		Then Integral builds only the approved commit and complete tree digest
			And uses a build context containing only validated files from that tree
			And provides no host source tree, session credentials, Docker socket, or undeclared secret to the build
			And applies bounded build time, CPU, memory, output size, and network policy
			And records the base image reference, recipe base and proposal commits, tree digest, approval ID, and resulting immutable image digest
	When Integral executes a fresh rebuild authorized by approval or the trusted local CLI
		Then Integral pulls mutable references in the recipe's own additions again
			And reruns dependency installation without Docker layer-cache reuse
			And refreshes package indexes within the build as directed by the Dockerfile
			And resolves `latest`, ranges, mutable tags, and unversioned packages against their configured repositories at build time
			And never substitutes an older selected package version for a floating Dockerfile declaration
			And records the recipe commit, prior image digest, resulting image digest, and actual installed package inventory
			And permits the resulting image digest and installed inventory to differ from an earlier build of the same recipe commit
	When the approved image build and validation succeed
		Then Integral compare-and-swap advances the active recipe ref from the approved base to the approved commit
			And selects the resulting immutable image for replacement sessions
			And starts or recycles Pi according to the approval continuation lifecycle
	When the build or image validation fails
		Then Integral records and broadcasts a failed approval outcome
			And leaves the active recipe ref and selected image unchanged
			And keeps the proposal commit available according to bounded audit and recovery policy
	When Pi proposes a recipe that changes the `FROM` line or requires an undeclared build input
		Then Integral rejects it without requesting approval or starting a build
	When a later Pi session starts from an activated recipe
		Then its projected image-recipe checkout identifies the exact active commit and base image reference
			And Pi can propose a rollback or further change through the same approval-gated path
```

## BOX-62AC107F — Rebuild the deployment image on a new release's base image

```text
Given Integral owns the deployment's governed Pi image-recipe repository
	And Integral owns the recipe's `FROM` line, which names the release's base image by digest
	When a newly activated release names a different base image than the active recipe
		Then Integral commits a change that replaces only the `FROM` line with the new base image digest
			And records the change as made by Integral with the prior and resulting commits, tree digest, and both base image references
			And does not create an approval request
			And builds the deployment image from the updated recipe as described by `BOX-36221C31`
			And validates the built image as described by `BOX-935CCD92`
			And selects the validated image for the conversation and for sessions started afterward
			And records the prior image, resulting image, base images, and Pi versions in the run history
	When the build or validation fails
		Then Integral keeps the previous image selected if the new release supports its base image
			And reports the failure with the failing recipe step and a bounded reason
			And tells Pi in the next session that its image could not be moved to the new base
			And otherwise stops starting Pi sessions and tells the user how to repair the recipe or roll back
	When the active Dockerfile names a base image that no Integral release published
		Then Integral leaves the recipe unchanged
			And refuses to build it until the `FROM` line names the release's base image
	When an image proposal or rebuild request is bound to the recipe commit from before the move
		Then Integral rejects it without building
			And leaves the active recipe and selected image unchanged
	When the deployment is rolled back to an earlier release
		Then the restored selection uses the earlier image
			And Integral keeps each prior deployment image while a retained backup refers to it
```

## BOX-87993E3C — Retain an unrecovered session home

```text
Given a session ends before every extension shutdown step completed
	When integral removes the box
		Then it keeps that session's home on the host instead of deleting it
			And records it as unrecovered with its session and run identity
			And revokes the ended session's credentials as usual
	When integral provisions the next session in the deployment
		Then it mounts each unrecovered session home read-only at `/home/pi/history/unrecovered/<session-id>`
			And runs extension preparation steps after that mount is available
			And deletes an unrecovered session home after every preparation step in that session succeeds
	When an unrecovered session home exceeds the configured retention period
		Then integral deletes it
			And records the expiry in the run history
	When integral restarts with unrecovered session homes
		Then it keeps them and offers them to the next session
```

## BOX-36221C31 — Run the base image directly for an unchanged recipe

```text
Given a deployment's image recipe contains only the `FROM` line that names the release's base image
	When Integral needs the deployment image
		Then it selects the base image by digest without building a local image
			And records the base image as the deployment image
	When the recipe contains additional instructions
		Then Integral builds a local image with those instructions as layers on top of the base image
			And never rebuilds or replaces the base image's own layers
	When an operator or approved Pi proposal removes every local addition
		Then Integral selects the base image directly again
```

## BOX-935CCD92 — Keep the box compatible with the host release

```text
Given the running release names its base image and the oldest base image it supports
	When Integral validates a built deployment image
		Then it starts a short-lived box from the image with the same restrictions as a Pi session
			And confirms the image contains the base image's Pi version and runtime user
			And confirms Pi starts in RPC mode and loads every bundled extension package
			And rejects an image whose additions replaced Pi, the runtime user, the entrypoint, or the gateway trust configuration
	When Integral provisions a Pi session
		Then it mounts the bundled extension packages from the running release read-only
			And never takes them from the image
			And so the box half and host half of every bundled extension come from the same release
	When the selected image is built on a base image older than the oldest one the release supports
		Then Integral refuses to start Pi sessions from it
			And reports the base image the release requires
```

# Container behaviors

These behaviors cover the runner component provisioning and managing the warm
Pi RPC container.

<!-- Automation note (BOX-AB639757): The image, RPC command, session restoration, and lifecycle orchestration are automated; launching the real image is not run in the default suite because its execution environment has no Docker-daemon access. -->
<!-- Automation note (BOX-601613D4): The default suite verifies the complete Docker argument and mount specification; `npm run test:acceptance:docker` inspects the live container's kernel-enforced identity, filesystem, capabilities, resources, mounts, and network. -->
<!-- Automation note (BOX-B45DEA9B): Single-session reuse is tested at the runner lifecycle boundary; a live multi-turn provider call is not made by the offline suite. -->
<!-- Automation note (BOX-BE26C696): Timeout, release, and cleanup paths are automated at the protocol boundary; real container termination is not exercised without a Docker daemon. -->
<!-- Automation note (BOX-7D3A19E4): Idle timer and session cleanup paths are automated without waiting five real minutes or launching Docker. -->
<!-- Automation note (BOX-C28F4A61): Provisioning-failure release behavior is automated without deliberately failing a live Docker daemon. -->

## BOX-AB639757 — Start Pi for the first message

```text
Given the coordinator, runner, and gateway are healthy
	And no Pi session is active
	And the durable queue contains a message ready for delivery
	When the runner claims the next queued message from the coordinator
		Then integral creates a fresh temporary session home
			And starts one non-root Docker container for Pi on the locked network
			And runs the release's Pi image in RPC mode with session persistence and approval prompts disabled
			And runs Pi offline so Pi does not perform its own startup network operations
			And keeps container standard input attached for the lifetime of the RPC session
			And supplies the conversation's selected model connection and model
			And supplies only a sentinel credential in the authentication shape required by the selected provider
			And omits API-key environment variables when the selected model connection uses OAuth
			And restores conversational context from the durable conversation record
			And sends the claimed message as a Pi `prompt` command
```

## BOX-E1F472A1 — Use the Pi runtime and image pinned by the release

```text
Given the integral release pins one exact Pi version
	And integral begins Pi-specific OAuth or opens the model chooser
	When no valid runtime for the pinned version is installed
		Then integral installs exactly the pinned version under deployment runtime state
	When a valid runtime for the pinned version is already installed
		Then integral reuses the installed host runtime without querying the npm registry
			And does not reinstall Pi
	When installing the pinned version fails
		Then the Pi-dependent operation exits non-zero
			And explains that the pinned Pi version could not be installed
			And does not fall back to another installed Pi version
Given the integral release ships the Dockerfile for its Pi image
	When integral reads that Dockerfile
		Then it names its base image by an immutable digest
			And installs the pinned Pi version
			And never installs a floating `latest` Pi version
	When integral needs the Pi image
		Then it uses the image built from the release's Dockerfile
			And builds that image only when it is not present locally
			And tags the image with the integral version, a digest of the release's image inputs, and the pinned Pi version
			And gives releases with different image inputs different tags
	When the model chooser lists models
		Then it discovers providers and models from the release's Pi image
Given the conversation has a model selection
	When integral records the model selection
		Then it records only the model connection, provider, and model
			And ignores a Pi version or image that an earlier release recorded with the selection
	When the runner provisions a Pi container for a conversation turn
		Then it uses the release's Pi image and pinned Pi version
			And the run record names the Pi version and image it used
			And never substitutes a Pi image recorded by an earlier release
Given integral runs Pi in a container
	When integral gives Pi its tools and instructions
		Then no tool lets Pi change, rebuild, or replace its image or the image's packages
			And integral tells Pi that the release fixes the image
	When the main configuration sets `image` or `pull_policy` in `[runner]`
		Then configuration validation rejects the option as unknown
Given a deployment written by an earlier release let Pi or the operator edit the Pi image
	When `integral migrate` moves the deployment to this release's format
		Then integral removes the image recipe repository, image audit history, package state, and active image record
			And removes every approval request, approval audit record, and queued approval continuation
			And removes the Pi version and image from every model selection
			And removes the write policy from every governed resource record
			And removes `image` and `pull_policy` from the `[runner]` table of the main configuration
			And leaves every other configuration line unchanged
			And keeps the model connection, provider, and model of every selection
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
			And places governed per-run repository checkouts only inside that fresh session home
			And mounts each host store only at its recorded mount path
			And does not mount canonical repositories or unconfigured host directories
			And does not mount the Docker socket
			And does not mount control-plane configuration or credentials
			And mounts only the gateway CA, curated read-only run history, fresh temporary session home, store lock namespace, and configured store directories as required
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
			And does not start a second Pi container or duplicate an existing MCP sidecar
```

## BOX-BE26C696 — Bound a stuck turn

```text
Given Pi does not finish a turn within the configured turn timeout
	When the timeout expires
		Then integral requests container termination
			And reports that the turn timed out
			And durably returns the in-flight message to the queue
			And removes temporary session data
			And revokes temporary session credentials
			And terminates every MCP sidecar owned by the timed-out session
			And force-removes the Docker container if it has not exited five seconds after SIGTERM
```

## BOX-7D3A19E4 — Recycle an idle Pi session without ending the conversation

```text
Given the durable queue is empty
	And the Pi session has no turn in flight
	When the Pi idle timeout expires
		Then integral terminates the Pi container
			And terminates every MCP sidecar owned by that Pi session
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
			And terminates every partially started MCP sidecar
			And records the provisioning failure
			And reports the failure to every attached terminal
```

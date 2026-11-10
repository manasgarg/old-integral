# Governed repository behaviors

These behaviors cover host-canonical Git repositories. Integral serves each
governed repository from its Git endpoint, reachable only through the gateway.
The bundled repository extension clones every active repository into the
session before Pi starts and saves unlanded work when the session ends. Every
push reaches the governed Git landing rule plugin, which validates it and
advances the canonical branch. Existing bare repositories may enter the same
lifecycle through a host connection.

<!-- Automation note (REPO-7B0E2F4A): Selective approval-gated repository landing, exact proposal review, stale-ref refusal, denied writes, and direct local image editing are automated. -->

## REPO-CC68A6EF — Serve governed repositories through the gateway

```text
Given one or more governed repositories are active
	When an authenticated session uses Git smart HTTP against Integral's Git endpoint through the gateway
		Then the endpoint serves only repositories visible to that session
			And permits fetch and clone of each canonical branch and of recovery refs
			And sends every push to the governed Git landing rule plugin
			And authenticates the session by its gateway identity without another Git credential
			And never runs Git against Pi-writable repository metadata
	When a session requests a repository that is soft-deleted, unavailable, or belongs to another deployment
		Then the endpoint refuses it with `resource_soft_deleted`, `resource_unavailable`, or not found
	When box software attempts to reach a canonical repository by SSH, a host path, or another transport
		Then no route exists
```

## REPO-D1865075 — Give Pi repository lifecycle tools through the repository extension

```text
Given integral provisions any interactive or isolated scheduled Pi session
	When it enables the repository extension
		Then the extension registers `repo_list`, `repo_create`, `repo_push`, `repo_recovery_discard`, `repo_delete`, and `repo_restore`
			And supplies guidance on the commit-before-push and soft-delete semantics
			And explains that creation and restoration replace the calling session while deletion changes mounted resources only for later sessions
			And sends lifecycle operations to the Integral control API through the gateway
			And implements `repo_push` as an ordinary Git push to Integral's Git endpoint
			And keeps the tools available when no repository connection exists yet
	When a repository tool or Git request carries an expired, revoked, or mismatched session identity
		Then integral rejects it without reading or changing repository state
```

## REPO-403F597E — Create a governed repository from Pi

```text
Given Pi has an authenticated integral session
	When Pi calls `repo_create` with a unique connection name and mount path
		Then integral creates a stable repository ID
			And creates a bare canonical repository under the deployment data directory
			And initializes its canonical branch as `main`
			And records the canonical path and filesystem identity of its backing root
			And records the requested mount path with the repository connection
			And marks the current session for replacement after the tool reports durable creation
			And the replacement session's repository extension clones it at that path before the next Pi prompt
			And uses the same path in every later Pi session
			And does not expose the canonical host path to Pi
	When canonical creation fails
		Then the tool reports failure without an active repository connection
			And removes any incomplete canonical repository created by that operation
```

## REPO-515BAAB9 — Constrain agent-visible resource mount paths

```text
Given Pi or the connection CLI creates, adds, or restores a governed repository or store
	When integral validates the requested mount path
		Then it requires an absolute normalized path below `/home/pi`
			And rejects `/home/pi` itself
			And rejects `.pi`, `history`, Integral control paths, and their descendants except the exact host-designated `pi-profile` mount at `/home/pi/.pi`
			And rejects every other repository or store at, above, or below the reserved profile mount
			And rejects traversal, a symlink escape, or a target outside the current session home
			And rejects a path equal to, above, or below another governed resource mount
			And rejects a target containing files not owned by that resource
			And records the normalized container path rather than a host path
```

## REPO-A690931F — Clone every active governed repository into every Pi session

```text
Given one or more governed repository connections are active and have mount paths
	When the repository extension prepares an interactive or isolated scheduled Pi session
		Then it clones each repository from Integral's Git endpoint through the gateway
			And places each clone at its recorded mount path inside the session home
			And checks out a branch whose identity includes the run ID
			And configures `origin` as Integral's Git endpoint for that repository
			And permits `git fetch origin` and `git push origin`
			And no canonical repository or host parent directory is mounted into the box
	When a repository cannot be cloned at its recorded path
		Then the extension removes any partial clone for that repository
			And Pi starts with the remaining repositories
			And the extension tells Pi which named repository is unavailable without exposing a host path
	When host health checks find a repository's backing path invalid
		Then integral marks the connection unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation
```

## REPO-CDA4609A — Land directly writable repository work through the landing plugin

```text
Given Pi has committed work on a current-run governed repository branch
	And that repository's host-managed write policy is `direct`
	When a push to the canonical branch reaches the governed Git landing rule plugin
		Then the plugin derives the repository and run identity from the authenticated session
			And receives the pack into a fresh quarantine repository
			And verifies the pack and runs Git object integrity checks
			And validates the complete proposed tree before changing the canonical repository
			And accepts regular files, executable files, and symbolic links with safe relative targets
			And rejects Git links, unsafe paths, oversized files, and a repository over its configured limit
			And executes no hook from the pack or canonical repository
			And advances the canonical branch to the proposed head only by compare-and-swap fast-forward
			And preserves Pi's commits without creating a host merge commit
			And records the repository ID, prior head, landed head, run ID, and changed paths in the host-attested run history
			And reports success only after the canonical ref update is durable
	When a push targets any ref other than the canonical branch or the run's recovery ref
		Then the plugin refuses it without changing the canonical repository
```

## REPO-9C4A71E2 — Require an explicit disposition for repository commits

```text
Given Pi works in a run-scoped governed repository checkout
	When Pi creates commits it wants to keep
		Then it pushes them before reporting the repository work complete
			And reports the landed canonical commit rather than only the run-branch commit
	When Pi decides not to land commits it created
		Then it undoes those commits and their file changes in the run checkout before reporting completion
			And does not deliberately leave rejected work for recovery
	When the repository extension describes governed repository work to Pi
		Then it explains that a local commit is not durable until a push lands
			And explains the required land-or-undo disposition before completion
```

## REPO-7B0E2F4A — Approval-gate selected host-managed repositories

```text
Given every governed repository has a host-managed write policy of `direct`, `approval-required`, or `denied`
	And Pi cannot change that policy
	When a push reaches the governed Git landing rule plugin
		Then the plugin derives the repository ID and policy from the authenticated session
			And never trusts a policy, host path, approval status, or repository identity supplied by the box
	When the push targets an `approval-required` repository
		Then the plugin receives and validates the proposed commit through the ordinary quarantine boundary
			And stores the valid proposal under an approval-specific ref without advancing the canonical branch
			And binds the approval to the repository ID, current canonical base commit, proposed commit, complete tree digest, changed paths, originating session and run, and repository lifecycle revision
			And shows the exact commit diff and safe validation summary to the approving human
			And does not expose unvalidated Git objects to the canonical repository
	When a human approves that exact repository proposal
		Then integral revalidates the quarantined objects, complete proposed tree, repository lifecycle revision, and canonical base commit
			And invokes the repository's idempotent approved-mutation executor for that exact proposal
			And refuses any file, commit, tree, ref, or policy change made after approval was requested
	When the canonical branch or lifecycle revision changed after the proposal was created
		Then integral records a stale approval outcome without advancing the canonical branch
			And lets Pi fetch, rebase, and submit a new proposal requiring a new approval
	When a human denies the proposal or its approval expires
		Then integral leaves the canonical branch unchanged
			And retains only the bounded proposal and audit material required by policy
	When the push targets a `denied` repository
		Then the plugin rejects it without accepting a proposal or changing repository state
	When a session fetches or clones
		Then integral permits it according to ordinary session and repository policy without mutation approval
	When a trusted local operator edits an `approval-required` image-recipe repository through `integral image edit`
		Then integral treats the local CLI invocation as direct human authority for that repository
			And validates and durably commits the exact change without creating an approval request
			And records the operator, prior commit, landed commit, tree digest, and changed paths in host audit history
```

## REPO-37441347 — Refuse stale or malformed repository landings safely

```text
Given a governed repository canonical branch may have advanced since a run began
	When a push proposes a head that does not descend from the current canonical head
		Then the landing plugin refuses it without changing the canonical repository
			And reports the current canonical head
			And permits Pi to fetch, rebase, resolve conflicts, and retry from its checkout
	When a pack, proposed head, commit range, or tree fails validation
		Then the landing plugin refuses it without importing unvalidated refs into the canonical repository
			And records a redacted refusal reason in the run history
			And leaves the checkout available for Pi to correct and retry
```

## REPO-BB20CA23 — Preserve unlanded work when a run ends

```text
Given a governed repository checkout differs from its landed canonical head
	When the repository extension's shutdown step runs
		Then it commits any uncommitted changes to a recovery commit without changing the run branch
			And pushes the work to the run's recovery ref through Integral's Git endpoint
			And the landing plugin validates the recovery push like any other push but writes only the recovery ref
			And integral records whether the checkout contained committed or uncommitted changes
			And makes the recovery ref visible in repository status for a later run
	When the session ends before that shutdown step completes
		Then integral retains the session home as unrecovered as described by `BOX-87993E3C`
			And a later session's repository extension performs the same recovery from the retained checkout before its own preparation completes
	When the checkout has no work beyond its landed canonical head
		Then the extension pushes no recovery ref
	When a recovery ref exceeds the configured retention period
		Then integral removes it without changing the canonical branch
			And records the expiration in host-attested repository history
```

## REPO-54D1B8C7 — Review recovered work using its originating run

```text
Given one or more repository recovery refs exist
	When the repository extension prepares a later Pi session
		Then its guidance identifies each recovery ref and its originating session
			And instructs Pi to find and examine the originating run log before deciding its disposition
			And instructs Pi to either land the recovered work through a push or remove the recovery ref
	When Pi decides recovered work should be kept
		Then it fetches and applies the recovery ref to its run checkout
			And lands the resulting commit through a push
	When Pi decides recovered work should not be kept
		Then it calls the governed recovery-discard operation
			And integral removes only that recovery ref and its recovery metadata
```

## REPO-95B5606D — Soft-delete a governed repository from Pi

```text
Given an active governed repository is visible to Pi
	Or an unavailable governed repository is visible to Pi
	When Pi calls `repo_delete` with its repository ID and expected lifecycle revision
		Then integral records a tombstone containing the repository identity, canonical branch, prior mount path, and deletion actor
			And removes the repository from the active connection inventory
			And prevents every existing checkout from landing after the deletion revision
			And Integral's Git endpoint rejects later pushes and fetches from those checkouts as `resource_soft_deleted`
			And leaves every existing Pi session and checkout running until its ordinary end
			And lets those checkouts continue local edits and Git commits
			And accepts recovery pushes for unlanded work from those checkouts when their sessions end
			And omits the repository from every session started after deletion
			And preserves the canonical repository and its complete history
			And reports that the current session retains its checkout until it ends
	When the expected lifecycle revision is stale
		Then integral rejects deletion without changing the repository or its active checkouts
```

## REPO-1C3B9872 — Keep repository sessions running after backing failure

```text
Given a Pi session has a governed repository checkout
	When trusted host code detects that the canonical repository is missing, inaccessible, invalid, or replaced by another filesystem identity
		Then integral marks the connection unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation
			And leaves the existing Pi session and checkout running until its ordinary end
			And lets local file edits and Git commits succeed or fail normally inside that checkout
			And Integral's Git endpoint rejects pushes, fetches, and later lifecycle operations with `resource_unavailable`
	When the session ends while the repository is unavailable
		Then the recovery push fails
			And integral retains the session home as unrecovered as described by `BOX-87993E3C`
	When integral starts a later Pi session
		Then the repository extension omits the unavailable repository
			And tells Pi the connection name and bounded availability reason without exposing its host path
```

## REPO-F96C6AE6 — Restore a soft-deleted governed repository

```text
Given a governed repository has a tombstone and its canonical repository remains available
	When Pi calls `repo_restore` with its repository ID, expected lifecycle revision, and a valid mount path
		Then integral reactivates the same stable repository and canonical history
			And records the newly chosen mount path
			And marks the current session for replacement after the tool reports durable restoration
			And creates a checkout at that path before the next Pi prompt
			And advances the lifecycle revision without rewriting repository history
	When the canonical repository is missing or the requested path is invalid
		Then integral leaves the tombstone unchanged
			And reports why restoration could not complete
```

## REPO-4EB2390E — Apply one lifecycle to every governed repository

```text
Given a governed repository was created through Pi or added from an existing host path
	When Pi or the connection CLI performs a lifecycle operation
		Then integral applies the same states, revisions, tools, and restoration rules
			And does not record or expose an ownership or provenance classification
	When Pi soft-deletes it or the user removes its connection
		Then integral removes access and preserves a tombstone
			And never deletes, moves, rewrites, or changes filesystem ownership of the canonical repository merely because access was removed
			And a successful governed landing remains the only operation allowed to advance its selected canonical branch
```

## REPO-CEE2CA38 — Expose governed repository inventory without host paths

```text
Given active, unavailable, and soft-deleted governed repositories may exist
	When Pi calls `repo_list`
		Then integral returns each repository's stable ID, connection name, lifecycle state, lifecycle revision, canonical branch, and mount path
			And reports a bounded availability reason for an unavailable repository
			And identifies recovery artifacts with unlanded work
			And does not return canonical host paths or another deployment's repositories
	When Pi calls a repository tool using only a path
		Then integral requires the path to resolve to exactly one repository in the authenticated session
			And otherwise requires the stable ID or connection name
```

## REPO-D987932B — Serialize repository lifecycle and landing operations

```text
Given several Pi runs or host commands act on one governed repository concurrently
	When integral creates, adds, pushes, soft-deletes, or restores it
		Then the host serializes validation and state changes by stable repository ID
			And uses lifecycle revisions for connection-state compare-and-swap
			And uses canonical commit IDs for branch compare-and-swap
			And never exposes a partially updated connection record, canonical ref, checkout, or tombstone
			And a process restart recovers the last durable lifecycle state and canonical head

Given permanent deletion of repository content is outside the governed lifecycle
	When Pi or the connection CLI requests removal
		Then integral offers only soft deletion
			And leaves permanent canonical purging outside this phase
```

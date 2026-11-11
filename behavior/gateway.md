# Gateway behaviors

These behaviors cover the gateway, core's single enforcement point for
everything that leaves the box. Gateway rules come from active connections and
from active extensions' defaults. A rule may name a rule plugin, contributed by
an extension's host half, for limits that depend on what a request means
rather than where it goes, and it may require human approval. The box half of
an extension never enforces policy.

<!-- Automation note (GATEWAY-A2BBBBE8): Boundary matching, sentinel removal, credential injection, and forwarding construction are automated; a public TLS upstream is not contacted by the offline suite. -->
<!-- Automation note (GATEWAY-EC79406A): The default suite verifies the internal-network Docker specification; `npm run test:acceptance:docker` also verifies that a live container has no direct external route. -->
<!-- Automation note (GATEWAY-846B1000): Durable approval mechanics are covered at component boundaries; Discord publication and identity decisions require controlled Discord acceptance fixtures. -->

## GATEWAY-3F299566 — Verify the expected gateway

```text
Given the integral gateway component is healthy
	When the CLI requests the gateway health endpoint
		Then the gateway returns success
			And identifies the current deployment
			And reports its current ready or degraded state
			And includes its current error when degraded
			And lets the CLI distinguish it from an unrelated process on the same port
```

## GATEWAY-578CEF2E — Reject an unauthenticated proxy request

```text
Given the gateway is running
	When a client makes a proxy request without a valid active-session token
		Then the gateway returns HTTP 407 with a Basic proxy-authentication challenge
			And does not connect to the upstream host
```

## GATEWAY-B6C64AA7 — Attribute an authenticated request

```text
Given an active chat has a unique session token
	When its container sends a request through the gateway
		Then the container supplies the token as the password in Basic proxy authentication
			And the gateway associates the request with that chat session
			And removes proxy authorization and proxy connection headers before forwarding
			And rejects the token after the session ends
```

## GATEWAY-08EEB2DC — Evaluate every request against gateway rules

```text
Given every active connection and active extension contributes zero or more gateway rules
	And each rule names a scheme, host, port, path prefix, allowed methods, credential placement, optional rule plugin, and whether approval is required
	And core contributes the Integral control rule
	When an authenticated session sends a request through the gateway
		Then the gateway selects the most specific rule whose boundary and method match the request
			And refuses the request when no rule matches
			And applies only the selected rule's credential, rule plugin, and approval requirement
			And treats core, connection, and extension rules the same way
	When two active rules match a request with equal specificity
		Then the gateway refuses the request
			And reports the conflicting connections or extensions without exposing credentials
```

## GATEWAY-A2BBBBE8 — Forward a request allowed by a gateway rule

```text
Given an authenticated chat container is active
	And its request matches a gateway rule's scheme, host, port, method, and path
	And the rule's plugin, when present, allows the request
	When Pi sends the request through the gateway
		Then the gateway establishes a verified upstream TLS connection
			And replaces the managed sentinel with the connection's real credential when authentication requires it
			And removes any other managed sentinel authentication header
			And refuses a caller-supplied credential that is not the integral sentinel
			And forwards the upstream response to Pi
			And does not log the real credential
```

## GATEWAY-EB8D96FE — Deny destinations outside active connections

```text
Given an authenticated chat container is active
	When it requests a destination outside every active connection boundary
		And the request does not match the web extension's credential-free public web rule
		Then the gateway returns HTTP 403
			And states that policy denied the request
			And does not contact the requested upstream
	When it requests an HTTPS tunnel
		Then the gateway accepts `CONNECT` only on port 443
			And refuses the tunnel before interception unless an active gateway rule can match its host and port
			And still applies method and path policy to each intercepted request
```

## GATEWAY-123EDBDF — Fail closed when injection cannot be completed

```text
Given a request matches an active credentialed connection
	And its credential file is missing
	Or its recognized OAuth credential cannot be refreshed
	When the gateway evaluates the request
		Then it refuses the request
			And does not forward the sentinel upstream
			And tells the user to rotate or reconfigure the connection
```

## GATEWAY-EC79406A — Prevent direct container egress

```text
Given a chat container is running
	When software in the container attempts internet access without the gateway
		Then the connection cannot reach the destination
			And integral fails container startup when it cannot create the locked network
```

## GATEWAY-F5F3A6A9 — Substitute credential sentinels only inside their rule

```text
Given a connection stores one or more secrets
	When integral provisions a session
		Then it represents each secret inside the box by a sentinel that identifies the connection and secret without revealing it
	When a request matches the connection's rule and carries one of its sentinels where the rule places credentials
		Then the gateway replaces the sentinel with the real secret before forwarding
	When a request carries a sentinel outside its connection's rule or credential placement
		Then the gateway refuses the request without forwarding the sentinel
			And records a sentinel-misuse event attributed to the session
	When a sentinel appears in a request body
		Then the gateway does not substitute it
```

## GATEWAY-AAD4DC1D — Apply rule plugins for limits that depend on request meaning

```text
Given a gateway rule names a rule plugin contributed by an active extension's host half
	And the bundled email, Discord-send, and repository extensions contribute the email recipient policy, the Discord single-DM boundary, and governed Git landing plugins
	When a request matches that rule
		Then the gateway gives the plugin the parsed request, the authenticated session, and the connection's non-secret policy before forwarding
			And the plugin may allow the request, refuse it with a bounded reason, require approval, or answer it without forwarding
			And the plugin cannot widen the rule's boundary or read another connection's credentials
	When the plugin fails, times out, returns an invalid verdict, or its extension is inactive
		Then the gateway refuses the request
			And does not contact the upstream
Given a gateway rule names no plugin
	When a request matches it
		Then the gateway applies only the boundary, method, credential, and approval checks
```

## GATEWAY-FACB8D58 — Reach host operations only through the Integral control rule

```text
Given core and active extensions register operations on the Integral control API
	And core registers package inventory, package changes, image rebuild, schedule, and task-outcome operations
	And extensions register operations such as repository and store lifecycle
	When an authenticated session calls the Integral control API
		Then the box reaches it only through the gateway at a fixed internal host name
			And the gateway attributes the call to the session like any other request
			And the control API routes the call to the registering core component or extension host half
			And derives authority from the session and never from a caller-supplied identity, host path, policy, or approval state
			And each control operation declares whether it requires approval
			And the box has no route to coordinator, runner, scheduler, or extension service listeners except through the gateway
	When a control call carries an expired, revoked, or mismatched session identity
		Then the control API refuses it without reading or changing host state
	When a control call names an operation of an inactive extension
		Then the control API refuses it as unavailable
```

## GATEWAY-846B1000 — Require human approval for governed requests

```text
Given a gateway rule, rule plugin, or control operation marks a request approval-required
	And container package installation and upgrade are approval-required control operations
	And Git landings to repositories with host-managed `approval-required` policy are approval-required
	And fresh image rebuilds requested by Pi, host automation, or a remote API are approval-required
	And read-only package inventory and read-only repository operations are not approval-required
	When an authenticated Pi session submits an approval-required request
		Then Integral validates it without executing it
			And durably records an unpredictable approval ID, safe summary, canonical request digest, originating actor, conversation and reply route, session and run, model selection, current revision, and deadline
			And publishes the pending approval only on the originating reply route
			And includes the non-secret approval state in the shared `approvals` command view
			And keeps the originating request pending while its connection remains active
			And does not build an image, advance a protected repository ref, or modify package state before approval
Given authenticated host automation or a remote API submits an approval-required request outside Pi
	When Integral creates the approval request
		Then it records the external actor and request origin without inventing a Pi session or run
			And applies the same validation, decision, execution, audit, expiry, and restart lifecycle
Given a trusted local operator invokes `integral image edit` or `integral image rebuild`
	When Integral authorizes the operation
		Then it treats local CLI authority as the human decision
			And bypasses approval-request creation without bypassing validation, build isolation, durable audit, or immutable image selection
Given an approval request is pending
	When a human verified by any channel approves it
		Then Integral binds the decision to that channel and identity
			And permits deciding any request visible in the shared approval view
			And revalidates the exact request and expected revision
			And executes it exactly once using the approval ID as its idempotency key
			And durably records the result or failure
			And publishes that outcome only on the originating reply route
	When a human verified by any channel denies it
		Then Integral binds the decision to that channel and identity
			And durably records the denial
			And publishes that outcome only on the originating reply route
			And does not execute the request
	When an identity that no channel verifies attempts a decision
		Then Integral ignores the attempt as unauthorized
			And does not resolve or execute the request
	When another human attempts to decide the resolved approval
		Then Integral rejects the later decision
			And does not execute the request again
	When the request revision is stale at approval time
		Then Integral records and publishes a stale outcome
			And does not execute the request
	When the request is a fresh rebuild with floating dependencies
		Then Integral shows the active recipe commit, prior image digest, mutable inputs, and build-time resolution warning
			And approval authorizes resolution against the configured repositories at execution time rather than an exact dependency closure
Given an approval is resolved while its originating request remains connected
	When Integral completes the decision
		Then it returns the durable outcome to that request
			And does not create a replacement session solely for the outcome
Given an approval remains unresolved after its originating Pi session ends
	When the session ends
		Then Integral keeps the approval open
			And revokes the ended session's temporary credentials
			And retains the exact request, originating session and run, and model selection
	When a human later approves, denies, or lets the request expire
		Then Integral durably queues an approval-resolution continuation
			And starts a new Pi session using the resulting current image and model
			And gives it the approval ID, safe action summary, and outcome
			And restores the preceding conversation context
			And records the ended session and run as its parent lineage
Given Integral restarts with unresolved approvals
	When the coordinator recovers durable state
		Then it preserves every unresolved approval in its prior state
			And does not cancel, deny, approve, or execute it merely because Integral restarted
			And republishes it only on its originating reply route
	When it recovers a durably approved operation without a durable execution result
		Then it resumes execution using the approval ID
			And prevents duplicate package-state or protected-repository changes
Given an unresolved approval reaches its ten-minute deadline
	When Integral expires it
		Then Integral records and publishes an expired outcome without executing the request
			And never approves it automatically
			And delivers the outcome through the live request or a replacement-session continuation
When an approval changes state
	Then Integral writes a durable audit record with its safe summary, request digest, lineage, decision identity, execution state, and timestamps
		And sends any human-facing notification only on the approval's originating reply route
		And never records credentials or secret request values
```

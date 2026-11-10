# MCP behaviors

These behaviors define remote and stdio MCP connections. MCP is an extension:
the MCP client runs inside the box as the bundled MCP extension, and every
remote request leaves through gateway rules contributed by the MCP connection.
Host code handles only setup, authorization, credential refresh, and health.
MCP Apps, prompts, resources, and per-conversation enable switches are outside
this scope.

<!-- Automation note (MCP-948B2522): OAuth metadata discovery, dynamic registration, issuer/resource binding, and refresh are covered by MCP, OAuth, connection, and gateway tests. -->
<!-- Automation note (MCP-DB6BD516): Stateless, sessionful, and legacy SSE negotiation are covered by MCP protocol tests. -->
<!-- Automation note (MCP-007BCE08): Paginated discovery, malformed-tool isolation, deterministic first-class tool generation, and schema bounds are covered by MCP and container tests. -->
<!-- Automation note (MCP-2F0F5CB5): Named remote invocation and stdio gateway brokering are covered by MCP and gateway/container tests. -->

## MCP-948B2522 — Discover and complete MCP authorization

```text
Given a remote MCP server responds that authorization is required
	When integral adds or reconnects the server
		Then integral discovers its protected-resource metadata through trusted host code
			And discovers and validates the authorization server metadata
			And binds discovered client registration and tokens to that authorization-server issuer
			And prefers configured client information when supplied
			And otherwise uses a supported MCP client-registration mechanism
			And uses authorization code with PKCE
			And includes the MCP resource indicator in authorization and token requests
			And requests only the scopes advertised as necessary for the MCP resource
			And validates authorization state, issuer, redirect URI, and resource binding
			And accepts a loopback callback or a pasted authorization response
			And stores client credentials, access tokens, and refresh tokens only in the host credential area
			And never places a real credential in a Pi environment, file, argument, tool declaration, or MCP payload
	When an access token is near expiry
		Then the gateway refreshes it before injecting it into the next matching MCP request
			And atomically stores the replacement token record
	When authorization discovery is incomplete or inconsistent
		Then integral refuses the connection
			And identifies the incompatible metadata without exposing secrets
```

## MCP-DB6BD516 — Negotiate compatible remote MCP protocols

```text
Given an active remote MCP connection
	When the MCP extension opens communication with its server through the gateway
		Then the extension supports the MCP `2026-07-28` stateless HTTP protocol
			And supports the sessionful `2025-11-25` protocol family
			And supports the legacy `2024-11-05` HTTP+SSE transport
			And selects the newest mutually supported protocol
			And sends the protocol, routing, client identity, capability, and session metadata required by the selected version
			And follows the selected version's request, response, cancellation, and shutdown lifecycle
	When a sessionful server assigns an MCP session identifier
		Then the extension returns that identifier only to the same connection and server boundary
			And reinitializes after the server expires the session
			And attempts orderly session termination in its shutdown step
	When a server cannot negotiate any supported version
		Then the extension marks that connection unavailable for the session
			And does not send a tool request using guessed protocol semantics
```

## MCP-007BCE08 — Expose discovered MCP tools as first-class Pi tools

```text
Given an active MCP server advertises one or more tools
	When the MCP extension prepares a Pi session
		Then it reads every page of the server's tool catalog through the gateway
			And registers one Pi tool for each valid remote tool
			And preserves the remote tool's name when making MCP requests
			And gives the Pi tool a deterministic name namespaced by connection
			And exposes the remote title, description, input schema, output schema, and annotations supported by Pi
			And supports JSON Schema 2020-12 input schemas within documented resource limits
			And prevents one connection's names from colliding with other extensions' tools or another connection's tools
			And does not expose a generic `mcp_<server>` tool that requires Pi to guess a remote tool name
	When a remote tool declaration is malformed, duplicated, or exceeds a documented schema limit
		Then the extension excludes that tool
			And reports a bounded diagnostic identifying its connection and tool
			And keeps other valid tools from the same server available
```

## MCP-2F0F5CB5 — Invoke a discovered MCP tool faithfully

```text
Given Pi invokes a tool discovered from an MCP connection
	When the MCP extension handles the invocation
		Then it validates the arguments against the advertised input schema
			And sends `tools/call` to the originating connection and server tool
			And routes the request over the connection's negotiated remote or stdio transport
			And sends every remote request through the authenticated Integral gateway
			And the gateway injects a remote credential only after matching the connection's rule
			And the extension preserves supported text, image, audio, resource-link, embedded-resource, and structured result content
			And represents an MCP tool execution error as a tool result that Pi can reason about
			And represents a transport or protocol failure without exposing unbounded response data
	When Pi cancels the invocation
		Then the extension propagates cancellation according to the negotiated MCP version
			And stops waiting for the result
			And does not treat cancellation as successful tool execution
	When the remote server redirects a request outside the connection's rule
		Then the gateway refuses the redirected request
			And does not forward the credential to the new destination
```

## MCP-5751370A — Refresh a changing MCP tool catalog

```text
Given an active MCP server changes its tool catalog
	When the negotiated protocol announces a tool-list change
		Or the advertised tool-catalog cache lifetime expires
		Or integral provisions a new Pi session
		Then the MCP extension retrieves the complete current catalog
			And validates it before replacing the previous catalog
			And makes the replacement catalog visible no later than the next Pi turn
			And lets an invocation already in flight finish against its original catalog
			And removes tools no longer advertised
			And adds newly advertised tools without requiring the user to remove and re-add the connection
	When catalog refresh fails
		Then the extension retains no newly received partial catalog
			And reports the connection as degraded to Pi
			And does not prevent unrelated connections from operating
```

## MCP-6F5CFA0E — Isolate MCP connection failures

```text
Given multiple MCP connections are configured
	When one server is unreachable, unauthorized, malformed, protocol-incompatible, or its stdio process exits
		Then the MCP extension marks only that connection unavailable or degraded for the session
			And continues providing tools from healthy connections
			And host health checks identify the failing stage in `integral connection ls`
			And credentials remain on the host
	When the failing server later passes authorization, negotiation, and tool discovery
		Then the connection returns to active
			And its tools are available no later than the next Pi session
			And the connection does not need to be recreated
```

## MCP-9E51530C — Run a stdio MCP server inside the box

```text
Given an active stdio MCP connection declares an executable, arguments, non-secret environment, secret environment names, and allowed URLs
	When the MCP extension prepares a Pi session
		Then it starts the executable as a child process inside the box under the same non-root user as Pi
			And passes the arguments in order without shell parsing or expansion
			And supplies the declared non-secret environment values
			And supplies each secret environment value as that secret's credential sentinel
			And the server shares the box's filesystem, sandbox, and resource limits with Pi
			And the server reaches the network only through gateway rules for its allowed URLs
			And the gateway substitutes the connection's secrets only inside those rules
			And treats newline-delimited standard output as MCP protocol messages
			And treats standard error as bounded diagnostic output
	When the server writes non-protocol data to standard output
		Then the extension marks that connection unavailable for the session
			And terminates the server without interpreting the data as a tool result
	When the server exits or hangs
		Then the extension fails the affected invocation with a bounded connection error
			And leaves Pi and unrelated MCP connections running
	When the session ends
		Then the extension's shutdown step closes the server's standard input
			And terminates the server after a bounded graceful-exit period
```

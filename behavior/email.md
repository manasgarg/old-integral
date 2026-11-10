# Email behaviors

These behaviors cover email accounts. An email connection contributes gateway
rules for its provider API and names the email rule plugin, which enforces the
account's capabilities and recipient policy. The bundled email extension gives
Pi semantic tools over those APIs as a convenience. The box receives only
credential sentinels.

## EMAIL-B765A312 — Configure provider-defined email capabilities

```text
Given the connection catalog contains Gmail and Mailgun email providers
	When the user configures a Gmail email connection
		Then the connection may enable `read`, `search`, and `send`
			And uses OAuth with the scopes required by its enabled capabilities
			And requires the authenticated account address and OAuth client ID
	When the user configures a Mailgun email connection
		Then the connection enables only `send`
			And requires a sending domain, fixed From address, region, and API key
			And interactive setup selects `send` without a capability prompt
	When the user interactively adds Gmail or Mailgun without required email options
		Then integral prompts for the missing non-secret account and policy options
			And requests the credential only after those options are valid
	When an email connection enables `send`
		Then it requires at least one exact-address or domain-wildcard allowed recipient policy
			And an omitted policy or catch-all wildcard never means allow all recipients
	When an email connection requests a capability unsupported by its provider
		Then integral rejects the declaration without storing credentials
```

## EMAIL-276B27AA — Search and read Gmail through the gateway

```text
Given an active Gmail connection enables `search` or `read`
	When a session searches the account through the Gmail API
		Then the email rule plugin allows only the message-list and message-get operations
			And the gateway injects the account credential
			And the request does not modify mailbox state
	When a session reads a message by its Gmail message ID
		Then the email rule plugin allows the read without modifying mailbox state
	When a session requests a Gmail operation that the connection did not enable or that modifies mailbox state
		Then the email rule plugin refuses it without contacting Gmail
	When the email extension returns search or read results to Pi
		Then it returns a bounded list of summaries or headers and bounded text content
```

## EMAIL-19BA105D — Send email through a constrained account

```text
Given an active Gmail or Mailgun connection enables `send`
	When a session submits a send request to the provider API
		Then the email rule plugin parses the complete message before forwarding
			And requires the From identity to be the configured account
			And requires every To, Cc, and Bcc recipient to match the connection's recipient policy
			And forwards the message through the configured provider API
			And returns the provider's message identity
	When any recipient is outside the connection's policy
		Then the email rule plugin refuses the entire message without contacting the provider
	When a message contains an invalid address, header injection, an unparseable body, or exceeds a bounded field limit
		Then the email rule plugin refuses the entire message without contacting the provider
	When the provider rejects a valid constrained message
		Then the gateway reports its HTTP status and bounded provider reason
			And does not expose credentials or an unbounded response body
```

## EMAIL-89334867 — Give Pi semantic email tools without enforcing in them

```text
Given one or more active email connections exist when a Pi session starts
	When integral enables the email extension
		Then the extension registers tools only for capabilities enabled by those connections
			And each tool calls the provider API through the gateway using the connection's credential sentinel
			And no real email credential is placed in the box
	When integral provisions a fresh isolated scheduled-task session
		Then it enables the same email extension and gateway rules for that task
			And keeps the interactive and scheduled-task session identities separate
	When no active email connection exists
		Then integral does not enable the email extension
	When box software calls the provider API without the email extension
		Then the email rule plugin applies the same capability and recipient policy
	When a semantic tool cannot reach the gateway
		Then it reports whether the request was cancelled or a bounded transport error code
```

## EMAIL-FB2E88EF — Log email rule decisions

```text
Given an authenticated session sends a request that matches an email connection's rule
	When the email rule plugin allows or refuses it
		Then the gateway emits a structured event with the connection, provider, operation, session, request, and verdict
			And a failure includes its bounded sanitized reason
			And the event excludes recipients, subject, body, and credentials
```

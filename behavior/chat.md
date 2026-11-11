# Terminal chat behaviors

These behaviors cover interchangeable terminal views over the coordinator-owned
default terminal conversation. Channel-provider conversations remain separate
unless a future behavior explicitly links them.

<!-- Automation note (CHAT-888AFAE0): Prompt, local-command, queue, and rendering contracts are automated; keystroke-level PTY interaction is not run by the non-interactive default suite. -->
<!-- Automation note (CHAT-54B8A1C3): Shared coordinator snapshots and broadcasts are automated; two real PTYs are an acceptance test. -->
<!-- Automation note (CHAT-1C4A8B7E): Detachment ownership is automated at the coordinator boundary; SIGINT delivery to a real PTY is not part of the default suite. -->

## CHAT-DB0EF523 — Refuse chat without the server

```text
Given no healthy coordinator is reachable
	When the user runs `integral talk`
		Then the command exits non-zero
			And tells the user to start the coordinator or run `integral server start`
			And does not start an ungoverned local Pi process
```

## CHAT-888AFAE0 — Hold an interactive conversation

```text
Given the terminal is interactive
	And the integral coordinator is healthy
	When the user runs `integral talk`
		Then the terminal shows a stable person-symbol input prompt
			And displays asynchronous conversation events above the input prompt instead of after its prefix
			And redraws any input already being typed after an asynchronous event
			And trims input before interpreting or submitting it
			And submits each non-empty input line to the coordinator-owned queue
			And ignores empty or whitespace-only input
			And does not repeat a user message already echoed by that terminal's input editor
			And displays user messages submitted by other attached terminals
			And labels every human message with a person symbol
			And gives each full person-labeled message a distinct background color on color terminals
			And does not emit color escapes to non-color output
			And labels every assistant or error message with `∮`
			And displays assistant text emitted by Pi as assistant output
			And does not display protocol events or raw JSON
			And does not display model credentials
	When the user enters an unrecognized line beginning with `/`
		Then integral reports an unknown local command on stderr
			And does not submit the line to the coordinator or Pi
Given the user is in `integral talk`
	When a Pi process is active inside its container
		And that Pi process is working on an in-flight message
		Then the terminal animates a `∮` working indicator on its own line
			And keeps the human input prompt on the following line
			And does not disturb input already being typed
	When no Pi container is active or the active Pi process is idle
		Then the terminal does not animate the working indicator
```

## CHAT-84D839CE — Show local chat help

```text
Given the user is in `integral talk`
	When the user enters `/help`
		Then the terminal describes `/help`, `/status`, `/model [<pattern>...]`, `/connection catalog`, `/connection ls`, `/queue ls`, `/queue edit`, `/queue delete`, `/tasks`, `/tasks show`, `/tasks cancel`, `/approvals`, `/approve`, `/deny`, and `/exit`
			And handles the command on the host
			And does not send the command to Pi
```

## CHAT-989F5C14 — Show chat status

```text
Given the user is in `integral talk`
	When the user enters `/status`
		Then the terminal reports whether the gateway is healthy
			And reports whether the runner is healthy
			And reports whether the Pi container is healthy
			And identifies the conversation's selected connection, provider, and model
			Or reports that the conversation requires a selection
			And identifies the current session when one is active
			And reports the queue depth and number of attached terminals
			And identifies the in-flight message when one exists
			And does not print secrets
```

## CHAT-6E91B4C7 — Select and reuse the conversation model

```text
Given the terminal is interactive
	And the integral coordinator is healthy
	When the user runs `integral talk`
		And at least one active model connection exists
		And the conversation has no selected model connection and model
		Then integral opens the model chooser
			And records both selections as durable conversation state
			And does not write either selection to the main configuration
			And attaches the terminal only after both selections are valid
	When the user runs `integral talk`
		And the conversation has a previously selected model connection and model
		And both selections remain available
		Then integral reuses the previous selections without opening the model chooser
			And refreshes the selected Pi runtime identity when the available runtime changed
			And attaches the terminal to the same conversation
	When the user runs `integral talk <pattern>...`
		And at least one active model connection exists
		Then integral opens the model chooser and applies each pattern argument as a search term
			And attaches the terminal only after the terms resolve to a valid selection
			And does not write the selection to the main configuration
	When the user runs `integral talk`
		And at least one active model connection exists
		And the conversation has a previously selected model connection and model
		And either selection is no longer available
		Then integral explains why the previous selections cannot be reused
			And opens the model chooser without a default
			And replaces both selections in durable conversation state
			And does not write either selection to the main configuration
	When the user runs `integral talk`
		And no active model connection exists
		Then the command exits non-zero
			And instructs the user to run `integral connection add`
			And does not attach the terminal or change the conversation's selections
```

## CHAT-C53A90D2 — Choose a provider and model with friendly matching

```text
Given integral opens the model chooser for `integral model`, `integral talk`, or `/model`
	When the coordinator has already discovered models for the current connection generation and configuration
		Then it serves the cached catalog without repeating Pi version, image, or model discovery
			And invalidates that catalog after the connection generation changes
			And invalidates that catalog when a model connection becomes active or degraded
	When it displays the available choices
		And at least one active model connection exists
		Then it groups models under each active model connection
			And identifies each connection name and provider
			And identifies every available model by name
			And identifies the Pi runtime version that supplied the choices
			And marks the conversation's current choice when it remains available
			And explains that the user may enter a choice number or one or more search terms
			And shows `integral model [<pattern>...]`, `integral talk [<pattern>...]`, and `/model [<pattern>...]` as equivalent ways to search
	When no active model connection exists
		Then integral reports that no provider and model choices are available
			And instructs the user to run `integral connection add`
			And does not change the conversation's selection
	When the user enters a choice number
		Then integral selects the corresponding displayed connection, provider, and model
	When the user enters one or more search terms
		Then integral treats each term as a case-insensitive substring
			And compares it with connection names, provider names, and model names
			And keeps choices for which every term matches at least one of those fields
	When the terms identify exactly one choice
		Then integral selects that connection, provider, and model
	When the terms identify multiple choices
		Then integral displays only the matching choices
			And asks the user to narrow the selection or enter a displayed choice number
			And does not change the conversation's selection
	When no choice matches the terms
		Then integral reports that no provider and model match
			And displays all available choices again
			And does not change the conversation's selection
Given the user is in `integral talk`
	When the user enters `/model`
		Then integral opens the same model chooser used by `integral talk`
			And handles the command on the host
			And does not send the command to Pi
	When the user enters `/model <pattern>...`
		Then integral applies each pattern argument as a search term in that chooser
			And handles the command on the host
			And does not send the command to Pi
Given the model chooser resolves a valid choice
	When no Pi turn is in flight
		And the conversation has no current choice or the resolved choice is different
		Then integral records the new connection, model, and Pi runtime identity as durable conversation state
			And terminates any active Pi container
			And uses that exact Pi runtime when the next message provisions Pi
	When a Pi turn is in flight
		And the resolved choice is different from the conversation's current choice
		Then integral refuses to change the selection until the turn finishes
			And leaves the current connection, model, and Pi session unchanged
```

## CHAT-54B8A1C3 — Attach every terminal to the same conversation

```text
Given one `integral talk` terminal is attached to the deployment conversation
	When the user starts another `integral talk` with the same `$INTEGRAL_HOME`
		Then the second terminal attaches to the same logical conversation
			And receives the same ordered conversation record
			And receives the same queue contents and order
			And observes the same selected model connection and model
			And observes the same Pi session and in-flight message
			And does not start another logical conversation or Pi container
```

## CHAT-D7E2F609 — Broadcast conversation events to every terminal

```text
Given two or more terminals are attached to the same conversation
	When any terminal submits a message
		Then every attached terminal displays that same persisted user message once
	When Pi completes a response
		Then the coordinator persists the complete assistant response
			And every attached terminal displays that same response once
	When queue or session state changes
		Then every attached terminal observes the same resulting state
			And renders queue edits and deletions as host-side notices
			And renders session start and end events without exposing the session token
	When the selected model connection or model changes
		Then every attached terminal observes the same resulting selection
			And identifies its connection, provider, and model without exposing credentials
```

## CHAT-1C4A8B7E — Detach one terminal without ending the conversation

```text
Given one or more terminals are attached to the conversation
	When one terminal enters `/exit`, sends EOF, or is interrupted
		Then integral detaches only that terminal
			And returns control to that terminal's shell
			And does not end the logical conversation
			And does not discard queued messages or persisted conversation events
			And does not disturb other attached terminals
```

## CHAT-93E7D20B — Reattach to the durable conversation

```text
Given every terminal has detached
	And the integral coordinator still owns the conversation
	When the user runs `integral talk` with the same `$INTEGRAL_HOME`
		Then the terminal receives a snapshot containing the existing conversation record and queue
			And omits session records from rendered conversation text
			And continues following new events without a snapshot-to-live gap
			And does not create a blank logical conversation
```

## CHAT-B46C81F5 — Restore conversation context in a replacement Pi session

```text
Given the logical conversation has persisted completed turns
	And no Pi container is active
	When the runner starts a replacement Pi session for a queued message
		Then integral resumes the conversation's model transcript as described in CHAT-79B32789
			And supplies rendered conversation context only in the fallback described in CHAT-2FC607EA
			And the replacement session can continue the same conversation
			And temporary files from the previous container remain unavailable
```

## CHAT-ADC7198B — Keep a model transcript for each conversation

```text
Given a conversation delivers messages to an interactive Pi session
	And the conversation's model transcript is `model-transcript.jsonl` beside its `conversation.jsonl`
	When integral starts the Pi session
		Then it runs Pi with session persistence enabled
			And points Pi's session directory at a folder inside the temporary session home
			And gives Pi the Pi session ID recorded with the model transcript
			And assigns and records a new Pi session ID when the conversation has no usable model transcript
	When a turn completes
		And its message will not be delivered again
		Then integral asks Pi over RPC for the session entries added after the last entry the transcript holds
			And appends those entries to the model transcript in the order Pi returned them
			And replaces the session's temporary credentials in those entries with a redaction marker
			And records the Pi runtime version that produced them
			And makes the appended entries durable before it reports the turn complete
	When Pi appends entries between turns
		And integral then ends the Pi session for idleness, a model change, or shutdown
		Then integral appends those entries to the model transcript before stopping Pi
	When a turn times out
		Or Pi exits during a turn
		Or the turn's message otherwise returns to the queue
		Then integral appends none of that turn's entries
			And the model transcript still ends at the last completed turn
	When integral cannot obtain or store the entries of a completed turn
		Then it marks the model transcript stale
			And does not fail the turn or deliver its message again
	When anything inside the container changes Pi's session file
		Then integral never copies that file into the model transcript
			And takes entries only from Pi's RPC answers
```

## CHAT-79B32789 — Resume the model transcript in a replacement Pi session

```text
Given the conversation has a model transcript that is readable and not stale
	And no Pi container is active
	When the runner starts a Pi session for a queued message
		Then integral writes the transcript into the new session home as the Pi session file for the transcript's Pi session ID
			And starts Pi on that session
			And does not also supply rendered conversation context
			And asks Pi for its latest session entry before sending the message
			And sends the message only when Pi's latest entry matches the transcript's latest entry
			And Pi builds model context from the transcript's messages, tool calls, tool results, and compaction summaries
	When the selected model or Pi runtime changed since the transcript was last appended
		Then integral still resumes the transcript
			And the transcript records the model change through Pi's own entries
	When an approval-resolution continuation starts a Pi session
		Then it resumes the same model transcript as an ordinary queued message would
```

## CHAT-2FC607EA — Fall back to rendered context when the transcript cannot be resumed

```text
Given the runner is starting a Pi session for a conversation
	When the conversation has no model transcript
		Or the model transcript cannot be read
		Or the model transcript is marked stale
		Or Pi cannot start on the resumed session
		Or Pi's latest session entry does not match the transcript's latest entry
		Then integral starts Pi on a new Pi session ID
			And supplies rendered conversation context as described in CONFIG-F2C84D16
			And keeps an unusable transcript under a set-aside name instead of deleting it
			And starts a new model transcript from the new Pi session
			And records the fallback and a bounded reason without message content in the run record
			And delivers the queued message exactly once
	When Pi cannot start in the fallback either
		Then integral handles it as a provisioning failure as described in BOX-C28F4A61
```

## CHAT-F5F13AE4 — Keep the conversation record separate from the model transcript

```text
Given a conversation has a conversation record and a model transcript
	When a user edits or deletes a queued message
		Then integral changes only the conversation record
			And leaves the model transcript unchanged because Pi has not received the message
	When integral records a notification, error, session marker, or message origin
		Then it records it only in the conversation record
	When a terminal attaches or reattaches to the conversation
		Then integral renders the conversation from the conversation record
			And does not read the model transcript
	When integral logs an event about the model transcript
		Then the event carries entry counts, identifiers, and reasons
			And carries no message or tool content
```

## CHAT-4F29A6D8 — Recover the conversation after a server restart

```text
Given conversation events were acknowledged before the coordinator stopped or crashed
	When the coordinator starts again with the same `$INTEGRAL_HOME`
		Then integral restores the events in their committed order
			And restores any selected model connection and model
	When a terminal attaches after that restart
		Then it receives the restored conversation and current queue
			And follows subsequent events in the same logical conversation
	When an attached terminal loses the coordinator because the server restarts
		Then the terminal remains open and reports that it is reconnecting
			And reconnects to the coordinator for the same `$INTEGRAL_HOME`
			And reconciles from the restored snapshot without rendering acknowledged conversation events twice
			And accepts new local commands and messages after reconnection
```

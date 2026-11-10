# Channel behaviors

These behaviors define the channel contract. Channels are part of core. A
channel is where work enters a conversation and where its results are
delivered. The terminal, the configured Discord DM, and the scheduler are
channels. Channel-specific presentation lives in [`chat.md`](chat.md),
[`discord.md`](discord.md), and [`schedule.md`](schedule.md); this file covers
what every channel shares.

## CHANNEL-344DC824 — Submit channel input to a coordinator conversation

```text
Given a channel accepts human or scheduled input
	When the channel submits the input
		Then the coordinator resolves the logical conversation from the channel and its host-controlled identity
			And durably queues the input in that conversation before acknowledging it
			And stamps the queued item with a host-controlled reply route
			And every channel uses the same coordinator submission interface
			And neither Pi nor the input content can choose or replace the conversation or reply route
```

## CHANNEL-A612DCF2 — Deliver results only to the reply route

```text
Given a queued item carries a reply route
	When Pi completes, fails, or produces a notification for that item
		Then the coordinator records the result in the originating conversation
			And the originating channel presents it only on that reply route
			And no other channel displays it
	When delivery on the reply route fails
		Then integral reports the delivery failure
			And does not fall back to another channel or route
Given a queued item has no reply route
	When integral produces a result for it
		Then integral records the result durably without choosing a channel for it
```

## CHANNEL-67B3455C — Share one command set and human authority across channels

```text
Given core defines the `help`, `status`, `model`, `queue`, `tasks`, and `approvals` commands
	When a channel presents those commands
		Then it executes the same host operation and reports the same durable state as every other channel
			And does not submit the command text to Pi
Given a channel binds each human decision to a channel-verified identity
	And a terminal attachment verifies the local operator
	And the Discord channel verifies the bound user and DM
	When that human approves or denies a governed request
		Then integral records the channel and identity as the decision origin
			And applies the same approval rules as every other channel
	When an input or decision arrives from an identity the channel cannot verify
		Then the channel ignores it before persisting conversation or command state
```

## CHANNEL-79804D64 — Keep channel failures outside core

```text
Given a channel is configured
	When the server starts
		Then the channel begins accepting input only after the coordinator is ready
	When the channel loses its connection, authentication, or delivery path
		Then the coordinator, runner, gateway, scheduler, and other channels remain available
			And integral reports that channel as degraded with a redacted reason
			And acknowledged conversation and queue state remain durable
	When the server stops
		Then each channel stops accepting input before the coordinator stops
```

## CHANNEL-E80EC42B — Treat the scheduler as a channel without a human

```text
Given the scheduler submits a due occurrence as a task
	When the task was created from a conversation
		Then it carries that conversation's reply route
	When the task was created by the CLI or automation without a conversation
		Then it carries no reply route
	When a governed request originates from a scheduled task
		Then the scheduler cannot decide the approval
			And a human decides it through a channel that can verify a human identity
```

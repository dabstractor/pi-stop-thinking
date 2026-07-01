# Product Requirements Document (PRD)

## Pi Extension: **Stop Thinking & Do**

### Version 1.0 (Production MVP)

### Status: Draft

### Target Platform: Pi Coding Agent

### Target Provider: z.ai (OpenAI-Compatible API)

### Document Part 1 — Product Definition, Vision, Requirements & High-Level Architecture

---

# 1. Executive Summary

This document specifies the design and implementation requirements for a Pi extension that enables users to interrupt pathological reasoning loops produced by reasoning-capable LLMs and immediately transition the model into answer generation.

The extension introduces a single user-facing capability:

> **Stop Thinking & Do**

When invoked during a reasoning stream, the extension shall terminate the current reasoning process and immediately continue generation using a thinking-disabled request while preserving the illusion of a single uninterrupted assistant response.

This capability exists because reasoning models—particularly z.ai models—can become trapped in excessively long reasoning phases that produce little incremental value while consuming significant latency and token budget. In practice, these reasoning phases may last several minutes or, in extreme cases, over thirty minutes.

The extension is intended to restore user agency.

Rather than forcing users to either:

* wait indefinitely,
* terminate the request entirely,
* or manually send another prompt asking the model to stop thinking,

the extension performs the transition automatically with a single keyboard shortcut.

The implementation deliberately hides the orchestration complexity from both the user and Pi's higher-level agent lifecycle.

From the user's perspective:

* one prompt is submitted,
* one assistant response is received,
* one keyboard shortcut changes the model's behavior.

Internally, the extension may perform multiple provider requests in order to produce that experience.

The implementation details are considered an internal concern and must never leak into the visible interaction.

---

# 2. Problem Statement

Modern reasoning models frequently separate inference into two conceptual phases:

1. reasoning
2. answer generation

The reasoning phase is intended to improve output quality.

However, current implementations often exhibit undesirable behaviors:

* runaway reasoning loops
* diminishing returns
* repetitive internal exploration
* excessive latency
* token waste
* inability for the user to intervene

Current user choices are poor.

They may:

* continue waiting indefinitely
* cancel the request completely
* manually ask the model to answer

Each option has significant drawbacks.

Waiting wastes time.

Cancellation discards useful work.

Sending another prompt pollutes conversation history while adding unnecessary interaction friction.

The product objective is therefore:

> Allow users to preserve as much useful reasoning work as possible while immediately transitioning into final answer generation without additional user interaction.

---

# 3. Product Vision

The extension should make reasoning models feel interruptible.

The desired user experience is analogous to interrupting a human expert.

Imagine a programmer asking another engineer a question.

The engineer begins thinking aloud.

After several minutes the programmer says:

> "You have enough. Just give me your answer."

The engineer immediately stops exploring additional possibilities and presents their current best answer.

That is precisely the behavior this extension seeks to emulate.

The implementation should create the illusion that reasoning is an interruptible phase even though current provider APIs do not expose such a capability.

---

# 4. Product Goals

The extension shall:

## G1

Allow the user to interrupt an active reasoning stream with a configurable keyboard shortcut.

---

## G2

Transition into answer generation with the minimum possible latency.

---

## G3

Avoid requiring any additional user message.

The user presses one key.

Nothing else.

---

## G4

Maintain the appearance of a single continuous assistant response.

There should never appear to be:

* multiple assistant turns
* aborted assistant messages
* duplicated responses
* restart artifacts

---

## G5

Reuse Pi's existing provider implementation wherever possible.

The extension should delegate to Pi's built-in provider implementation rather than reimplementing protocol details.

---

## G6

Remain transparent when inactive.

When the feature is not being used:

* no behavioral differences
* no output differences
* negligible performance overhead

---

## G7

Require zero provider maintenance.

The extension should inherit upstream Pi provider improvements automatically.

---

# 5. Non-Goals

The following are explicitly outside the scope of this project.

## NG1

Modifying an in-flight transformer inference.

Current provider APIs do not expose this capability.

The extension shall not attempt to alter the server-side inference process.

---

## NG2

Resuming a partially completed reasoning process.

No provider currently exposes resumable reasoning state.

---

## NG3

Supporting every provider.

The MVP targets **z.ai only**.

Compatibility with other providers should only occur where it is effectively free.

Provider-specific implementations beyond z.ai are out of scope.

---

## NG4

Creating a general prompt engineering framework.

This extension is **not** a prompt optimizer.

It has one responsibility:

> Stop reasoning and produce an answer.

---

## NG5

Supporting multiple user-facing commands.

The MVP exposes exactly one capability.

Everything else is out of scope.

---

## NG6

Changing Pi's agent lifecycle.

The extension must work within Pi's extension architecture.

No modifications to Pi core are assumed.

---

# 6. Architectural Decision Records

---

# ADR-001

## Reasoning Cannot Be Interrupted Server-Side

### Status

Accepted.

### Context

No documented OpenAI-compatible API exposes a mechanism to terminate reasoning while preserving the active inference.

### Decision

The extension shall treat reasoning interruption as a transport orchestration problem.

### Consequences

Multiple provider requests may be required internally.

This implementation detail shall remain invisible to the user.

---

# ADR-002

## The Agent Loop Is Not The Correct Interception Layer

### Status

Accepted.

### Context

Research into Pi's architecture demonstrates that agent-level aborts:

* terminate the run
* synthesize aborted messages
* create additional turns
* discard partial assistant state

These behaviors cannot be hidden cleanly.

### Decision

The extension shall operate below the agent lifecycle by decorating the provider stream.

### Consequences

Pi continues believing only one assistant response exists.

---

# ADR-003

## Decorate The Built-In Provider

### Status

Accepted.

### Context

Pi exposes:

* `getApiProvider()`
* `registerProvider()`

allowing an extension to capture the existing provider implementation before replacing the API registration.

The replacement delegates almost all work to the captured implementation.

### Decision

The extension shall decorate—not replace—the built-in OpenAI-compatible provider.

### Consequences

The extension automatically inherits future Pi provider improvements.

---

# ADR-004

## z.ai Is The Only Required Provider

### Status

Accepted.

### Context

Supporting every provider introduces substantial validation effort without increasing MVP value.

### Decision

The wrapper shall activate only when:

```text
model.provider == "zai"
```

All other providers immediately delegate to Pi's built-in implementation.

---

# ADR-005

## The Wrapper Must Be Observationally Equivalent

### Status

Accepted.

When inactive, the wrapper must produce behavior indistinguishable from Pi's built-in implementation.

Specifically:

* identical event ordering
* identical metadata
* identical errors
* identical timing (excluding negligible wrapper overhead)
* identical usage accounting
* identical assistant messages

This requirement exists to ensure that the extension introduces effectively zero regression risk for users who never invoke the feature.

---

# 7. User Stories

## Primary User

A software engineer using Pi for complex programming tasks.

---

### Story 1

As a user,

I submit a difficult programming question.

The model begins reasoning.

After approximately two minutes I determine that it has already explored enough possibilities.

I press the configured shortcut.

Within approximately one second the assistant transitions into producing its answer.

---

### Story 2

As a user,

I should never need to type:

> "Stop thinking."

The extension performs that transition automatically.

---

### Story 3

As a user,

I should never see evidence that two provider requests occurred.

The interaction should appear identical to a normal assistant response.

---

### Story 4

As a user,

If I never press the shortcut,

Pi should behave exactly as it normally would.

---

### Story 5

As a user,

If the model was never reasoning,

the shortcut should perform no action.

---

### Story 6

As a user,

If the provider does not support this feature,

nothing should break.

The extension simply delegates to Pi.

---

# 8. User Experience Specification

The user experience is intentionally minimal.

No additional commands.

No slash commands.

No chat messages.

No menu interaction.

No confirmations.

No dialogs.

---

## Normal Flow

```text
User Prompt

↓

Thinking...

↓

Answer
```

---

## Stop Thinking Flow

```text
User Prompt

↓

Thinking...

↓

Ctrl+.

↓

(short transition)

↓

Answer
```

The transition should appear as though the model simply stopped thinking and began answering.

No visible restart should occur.

---

## Failure Flow

If the transition cannot be completed,

the extension shall fail transparently.

The user should receive Pi's normal behavior rather than a broken stream.

---

# 9. Product Principles

The following principles supersede implementation convenience.

## Principle 1

Invisible.

The extension should disappear when inactive.

---

## Principle 2

Deterministic.

The same shortcut under the same conditions should always produce the same transition.

---

## Principle 3

Minimal Surface Area.

Only one user-facing feature exists.

---

## Principle 4

No Prompt Pollution.

The extension must never require the user to send another prompt.

Internal orchestration is acceptable.

Visible interaction changes are not.

---

## Principle 5

Delegate Everything Possible.

The extension should own only the orchestration logic.

Everything else belongs to Pi.

---

## Principle 6

Preserve User Mental Model.

The user should believe:

> "The model stopped thinking."

They should **not** think:

> "The extension cancelled my request and started another one."

That distinction is fundamental to the product.

---

# 10. High-Level Architecture

The extension consists of four cooperating subsystems.

```text
                 Pi Agent

                    │

                    ▼

        Decorated OpenAI Provider
        (streamSimple wrapper)

                    │

     ┌──────────────┼──────────────┐
     │              │              │
     ▼              ▼              ▼

Stream Proxy   State Machine   Event Splicer

     │              │              │

     └──────────────┼──────────────┘
                    │
                    ▼

         Captured Built-In Provider

                    │

                    ▼

                 z.ai API
```

The decorated provider owns the orchestration.

Pi remains unaware that interruption has occurred.

The provider wrapper delegates all standard functionality to the captured built-in provider and intervenes only when the Stop Thinking state machine is activated.

---

# 11. Major Components

The implementation is divided into four primary modules:

1. **Provider Decorator** — wraps Pi's built-in `streamSimple` implementation, delegates by default, and activates interception only for supported z.ai models.

2. **Stream Proxy** — forwards `AssistantMessageEvent`s, captures reasoning output, suppresses premature terminal events during interruption, and splices the replacement generation into a single downstream stream.

3. **Transition State Machine** — owns interruption state, lifecycle transitions, invariants, and recovery behavior. It is the sole authority for determining when and how a Stop Thinking operation proceeds.

4. **User Interaction Layer** — registers the configurable keyboard shortcut, detects when a reasoning stream is active, raises a stop signal to the state machine, and remains otherwise dormant.

The following section defines these components in detail, their interfaces, the complete stream lifecycle, and the event/state machines that govern the provider wrapper.

---

# 12. System Architecture

## 12.1 Overview

The Stop Thinking & Do extension is fundamentally a **stream orchestration layer**.

It does **not**:

* implement an LLM provider,
* implement a transport protocol,
* modify Pi's agent loop,
* modify inference,
* or introduce a second user interaction.

Instead, it inserts itself at the narrowest architectural seam available:

```text
AssistantMessageEventStream
```

This is the single abstraction that already exists between Pi's agent runtime and the provider implementation.

Every design decision in this document follows from that observation.

---

## 12.2 Why the Provider Boundary

Several possible interception layers were evaluated.

### Option A

Agent lifecycle

```text
Agent

↓

Abort

↓

Restart
```

Rejected.

Reasons:

* synthetic aborted assistant message
* new assistant turn
* discarded partial response
* impossible to hide lifecycle artifacts
* continuation semantics become inconsistent

---

### Option B

HTTP transport

```text
fetch()

↓

socket

↓

SSE parser
```

Rejected.

Although technically possible, Pi exposes no supported extension hook at this layer.

Implementing transport interception would require patching internals rather than using Pi's extension architecture.

---

### Option C

Provider event stream

```text
Agent

↓

AssistantMessageEventStream

↓

Provider
```

Accepted.

Advantages:

* supported extension surface
* preserves agent lifecycle
* preserves session semantics
* preserves UI behavior
* minimizes maintenance
* naturally composes with future provider updates

---

## 12.3 Layer Diagram

```text
                   Pi Agent Runtime

                          │

                          ▼

              streamSimple(model,...)

                          │

────────────────────────────────────────────────────

            Stop Thinking Provider Wrapper

────────────────────────────────────────────────────

            State Machine

            Stream Proxy

            Reasoning Buffer

            Abort Coordinator

            Event Splicer

────────────────────────────────────────────────────

                          │

                          ▼

         Captured Built-in OpenAI Provider

                          │

                          ▼

                       z.ai API
```

The wrapper owns orchestration.

Everything else remains Pi's responsibility.

---

# 13. Component Architecture

---

# 13.1 Provider Decorator

## Responsibility

Acts as transparent middleware around Pi's built-in provider.

It exists for one purpose:

Intercept the provider event stream without changing provider behavior.

---

## Responsibilities

Capture built-in provider

Delegate normal requests

Recognize supported models

Construct stream proxy

Coordinate interruption

Delegate second request

Splice streams

Return one logical stream

---

## Non-responsibilities

Authentication

Retry policy

Usage accounting

Tool call serialization

SSE parsing

Reasoning parsing

HTTP implementation

Model catalog

These remain entirely owned by Pi.

---

## Lifecycle

Initialization

↓

Capture provider

↓

Register wrapper

↓

Idle

↓

Request arrives

↓

Is provider == z.ai?

↓

No

↓

Delegate immediately

↓

Done

OR

↓

Yes

↓

Construct proxy stream

↓

Begin monitoring

---

# 13.2 Stream Proxy

The Stream Proxy is the heart of the extension.

Everything else exists to support it.

---

## Responsibility

Present one continuous AssistantMessageEventStream to Pi regardless of how many upstream provider requests occur.

Pi must never know multiple requests existed.

---

### Inputs

Original stream

Replacement stream

Stop signal

Reasoning buffer

Abort state

---

### Outputs

Exactly one AssistantMessageEventStream

---

### Guarantees

Exactly one:

message_start

Exactly one:

message_end

Exactly one:

completed result

No duplicate events

No missing events

No reordered events

---

## Invariant

From Pi's perspective:

```text
one request

↓

one stream

↓

one response
```

must always hold.

---

# 13.3 Transition State Machine

The Stream Proxy owns streaming.

The State Machine owns decisions.

It determines:

* whether interruption is allowed
* whether interruption has begun
* whether interruption completed
* whether recovery is required

No other component is allowed to modify transition state.

---

## Principle

Single writer.

Multiple readers.

---

Allowed readers:

UI

Shortcut handler

Stream proxy

Telemetry

Logging

---

Allowed writer:

State machine only.

---

# 13.4 Reasoning Buffer

The reasoning buffer captures reasoning emitted before interruption.

Its contents are intentionally opaque.

The extension does not interpret reasoning.

It merely preserves it.

---

## Responsibilities

Accumulate reasoning deltas

Track ordering

Track offsets

Track completion

Expose immutable snapshot

Reset after completion

---

## Non-responsibilities

Summarization

Compression

Prompt engineering

Semantic analysis

Those are explicitly outside MVP scope.

---

# 13.5 User Interaction Layer

The interaction layer is intentionally tiny.

Responsibilities:

Register shortcut

Determine if shortcut is valid

Signal interruption

Nothing more.

---

It does not:

Abort streams

Modify providers

Construct requests

Rewrite prompts

Manipulate buffers

Its job is to tell the state machine:

```text
User requested transition.
```

Nothing else.

---

# 14. Stream Lifecycle

## 14.1 Normal Lifecycle

Without interruption:

```text
Provider

↓

message_start

↓

thinking_start

↓

thinking_delta

↓

thinking_delta

↓

thinking_end

↓

text_start

↓

text_delta

↓

text_delta

↓

message_end
```

All events are forwarded unchanged.

---

## 14.2 Stop Thinking Lifecycle

```text
Provider A

↓

thinking_start

↓

thinking_delta

↓

thinking_delta

↓

User presses shortcut

↓

abort upstream

↓

capture final reasoning

↓

start Provider B

↓

thinking disabled

↓

text_start

↓

text_delta

↓

text_delta

↓

message_end
```

Critically,

the downstream consumer never observes the boundary.

---

## 14.3 Internal Lifecycle

Internally:

```text
Request A

↓

Abort

↓

Request B
```

Externally:

```text
Request

↓

Answer
```

The distinction is fundamental.

---

# 15. State Machine

The transition process shall be implemented as an explicit finite-state machine.

No implicit boolean flags.

No ad-hoc transitions.

No hidden lifecycle.

---

## States

```text
Idle

Delegating

Reasoning

StopRequested

Aborting

Capturing

Restarting

Splicing

Answering

Completed

Failed
```

---

## State Descriptions

### Idle

No active provider stream.

---

### Delegating

Wrapper forwarding events without modification.

---

### Reasoning

Reasoning events currently flowing.

Shortcut becomes active.

---

### StopRequested

User pressed shortcut.

No irreversible work performed yet.

Allows cancellation if necessary.

---

### Aborting

Abort signal sent upstream.

Awaiting termination.

---

### Capturing

Final reasoning deltas collected.

Freeze reasoning buffer.

No further reasoning accepted.

---

### Restarting

Replacement provider request issued.

Thinking disabled.

Awaiting first replacement event.

---

### Splicing

Both streams temporarily exist.

Proxy suppresses terminal events from upstream.

Replacement stream becomes authoritative.

---

### Answering

Replacement stream forwarding answer tokens.

Reasoning phase complete.

Shortcut disabled.

---

### Completed

Normal completion.

Cleanup.

Reset.

---

### Failed

Recovery path.

Delegate error.

Reset internal state.

---

# 16. State Transition Table

| Current       | Event                   | Next          |
| ------------- | ----------------------- | ------------- |
| Idle          | Stream begins           | Delegating    |
| Delegating    | First thinking event    | Reasoning     |
| Reasoning     | Shortcut                | StopRequested |
| StopRequested | Abort dispatched        | Aborting      |
| Aborting      | Upstream closed         | Capturing     |
| Capturing     | Replacement issued      | Restarting    |
| Restarting    | First replacement token | Splicing      |
| Splicing      | First answer token      | Answering     |
| Answering     | message_end             | Completed     |
| Any           | Fatal error             | Failed        |
| Completed     | Cleanup                 | Idle          |
| Failed        | Cleanup                 | Idle          |

---

# 17. State Invariants

Every state owns strict invariants.

---

## Idle

No streams exist.

No buffers allocated.

No active abort controller.

---

## Delegating

Exactly one upstream stream.

Zero replacement streams.

---

## Reasoning

Reasoning buffer mutable.

Shortcut enabled.

---

## StopRequested

Exactly one stop request may exist.

Subsequent shortcut presses ignored.

---

## Aborting

Abort dispatched exactly once.

Never retransmit.

---

## Capturing

Reasoning buffer immutable.

No additional reasoning events accepted.

---

## Restarting

Exactly one replacement request.

Never retry automatically.

---

## Splicing

Exactly one downstream stream.

Potentially two upstream providers.

Only replacement provider may emit terminal completion.

---

## Answering

Reasoning disabled permanently.

Only answer events forwarded.

---

## Completed

Cleanup must succeed even if telemetry fails.

---

## Failed

Wrapper returns Pi-compatible failure.

Internal state always reset before exit.

---

# 18. Event Forwarding Rules

The proxy shall behave according to the following rules.

| Event          | Before Stop         | During Transition         | After Restart       |
| -------------- | ------------------- | ------------------------- | ------------------- |
| message_start  | Forward             | Suppress duplicate        | Already emitted     |
| thinking_start | Forward             | Ignore                    | Never emit          |
| thinking_delta | Forward             | Ignore                    | Never emit          |
| thinking_end   | Forward if received | Optional                  | Never emit          |
| text_start     | Forward             | Replacement only          | Forward             |
| text_delta     | Forward             | Replacement only          | Forward             |
| tool_call      | Forward             | Suspend until replacement | Forward             |
| tool_result    | Forward             | Suspend                   | Forward             |
| message_end    | Forward             | Suppress upstream         | Forward replacement |

The **most important invariant** is that only one `message_end` event may ever reach the Pi agent runtime, regardless of how many upstream provider requests occur internally.


# 19. Provider Decoration Architecture

## 19.1 Design Philosophy

The extension shall **decorate** Pi's built-in OpenAI-compatible provider rather than replace it.

This distinction is fundamental.

The extension is **not** a provider implementation.

It is middleware.

It owns orchestration only.

Every other responsibility remains delegated to Pi.

---

## 19.2 Initialization Sequence

Initialization occurs exactly once during extension loading.

The following sequence is mandatory.

```text
Load Extension

↓

Capture Existing Provider

↓

Validate Provider Exists

↓

Register Wrapper

↓

Begin Normal Operation
```

The provider **must** be captured before registration.

Failure to do so will result in the wrapper capturing itself, producing infinite recursion.

This ordering requirement is absolute.

---

## 19.3 Capturing the Built-in Provider

The extension shall obtain the current provider implementation using Pi's provider registry.

The captured implementation becomes the canonical upstream delegate for the lifetime of the extension.

The extension shall never attempt to reconstruct provider behavior independently.

Once captured, all provider requests are delegated through this reference.

The extension shall never attempt to discover or instantiate provider implementations manually.

---

## 19.4 Wrapper Responsibilities

The wrapper owns only the following responsibilities:

* determine whether interception is required
* create orchestration state
* proxy the event stream
* coordinate interruption
* launch replacement request
* splice replacement stream
* forward terminal completion

Everything else shall immediately delegate upstream.

---

## 19.5 Wrapper Decision Tree

Every invocation of `streamSimple()` shall follow the same deterministic flow.

```text
Incoming Request

↓

Supported API?

↓

No

↓

Delegate

↓

Done

────────────

Yes

↓

Supported Provider?

↓

No

↓

Delegate

↓

Done

────────────

Yes

↓

Reasoning-Capable Model?

↓

No

↓

Delegate

↓

Done

────────────

Yes

↓

Construct Proxy

↓

Delegate Initial Request

↓

Monitor Stream
```

The overwhelming majority of requests should take the direct delegation path.

---

## 19.6 Activation Conditions

The wrapper shall activate only when all of the following are true.

### Condition A

Provider is z.ai.

### Condition B

The request uses the OpenAI-compatible provider.

### Condition C

The model supports reasoning.

### Condition D

The feature is enabled.

### Condition E

The wrapper is not already servicing another interruption.

Failure of any condition results in immediate delegation.

---

## 19.7 Pass-through Guarantee

When inactive, the wrapper shall behave identically to Pi's implementation.

This is stronger than simply forwarding requests.

The wrapper shall preserve:

* ordering
* metadata
* event timing
* completion semantics
* usage
* errors
* cancellation semantics
* stream identity

No observable behavior shall change.

---

# 20. Stream Proxy Design

## 20.1 Purpose

The Stream Proxy exists to hide the existence of multiple upstream requests.

Pi consumes exactly one logical event stream.

Internally the proxy may consume multiple streams.

---

## 20.2 Inputs

The proxy consumes:

Original provider stream

Replacement provider stream

Stop signal

State machine

Reasoning buffer

---

## 20.3 Output

The proxy produces exactly one stream.

This stream is presented to Pi as though it originated from a single provider request.

---

## 20.4 Internal Structure

```text
               Proxy

                 │

      ┌──────────┴──────────┐

      ▼                     ▼

Primary Stream      Secondary Stream

      │                     │

      └──────────┬──────────┘

                 ▼

          Unified Event Queue

                 ▼

         AssistantMessageEventStream
```

The downstream consumer never interacts directly with upstream streams.

---

## 20.5 Queue Ownership

The proxy owns one outbound event queue.

All upstream events are normalized before entering this queue.

No upstream provider may write directly to downstream consumers.

---

## 20.6 Event Authority

At every instant exactly one upstream stream is authoritative.

Initially:

Primary.

After interruption:

Secondary.

Authority never returns to the primary stream.

---

# 21. Stream Splicing Algorithm

## 21.1 Goal

Produce one continuous event stream despite replacing the upstream provider request.

---

## 21.2 Conceptual Algorithm

```text
Receive Event

↓

Forward Normally?

↓

Yes

↓

Forward

↓

Continue

────────────

Stop Requested?

↓

No

↓

Continue

────────────

Yes

↓

Freeze Primary

↓

Abort

↓

Capture Final State

↓

Launch Replacement

↓

Forward Replacement Events

↓

Suppress Primary Completion

↓

Emit Replacement Completion
```

---

## 21.3 Splice Boundary

The splice boundary begins when:

The user requests interruption.

The splice boundary ends when:

The first replacement event has been accepted.

During the splice boundary:

No downstream completion events may be emitted.

---

## 21.4 Primary Stream Rules

Before interruption:

Forward everything.

After interruption:

Ignore everything except transport cleanup.

The primary stream permanently loses authority.

---

## 21.5 Secondary Stream Rules

Before interruption:

Does not exist.

After interruption:

Owns all future events.

May emit:

text_start

text_delta

tool events

message_end

completion

---

## 21.6 Completion Ownership

Exactly one stream owns completion.

This is always the replacement stream after interruption.

The primary stream must never terminate the downstream stream.

---

# 22. Reasoning Detection

## 22.1 Purpose

The shortcut should only function while the model is actively reasoning.

Reasoning detection determines whether interruption is valid.

---

## 22.2 Detection Source

Reasoning state shall be inferred exclusively from provider events.

No timers.

No heuristics.

No polling.

---

## 22.3 Enter Reasoning

Reasoning begins upon receipt of:

thinking_start

or

first thinking_delta.

---

## 22.4 Leave Reasoning

Reasoning ends upon:

thinking_end

or

first answer token

or

provider completion.

---

## 22.5 Shortcut Availability

The shortcut is active only while:

Current State == Reasoning

All other states ignore shortcut requests.

---

# 23. Reasoning Buffer

## 23.1 Purpose

The buffer preserves reasoning emitted before interruption.

It exists solely to maximize continuity.

---

## 23.2 Design

Append-only.

Ordered.

Immutable after capture.

---

## 23.3 Buffer Lifetime

Allocated:

Beginning of reasoning.

Destroyed:

Completion.

Never reused.

---

## 23.4 Memory Constraints

The buffer shall grow only with reasoning events.

Answer text shall not be duplicated.

The proxy already forwards answer events.

---

## 23.5 Overflow

The MVP shall not truncate reasoning.

Future versions may introduce configurable limits.

---

# 24. Stop Signal

## 24.1 Source

User keyboard shortcut.

Only one source exists in MVP.

---

## 24.2 Semantics

The stop signal is a request.

Not a command.

The state machine determines whether it may proceed.

---

## 24.3 Idempotency

Multiple shortcut presses during one interruption shall be treated as one request.

The first press wins.

Subsequent presses are ignored.

---

## 24.4 Lifetime

The signal expires when:

Transition completes.

or

Transition fails.

---

# 25. Replacement Request Construction

## 25.1 Overview

The replacement request shall be constructed immediately after interruption.

It represents the continuation of the existing logical interaction.

It is not a new user interaction.

---

## 25.2 Design Goals

Minimize latency.

Maximize reuse.

Avoid rebuilding unnecessary state.

Delegate as much work as possible to Pi.

---

## 25.3 Context Reuse

The replacement request shall reuse the same conversational context as the interrupted request.

No conversation rewriting should occur unless required to preserve correctness.

---

## 25.4 Prompt Reuse

The original user prompt shall remain unchanged.

The extension shall never rewrite user intent.

---

## 25.5 System Prompt

The extension may augment the system prompt for the replacement request.

Any augmentation must be:

deterministic

minimal

ephemeral

The augmentation must exist only for the replacement request.

---

## 25.6 Thinking Configuration

The replacement request shall disable reasoning.

The exact mechanism is implementation-specific and depends upon the provider payload.

For z.ai this includes disabling the provider's reasoning mode and omitting any reasoning effort configuration that would reactivate thinking.

---

## 25.7 Model Selection

The MVP shall reuse the existing model.

Automatic model switching is explicitly out of scope.

---

## 25.8 Temperature

The replacement request should preserve the original sampling parameters unless experimentation demonstrates a measurable benefit from deterministic decoding.

This is intentionally left configurable within the implementation but shall default to preserving user-selected behavior.

---

# 26. Prompt Morphing Philosophy

The extension is **not** performing prompt engineering.

It is preserving conversational intent while altering execution strategy.

Those are different operations.

The implementation shall avoid introducing verbose instructions that materially alter the assistant's behavior beyond the singular objective of ending the reasoning phase and producing the best available answer.

Any injected guidance should therefore be treated as an execution directive rather than an attempt to redefine the user's request.

The user asked one question.

The model should answer that question.

The extension's responsibility is only to change **how** the answer is obtained, never **what** is being asked.


---

# Part 4 — Internal Interfaces & Module Specifications

This becomes the implementation contract.

Every module gets:

* responsibilities
* ownership
* lifecycle
* public interface
* private state
* invariants
* dependencies
* thread/concurrency assumptions

For example:

* ProviderDecorator
* StreamProxy
* TransitionController
* ReasoningBuffer
* ShortcutManager
* RequestBuilder
* EventNormalizer
* ConfigurationManager
* TelemetryManager

Each with sequence diagrams and interface definitions.

---

# Part 5 — Complete Event Specification

Currently we describe events conceptually.

Instead we should specify:

Every event Pi emits.

Every event the wrapper emits.

Every event that must never be emitted.

Ordering guarantees.

Illegal transitions.

Duplicate suppression.

Terminal conditions.

Handling malformed provider streams.

Handling provider disconnects.

Handling partial SSE frames.

Tool call events.

Reasoning deltas.

Usage events.

---

# Part 6 — Failure Modes

This should be extensive.

Examples:

User presses shortcut before first token.

User presses during tool call.

Provider already finished.

Abort races completion.

Abort races socket close.

Second request fails.

Authentication expires.

Network disconnect.

Reasoning never starts.

Reasoning starts twice.

Duplicate message_start.

Missing message_end.

Malformed provider response.

Provider ignores reasoning disable.

Shortcut spam.

Double abort.

Provider timeout.

Each needs:

Detection.

Recovery.

Expected UX.

Logging.

Telemetry.

Testing requirements.

---

# Part 7 — Configuration Specification

Everything configurable.

Shortcut.

Feature enable.

Reasoning detection thresholds.

Debug logging.

Developer mode.

Experimental flags.

Provider allowlist.

Maximum reasoning buffer.

Transition timeout.

Retry policy.

---

# Part 8 — Observability

Exactly what gets logged.

Exactly what never gets logged.

Reasoning privacy.

Performance metrics.

Latency.

Abort duration.

Transition duration.

Failure counters.

Anonymous telemetry.

Debug trace mode.

---

# Part 9 — Performance Requirements

Memory limits.

CPU overhead.

Latency budget.

Maximum allocations.

Streaming throughput.

Buffer limits.

Expected overhead.

Success criteria.

---

# Part 10 — Test Plan

This should probably exceed 100 test cases.

Including:

Unit tests.

Integration tests.

Provider simulation.

Chaos testing.

Race conditions.

Fuzzing.

Golden stream replay.

Regression tests.

Stress tests.

Long-running reasoning.

Network failures.

Cancellation races.

---

# Part 11 — Acceptance Criteria

A production checklist.

Examples:

✓ No duplicate assistant messages.

✓ No additional Pi turn.

✓ No observable behavior when inactive.

✓ Works on all supported z.ai reasoning models.

✓ Shortcut latency under X ms.

✓ Zero memory leaks.

✓ Proper cleanup.

✓ No regression versus built-in provider.

---

# Part 12 — Future Architecture

Not implementation.

Architecture.

How to add:

OpenRouter.

Anthropic.

Gemini.

DeepSeek.

Native provider middleware if Pi eventually exposes it.

Multiple stop strategies.

Adaptive interruption.

Provider capability discovery.

This keeps future work from polluting the MVP while making extension straightforward.

---

# 27. Internal Module Specification

## 27.1 Module Overview

The implementation shall be decomposed into independent modules with explicit ownership boundaries.

No module shall own responsibilities assigned to another module.

The implementation shall avoid "god objects."

```text
Extension

├── ProviderDecorator
├── StreamProxy
├── TransitionController
├── RequestBuilder
├── ReasoningBuffer
├── ShortcutManager
├── EventNormalizer
├── Configuration
├── Telemetry
└── Diagnostics
```

Each module shall have exactly one primary responsibility.

---

# 28. ProviderDecorator Module

## Responsibility

Own interception of Pi's provider interface.

## Owns

* built-in provider capture
* wrapper registration
* provider activation
* provider delegation
* proxy construction

## Does Not Own

* transition state
* reasoning
* buffering
* keyboard shortcuts
* telemetry

---

## Public Interface

Initialize

Shutdown

Decorate Provider

Restore Provider

Delegate Request

---

## Private State

Captured Provider Reference

Registration State

Supported Provider Cache

Configuration Reference

---

## Invariants

Captured provider is immutable.

Registration occurs exactly once.

Decoration is reversible.

Wrapper never delegates to itself.

---

# 29. StreamProxy Module

## Responsibility

Merge multiple upstream provider streams into one downstream stream.

---

## Owns

Outbound event queue

Active upstream stream

Replacement stream

Completion suppression

Terminal event ownership

---

## Does Not Own

Prompt construction

Abort logic

Shortcut processing

Reasoning decisions

---

## Public Interface

Create Proxy

Forward Event

Begin Transition

Attach Replacement Stream

Complete

Fail

Dispose

---

## Internal Data

```text
Primary Stream

Secondary Stream

Output Stream

Queue

Completion Owner

Transition State
```

---

## Invariants

Exactly one output stream.

Exactly one completion event.

Exactly one active authority.

---

# 30. TransitionController Module

## Responsibility

Own interruption lifecycle.

No other module may mutate transition state.

---

## Public Interface

Request Stop

Abort Upstream

Freeze Reasoning

Launch Replacement

Begin Splice

Complete Transition

Reset

---

## Internal State

```text
Current State

Abort Controller

Transition Token

Request Metadata

Timing
```

---

## Invariants

Single active transition.

Single abort controller.

Transition tokens unique.

---

# 31. RequestBuilder Module

## Responsibility

Construct replacement provider request.

---

## Inputs

Original request

Configuration

Reasoning snapshot

Transition metadata

---

## Outputs

Replacement request.

---

## Rules

Original user prompt preserved.

Conversation preserved.

Thinking disabled.

System augmentation optional.

Sampling preserved by default.

Model preserved.

---

## Non-responsibilities

Network

Streaming

Retries

---

# 32. ReasoningBuffer Module

## Responsibility

Capture reasoning emitted prior to interruption.

---

## Internal Representation

Append-only ordered collection.

Each entry contains

```text
Offset

Timestamp

Provider Event

Raw Payload
```

---

## Operations

Append

Freeze

Snapshot

Reset

Dispose

---

## Invariants

Ordering preserved.

Snapshots immutable.

Reset clears memory.

---

# 33. ShortcutManager Module

## Responsibility

Own keyboard interaction.

---

## Responsibilities

Register shortcut.

Enable shortcut.

Disable shortcut.

Forward stop request.

---

## Invariants

Shortcut active only during reasoning.

Shortcut disabled after transition begins.

Shortcut idempotent.

---

# 34. EventNormalizer Module

## Responsibility

Normalize provider events before downstream emission.

---

## Responsibilities

Ordering validation.

Duplicate suppression.

Terminal suppression.

Transition filtering.

---

## Rules

Events must preserve causal ordering.

No downstream duplication.

Unknown events pass through unchanged.

---

# 35. Telemetry Module

## Responsibility

Record operational metrics.

Must never affect functionality.

Telemetry failures are ignored.

---

## Metrics

Reasoning duration.

Transition duration.

Abort latency.

Restart latency.

Completion latency.

Failure counts.

Success counts.

Ignored shortcut count.

---

## Privacy

No prompts.

No reasoning.

No assistant output.

No API keys.

No user identifiers.

---

# 36. Diagnostics Module

## Responsibility

Developer debugging.

Disabled by default.

---

## Diagnostic Modes

Disabled

Errors

Verbose

Trace

---

Verbose logging shall never modify runtime behavior.

---

# 37. Concurrency Model

The extension assumes a cooperative asynchronous execution model.

No module shall rely on thread affinity.

All mutable state shall be owned by exactly one module.

---

## Ownership Rules

TransitionController

owns transition state.

ReasoningBuffer

owns reasoning.

StreamProxy

owns stream routing.

ShortcutManager

owns input state.

ProviderDecorator

owns provider registration.

No mutable state shall have multiple owners.

---

# 38. Event Ordering Specification

The wrapper shall preserve event ordering except where explicitly required to suppress obsolete upstream events.

---

## Ordering Guarantee

If

```text
A happens-before B
```

then

```text
A must be emitted before B
```

unless

A is intentionally suppressed.

---

## Legal Event Sequence

```text
message_start

thinking_start

thinking_delta*

thinking_end?

text_start

text_delta*

tool_call*

tool_result*

message_end
```

---

## Illegal Event Sequence

```text
message_end

message_start
```

---

```text
text_delta

thinking_delta
```

---

```text
message_end

text_delta
```

---

```text
duplicate message_start
```

---

Illegal sequences shall produce diagnostics.

---

# 39. Transition Event Rules

During transition the proxy temporarily diverges from upstream ordering.

---

Allowed

Suppress terminal completion.

Suppress obsolete thinking.

Forward replacement text.

---

Forbidden

Emit duplicate message_start.

Emit duplicate message_end.

Emit replacement before transition ownership changes.

Emit upstream completion after replacement begins.

---

# 40. Replacement Stream Requirements

Replacement stream becomes authoritative only after:

Primary successfully aborted.

Reasoning frozen.

Replacement request accepted.

---

Until then

Primary remains authoritative.

---

# 41. Buffer Ownership During Transition

Before interruption

ReasoningBuffer mutable.

---

After interruption

ReasoningBuffer frozen.

---

After replacement

ReasoningBuffer read-only.

---

After completion

ReasoningBuffer destroyed.

---

# 42. Failure Mode Specification

## FM-001

Shortcut before stream begins.

Expected Behavior

Ignore.

---

## FM-002

Shortcut before reasoning begins.

Expected Behavior

Ignore.

---

## FM-003

Shortcut after answer generation begins.

Expected Behavior

Ignore.

---

## FM-004

Repeated shortcut presses.

Expected Behavior

First request accepted.

All subsequent requests ignored.

---

## FM-005

Abort races provider completion.

Expected Behavior

If provider already completed,

transition cancelled.

Normal completion continues.

---

## FM-006

Provider ignores abort.

Expected Behavior

Transition timeout.

Replacement not launched.

Normal stream preserved.

---

## FM-007

Replacement request rejected.

Expected Behavior

Forward provider error.

Cleanup.

---

## FM-008

Replacement authentication failure.

Expected Behavior

Surface provider authentication error.

Cleanup.

---

## FM-009

Network disconnect before interruption.

Expected Behavior

Delegate normal provider failure.

---

## FM-010

Network disconnect during interruption.

Expected Behavior

Replacement cancelled.

Failure propagated.

Cleanup.

---

## FM-011

Replacement stream terminates immediately.

Expected Behavior

Forward completion.

Destroy transition state.

---

## FM-012

Replacement never produces first event.

Expected Behavior

Timeout.

Abort replacement.

Forward error.

Cleanup.

---

## FM-013

Malformed provider event.

Expected Behavior

Forward if possible.

Otherwise terminate stream.

Log diagnostics.

---

## FM-014

Unexpected duplicate completion.

Expected Behavior

Suppress duplicate.

Emit exactly one downstream completion.

---

## FM-015

Unexpected upstream events after authority transfer.

Expected Behavior

Discard silently.

Log trace diagnostics.

---

# 43. Timeout Requirements

Reasoning timeout

Provider controlled.

---

Transition timeout

Configurable.

---

Replacement startup timeout

Configurable.

---

Cleanup timeout

Best effort.

Never block user-visible completion.

---

# 44. Resource Management

Every transition allocates

Reasoning buffer.

Abort controller.

Transition state.

Telemetry context.

Proxy queue.

---

Every completion shall release

Reasoning buffer.

Abort controller.

Proxy queue.

Transition token.

Temporary request state.

No allocations shall survive beyond stream completion.

---

# 45. Memory Requirements

The extension shall allocate memory proportional only to:

Captured reasoning.

Temporary transition state.

No assistant answer text shall be duplicated in memory unless required by Pi's existing event stream implementation.

Peak additional memory consumption shall be linear with captured reasoning size and constant with respect to completed answer length.

---

# 46. Performance Requirements

Inactive wrapper overhead:

Effectively zero beyond one delegation call.

---

Shortcut processing:

Target under 5 ms.

---

Abort dispatch:

Immediate.

---

Replacement request construction:

Target under 10 ms.

---

Event forwarding:

No batching.

No artificial buffering.

No additional latency beyond scheduling overhead.

---

# 47. Configuration Specification

```text
enabled

shortcut

supportedProviders

transitionTimeout

startupTimeout

debugMode

telemetryEnabled

maximumReasoningBuffer

allowExperimentalProviderFlags
```

Every option shall have deterministic defaults.

Configuration changes shall apply only to future requests unless explicitly documented otherwise.

---

# 48. Acceptance Criteria

The implementation shall be considered production-ready only if all of the following are satisfied.

✓ One logical assistant interaction.

✓ No visible restart.

✓ No additional user prompt.

✓ No duplicate assistant turn.

✓ Wrapper observationally equivalent when inactive.

✓ Automatic delegation for unsupported providers.

✓ Deterministic interruption behavior.

✓ Proper cleanup after success.

✓ Proper cleanup after failure.

✓ No leaked abort controllers.

✓ No leaked buffers.

✓ No duplicate completion events.

✓ All ownership invariants preserved.

✓ All state machine transitions validated.

✓ No regression in normal Pi provider behavior.

---

# 49. Future Compatibility

The architecture intentionally separates orchestration from provider implementation.

Support for additional providers shall consist primarily of capability detection and provider-specific replacement request construction while preserving the existing ProviderDecorator, StreamProxy, TransitionController, and State Machine architecture.

No future provider integration shall require redesign of the orchestration layer.

---

# 50. Implementation Roadmap

## Phase 0 — Foundation

Objective:

Create an observationally-equivalent provider decorator that performs zero behavioral changes.

### Deliverables

* Extension skeleton
* Provider capture
* Provider registration
* Delegation validation
* Diagnostics
* Feature flag

### Success Criteria

All requests behave identically with the extension installed.

No measurable regression.

---

## Phase 1 — Event Proxy

Objective

Insert the StreamProxy without changing observable behavior.

### Deliverables

Outbound proxy stream.

Event forwarding.

Ordering validation.

Duplicate suppression.

Trace diagnostics.

### Success Criteria

Golden stream replay matches Pi output exactly.

---

## Phase 2 — Transition State Machine

Objective

Implement the interruption lifecycle independent of provider behavior.

### Deliverables

TransitionController.

State validation.

Transition tokens.

Cleanup logic.

Timeout framework.

### Success Criteria

All state transitions unit tested.

Illegal transitions impossible.

---

## Phase 3 — Reasoning Detection

Objective

Detect active reasoning.

### Deliverables

Reasoning tracker.

Shortcut enablement.

Reasoning buffer.

### Success Criteria

Shortcut activates only during reasoning.

---

## Phase 4 — Abort Coordination

Objective

Terminate upstream reasoning safely.

### Deliverables

Abort controller ownership.

Transition timing.

Freeze semantics.

### Success Criteria

Abort always occurs exactly once.

---

## Phase 5 — Replacement Generation

Objective

Launch replacement request.

### Deliverables

RequestBuilder.

Replacement invocation.

Thinking disabled.

### Success Criteria

Replacement begins successfully.

---

## Phase 6 — Stream Splicing

Objective

Merge replacement stream.

### Deliverables

Authority transfer.

Completion suppression.

Replacement ownership.

### Success Criteria

Pi observes one uninterrupted stream.

---

## Phase 7 — Hardening

Objective

Production readiness.

### Deliverables

Telemetry.

Diagnostics.

Stress testing.

Performance optimization.

Documentation.

---

# 51. Complete Transition Algorithm

## Initial State

```text id="v6g31d"
Wrapper

↓

Delegate request

↓

Receive provider stream
```

---

## Stream Processing Loop

```text id="gqzr3u"
Receive Event

↓

Normalize

↓

Validate

↓

Forward

↓

Continue
```

Until interruption occurs.

---

## Stop Request

```text id="zprh5r"
Shortcut

↓

TransitionController

↓

Validate

↓

Already transitioning?

↓

Yes → Ignore

↓

No

↓

Create Transition Token

↓

Freeze Shortcut

↓

Proceed
```

---

## Abort Phase

```text id="o2ks4s"
Abort Controller

↓

Dispatch Abort

↓

Await Upstream Exit

↓

Capture Final Reasoning

↓

Freeze Buffer
```

No replacement request may begin before reasoning is frozen.

---

## Replacement Phase

```text id="lmdzq6"
Snapshot Context

↓

Build Request

↓

Disable Thinking

↓

Invoke Captured Provider

↓

Receive Replacement Stream
```

---

## Authority Transfer

```text id="c97eoh"
Primary Stream

↓

Terminal Events Suppressed

↓

Secondary Stream

↓

Authoritative
```

Authority transfer is irreversible.

---

## Completion

```text id="f8w34q"
Replacement Completes

↓

Emit message_end

↓

Cleanup

↓

Idle
```

---

# 52. Detailed Event Processing Rules

Every provider event passes through the same processing pipeline.

```text id="juzb8s"
Provider Event

↓

Validation

↓

Normalization

↓

Transition Filter

↓

Ordering Validator

↓

Forward

↓

Telemetry

↓

Done
```

---

## Validation Rules

Unknown events:

Pass through unchanged.

Malformed events:

Log diagnostics.

Attempt recovery.

Terminate only if downstream integrity cannot be preserved.

---

## Ordering Validation

Every event is assigned a monotonically increasing sequence number.

Ordering violations produce diagnostics.

Fatal ordering violations terminate the transition.

---

## Duplicate Detection

Duplicate terminal events are discarded.

Duplicate message_start events are fatal.

Duplicate thinking events are ignored after authority transfer.

---

# 53. Replacement Request Specification

## Inputs

Original request context.

Conversation history.

Original model.

Original sampling parameters.

Frozen reasoning snapshot.

Configuration.

---

## Transformation Rules

Preserve:

Conversation.

User prompt.

Assistant history.

Model.

Sampling parameters (default).

Provider.

Modify:

Thinking configuration.

Ephemeral execution directive.

Internal transition metadata.

Do not modify:

User intent.

Conversation ordering.

Session identity.

Visible history.

---

## Ephemeral Execution Directive

The replacement request may include a transient execution directive instructing the model to immediately produce its best available answer based on the current conversational context rather than initiating a new extended reasoning phase.

This directive shall exist only within the replacement request and shall not become part of the persisted conversation history.

---

# 54. Error Recovery

Every recoverable failure shall leave Pi in a valid state.

---

## Recovery Hierarchy

Level 1

Ignore.

Continue.

---

Level 2

Disable transition.

Continue original stream.

---

Level 3

Terminate replacement.

Forward provider error.

---

Level 4

Terminate proxy.

Forward fatal error.

Cleanup.

---

No recovery path may leave allocated resources orphaned.

---

# 55. Testing Strategy

## Unit Tests

ProviderDecorator.

StreamProxy.

TransitionController.

ReasoningBuffer.

RequestBuilder.

ShortcutManager.

EventNormalizer.

Configuration.

Telemetry.

Diagnostics.

---

## Integration Tests

Normal delegation.

Reasoning interruption.

Unsupported providers.

Multiple interruptions.

Provider failures.

Authentication failures.

Timeouts.

---

## Golden Replay Tests

Capture real provider event streams.

Replay through wrapper.

Assert byte-for-byte equivalent downstream output when inactive.

---

## Transition Replay

Capture interrupted reasoning.

Replay interruption.

Verify downstream stream continuity.

---

## Property Tests

Exactly one completion.

Exactly one authority.

No duplicate start.

No duplicate end.

No leaked buffers.

---

## Stress Tests

Thousands of interruptions.

Large reasoning buffers.

High latency providers.

Rapid shortcut presses.

Repeated provider initialization.

---

# 56. Observability

Every transition shall emit structured telemetry.

Fields include:

```text id="zjh8b8"
Transition ID

Provider

Model

Reasoning Duration

Transition Duration

Abort Latency

Replacement Startup

Completion Duration

Outcome
```

No prompt text.

No reasoning text.

No assistant output.

---

# 57. Logging Specification

Trace

Every state transition.

---

Debug

Lifecycle milestones.

---

Info

Successful transitions.

---

Warning

Recoverable failures.

---

Error

Fatal failures.

---

Logs shall be structured.

No free-form parsing shall be required.

---

# 58. Security Considerations

The extension shall never:

Persist API keys.

Persist prompts.

Persist reasoning.

Persist generated answers.

Transmit telemetry containing conversational content.

Introduce additional network destinations.

Bypass Pi authentication.

Modify provider credentials.

All provider communication shall continue through Pi's existing provider implementation.

---

# 59. Architectural Constraints

The following constraints are mandatory.

The extension shall not:

* modify Pi core source code
* monkey-patch unrelated runtime components
* replace networking libraries
* replace SSE parsing
* duplicate provider implementations
* maintain independent model catalogs
* maintain independent authentication logic
* introduce provider-specific forks beyond narrowly scoped request transformation
* alter session persistence semantics
* alter conversation history

Violation of any constraint constitutes an architectural regression.

---

# 60. Production Readiness Checklist

## Functional

□ Shortcut activates only during reasoning.

□ Unsupported providers delegate transparently.

□ One logical assistant response.

□ No visible restart.

□ No visible synthetic assistant message.

□ No additional user interaction.

□ Transition succeeds under expected z.ai latency.

---

## Reliability

□ All resources cleaned.

□ No memory leaks.

□ Timeout recovery verified.

□ Replacement failures handled.

□ Abort races tested.

□ Duplicate event suppression verified.

---

## Performance

□ Inactive overhead negligible.

□ Event forwarding non-blocking.

□ Transition latency acceptable.

□ Memory usage bounded.

---

## Maintainability

□ Wrapper delegates all provider behavior.

□ No duplicated protocol logic.

□ Minimal z.ai-specific code isolated to RequestBuilder.

□ Future provider support requires only capability adaptation rather than architectural changes.

---

# Appendix A — Glossary

**Authority Transfer** — The moment at which the replacement provider stream becomes the sole source of downstream events.

**Captured Provider** — The original Pi provider implementation obtained before wrapper registration.

**Delegation** — Forwarding a request to the captured provider without modification.

**Observational Equivalence** — Property whereby downstream behavior is indistinguishable from the built-in implementation when the feature is inactive.

**Primary Stream** — The original provider request initiated by Pi.

**Replacement Stream** — The thinking-disabled provider request created after interruption.

**Splicing** — The process of suppressing terminal events from the primary stream and seamlessly continuing event emission from the replacement stream within a single downstream `AssistantMessageEventStream`.

**Transition** — The complete lifecycle beginning with the user invoking Stop Thinking & Do and ending with restoration of the idle state.

**Wrapper** — The middleware implementation that decorates Pi's built-in OpenAI-compatible provider without reimplementing its protocol or transport logic.

---

# Appendix B — Edge Case Matrix

This appendix defines normative behavior for every identified edge case. Where this appendix conflicts with implementation convenience, this appendix takes precedence.

---

# EC-001 — Shortcut Before First Provider Event

## Initial State

```text
Delegating
```

No provider events received.

No reasoning detected.

## Expected Behavior

Ignore shortcut.

Continue waiting.

## Rationale

The wrapper has not yet established whether the model is reasoning.

Issuing an interruption would introduce unnecessary complexity while providing no measurable UX improvement.

---

# EC-002 — Shortcut During Network Stall

## Scenario

The provider accepted the request.

No stream has begun.

Several seconds have elapsed.

User presses Stop Thinking.

## Expected Behavior

The wrapper records the stop request.

The request enters a Pending Stop state.

The first reasoning event immediately triggers interruption.

If the first provider event is answer text instead of reasoning, the pending stop request is discarded.

---

# EC-003 — Provider Never Enters Reasoning

Some reasoning-capable models occasionally skip reasoning entirely.

Example:

```text
message_start

text_start

text_delta

...
```

## Expected Behavior

Shortcut remains disabled.

No interruption possible.

---

# EC-004 — Provider Immediately Answers

```text
message_start

text_start
```

Shortcut never activates.

Wrapper performs zero additional work.

---

# EC-005 — Shortcut During thinking_end

```text
thinking_end

<user presses key>

text_start
```

## Expected Behavior

Ignore interruption.

Reasoning has already completed.

The user has already reached the desired state.

---

# EC-006 — Shortcut During First Answer Token

```text
text_start

Ctrl+.
```

Expected Behavior

Ignore.

The model is already answering.

---

# EC-007 — Provider Finishes While Abort Is Dispatching

Timeline

```text
thinking_delta

Ctrl+.

Abort()

Provider finishes naturally
```

Expected Behavior

Natural completion wins.

Replacement request cancelled.

No interruption performed.

---

# EC-008 — Abort Completes After Replacement Starts

This should never occur.

Replacement request may not begin until upstream ownership has been relinquished.

Violation constitutes an implementation defect.

---

# EC-009 — Duplicate Shortcut

```text
Ctrl+.

Ctrl+.

Ctrl+.
```

Expected Behavior

One transition.

Remaining requests ignored.

---

# EC-010 — Shortcut Held Down

Operating systems may auto-repeat key events.

Expected Behavior

First event accepted.

Remaining events discarded.

No additional allocations.

---

# EC-011 — Extension Disabled Mid-Request

User disables extension.

Current transition continues.

Future requests bypass wrapper.

---

# EC-012 — Extension Unloaded Mid-Transition

Expected Behavior

Wrapper completes active request.

Provider registration restored.

Cleanup performed.

---

# EC-013 — Provider Reload

If Pi reloads providers.

Expected Behavior

Decorator re-registers.

Captured provider refreshed.

Existing streams continue unaffected.

---

# EC-014 — Unsupported Model

Provider:

z.ai

Model:

non-reasoning

Expected Behavior

Transparent delegation.

---

# EC-015 — Unsupported Provider

```text
provider == openrouter
```

Expected Behavior

Immediate delegation.

---

# EC-016 — Feature Disabled

Configuration disables Stop Thinking.

Wrapper delegates without allocating transition state.

---

# EC-017 — Replacement Request Returns Reasoning Anyway

Some providers may ignore reasoning configuration.

Expected Behavior

The wrapper shall detect renewed reasoning events and, by default, forward them rather than recursively attempting another interruption.

Only one Stop Thinking transition is permitted per logical assistant response in the MVP.

Recursive interruption is explicitly out of scope.

---

# EC-018 — Provider Returns Empty Response

Replacement stream completes without content.

Expected Behavior

Forward completion.

Record telemetry.

Do not retry automatically.

---

# EC-019 — Provider Returns Error Immediately

Replacement request fails before first event.

Expected Behavior

Forward provider failure.

Cleanup.

---

# EC-020 — Malformed Thinking Event

Expected Behavior

Log diagnostics.

Continue if ordering remains recoverable.

Otherwise terminate transition.

---

# Appendix C — Race Conditions

---

# RC-001

Abort vs Completion

Winner:

First terminal state observed.

---

# RC-002

Shortcut vs Answer Start

Winner:

Answer start.

Reasoning already complete.

---

# RC-003

Shortcut vs Shortcut

Winner:

First request.

---

# RC-004

Abort vs Timeout

Winner:

First terminal transition.

---

# RC-005

Cleanup vs Telemetry

Cleanup always wins.

Telemetry is best effort.

---

# RC-006

Provider Error vs Replacement Success

Provider error originating from the primary stream after authority transfer shall be ignored.

The replacement stream is authoritative.

---

# Appendix D — Sequence Diagrams

## Normal Request

```text
User

 |

 v

Pi

 |

 v

Wrapper

 |

 v

Built-in Provider

 |

 v

z.ai

 |

 v

Built-in Provider

 |

 v

Wrapper

 |

 v

Pi

 |

 v

User
```

---

## Interrupted Request

```text
User

 |

 v

Pi

 |

 v

Wrapper

 |

 v

Built-in Provider

 |

 v

z.ai

 |

thinking...

 |

Ctrl+.

 |

Abort

 |

Restart

 |

Answer

 |

Built-in Provider

 |

Wrapper

 |

Pi

 |

User
```

---

# Appendix E — Implementation Constraints

The following implementation techniques are prohibited.

## Prohibited

Reimplementing SSE parsing.

Maintaining duplicate model metadata.

Forking Pi provider code.

Persisting reasoning.

Monkey-patching unrelated runtime modules.

Changing Pi session storage.

Creating synthetic user messages.

Creating synthetic assistant turns.

Using undocumented internal APIs when supported extension APIs provide equivalent functionality.

---

## Strongly Discouraged

Global mutable state.

Hidden singleton ownership.

Background polling.

Time-based reasoning detection.

Regex parsing provider payloads already normalized by Pi.

Copying assistant output unnecessarily.

---

# Appendix F — Coding Standards

Every exported module shall include:

* Responsibility statement
* Ownership statement
* Lifecycle description
* Invariants
* Failure modes

Every public function shall document:

* Preconditions
* Postconditions
* Side effects
* Ownership changes

State transitions shall be represented explicitly using discriminated unions or equivalent strongly typed constructs.

Boolean flag combinations shall not be used to encode lifecycle state.

Magic numbers are prohibited.

Provider-specific constants shall be centralized.

Configuration defaults shall be immutable.

---

# Appendix G — Architectural Success Criteria

The architecture shall be considered successful if a user cannot distinguish between:

1. A hypothetical provider that natively supports "stop reasoning and answer now"; and
2. The orchestration implemented by this extension.

Specifically, the implementation shall satisfy the following observable properties:

* The user submits one prompt.
* The user presses one shortcut.
* The user receives one assistant response.
* No visible restart occurs.
* No visible replay occurs.
* No additional user message appears.
* No additional assistant turn appears.
* Pi's conversation history remains semantically equivalent to a native interruptible reasoning implementation.
* When the feature is never invoked, the extension behaves as an observationally transparent middleware layer over Pi's built-in OpenAI-compatible provider.

---

# Appendix H — Security & Privacy Model

## Security Objectives

The extension shall not expand the attack surface of Pi beyond the minimum required to implement Stop Thinking & Do.

All existing provider authentication, authorization, credential handling, and network transport shall remain owned by Pi.

---

## Trust Boundaries

```text id="sec01"
+------------------------------------------------------+
|                   Pi Runtime                         |
|                                                      |
|  +-------------------------------+                   |
|  | Stop Thinking Extension        |                   |
|  |                               |                   |
|  |  Stream Proxy                 |                   |
|  |  Transition Controller        |                   |
|  |  Request Builder              |                   |
|  +-------------------------------+                   |
|                 |                                    |
|                 V                                    |
|        Built-in Provider                             |
+-----------------|------------------------------------+
                  |
                  V
             Provider API
                  |
                  V
                z.ai
```

The extension shall never communicate directly with external services other than through Pi's delegated provider implementation.

---

## Sensitive Data

Sensitive data includes, but is not limited to:

* API keys
* OAuth credentials
* Provider access tokens
* User prompts
* Conversation history
* Assistant output
* Reasoning output
* Tool call arguments
* Tool call results
* File contents
* Binary attachments

---

## Storage Rules

The extension shall never persist:

* reasoning
* prompts
* assistant output
* API credentials

Temporary in-memory state shall exist only for the lifetime of the active stream.

---

## Logging Rules

The following fields may be logged:

* Provider name
* Model identifier
* Transition ID
* Timing metrics
* Event counts
* State transitions
* Error categories

The following fields shall never be logged:

* Prompt text
* Assistant output
* Reasoning output
* API keys
* Authorization headers
* Tool arguments
* Tool outputs

---

# Appendix I — Telemetry Schema

## Event: TransitionStarted

```text id="tele01"
transitionId

provider

model

timestamp

reasoningElapsedMs
```

---

## Event: TransitionCompleted

```text id="tele02"
transitionId

abortLatencyMs

restartLatencyMs

spliceLatencyMs

completionLatencyMs

totalDurationMs

success
```

---

## Event: TransitionFailed

```text id="tele03"
transitionId

failureCategory

failurePhase

provider

model

timestamp
```

---

## Failure Categories

```text id="tele04"
AbortFailed

ReplacementRejected

ProviderTimeout

NetworkFailure

MalformedEvent

OrderingViolation

UnexpectedTermination

InternalError
```

---

## Performance Counters

```text id="tele05"
RequestsDelegated

TransitionsRequested

TransitionsCompleted

TransitionsFailed

IgnoredShortcutPresses

AverageTransitionLatency

AverageAbortLatency

AverageRestartLatency
```

---

# Appendix J — Extension Manifest Requirements

The extension manifest shall define:

* Extension identifier
* Name
* Description
* Version
* Compatible Pi version
* Required APIs
* Registered provider
* Registered shortcut
* Configuration schema

---

## Required Permissions

The extension shall request only permissions required for:

* Provider registration
* Keyboard shortcut registration
* Configuration access

No additional permissions shall be requested.

---

# Appendix K — Configuration Schema

```yaml
enabled: true

shortcut: "Ctrl+."

supportedProviders:
  - zai

transitionTimeoutMs: 5000

replacementStartupTimeoutMs: 10000

maximumReasoningBufferBytes: 8388608

telemetry:
  enabled: false

diagnostics:
  level: error

experimental:
  allowRecursiveInterrupt: false
```

---

## Configuration Validation Rules

Configuration shall be validated during extension initialization.

Invalid configuration shall:

* Produce diagnostics
* Fall back to defaults
* Never prevent normal provider delegation

---

# Appendix L — Compatibility Matrix

| Pi Version                   | Status                           |
| ---------------------------- | -------------------------------- |
| Supported production release | Required                         |
| Earlier unsupported releases | Best effort                      |
| Future releases              | Expected via provider delegation |

---

## Provider Matrix

| Provider   | MVP                    |
| ---------- | ---------------------- |
| z.ai       | Supported              |
| OpenAI     | Transparent delegation |
| Anthropic  | Transparent delegation |
| OpenRouter | Transparent delegation |
| Groq       | Transparent delegation |
| DeepSeek   | Transparent delegation |

---

## Model Matrix

| Model Capability       | Behavior                   |
| ---------------------- | -------------------------- |
| Reasoning-enabled z.ai | Full Stop Thinking support |
| Non-reasoning z.ai     | Transparent delegation     |
| Unsupported provider   | Transparent delegation     |

---

# Appendix M — Developer Debugging Guide

## Trace Levels

### Error

Fatal failures only.

---

### Warning

Recoverable transition anomalies.

---

### Info

Successful transitions.

Timing summaries.

---

### Debug

Event routing.

Authority transfer.

Transition lifecycle.

---

### Trace

Every provider event.

Every state transition.

Every ownership change.

Every timeout.

Every cleanup action.

---

## Trace Correlation

Every log emitted during a transition shall include:

```text id="dbg01"
transitionId

streamId

provider

model

currentState

timestamp
```

---

# Appendix N — Future Extension Points

The following interfaces shall remain isolated to permit future evolution without redesigning the orchestration layer.

## Capability Detection

Future providers may expose native "stop reasoning" APIs.

The RequestBuilder shall encapsulate capability negotiation.

---

## Provider Adapters

Future providers shall implement provider-specific request transformation through adapter modules without modifying the TransitionController or StreamProxy.

---

## Native Interrupt Support

If a provider introduces true server-side reasoning interruption, the ProviderDecorator shall detect the capability and bypass replacement-request orchestration while preserving identical downstream semantics.

---

## Adaptive Policies

Future releases may implement configurable interruption policies based on:

* elapsed reasoning time
* reasoning token count
* estimated cost
* user preferences

Such policies shall remain optional and shall not alter the manual shortcut behavior specified by this RFC.

---

# Appendix O — Formal Invariants

The following invariants are normative.

## INV-001

Exactly one downstream `AssistantMessageEventStream` exists per logical assistant response.

---

## INV-002

Exactly one downstream `message_start` event is emitted.

---

## INV-003

Exactly one downstream `message_end` event is emitted.

---

## INV-004

At most one interruption transition may exist per logical assistant response.

---

## INV-005

Authority transfer is irreversible.

---

## INV-006

The primary stream shall never regain authority after replacement begins.

---

## INV-007

The wrapper shall never recursively delegate to itself.

---

## INV-008

The wrapper shall be observationally equivalent to the built-in provider when inactive.

---

## INV-009

ReasoningBuffer snapshots are immutable after capture.

---

## INV-010

Cleanup shall execute exactly once regardless of success, failure, timeout, or cancellation.

---

## INV-011

Every allocated transition resource shall have exactly one owning component and exactly one destruction point.

---

## INV-012

The implementation shall preserve Pi's logical conversation model of one user request producing one assistant response regardless of the number of provider requests executed internally.

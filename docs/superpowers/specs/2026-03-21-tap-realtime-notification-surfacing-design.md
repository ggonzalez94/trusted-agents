# Real-Time Notification Surfacing for TAP OpenClaw Plugin

**Date:** 2026-03-21
**Status:** Approved

## Problem

Currently, only escalation-type notifications (connection requests, ungrantable transfers) wake the OpenClaw agent via `triggerEscalation`. Summary notifications (inbound messages, auto-approved transfers, grant updates) and info notifications (connection confirmations) accumulate in the queue and are only surfaced at the start of the next agent turn via `before_prompt_build`. This means the operator doesn't see them until something else triggers a turn.

## Design

Extend `triggerEscalation` to fire for **all** classified events, not just the `"escalate"` bucket. This uses the existing proven infrastructure — `enqueueSystemEvent` + `requestHeartbeatNow` with 2s coalesce — and requires no new hooks, queues, or delivery mechanisms.

### Changes

#### 1. `registry.ts` — `handleEmitEvent`

Current: `triggerEscalation` only fires when `bucket === "escalate"` and `enqueued === true`.

Change: fire `triggerEscalation` for all buckets (`"auto-handle"`, `"escalate"`, `"notify"`) when `enqueued === true`.

The `contextKey` stays `"tap:escalation"` — the Gateway's context-change detection doesn't need to distinguish notification types, it just needs to know TAP has something to surface.

#### 2. `registry.ts` — `approveTransfer` hook (grant-covered path)

Current: when a transfer is covered by a grant, pushes a `"summary"` notification but does NOT call `triggerEscalation`.

Change: call `triggerEscalation` after pushing the summary notification, same as the ungrantable path.

#### 3. SKILL.md — Auto-reply behavior for messages

Add guidance: when woken for a `message/send` summary, read the conversation, attempt to respond using `tap_gateway send_message`. If the agent can't determine an appropriate response (ambiguous, requires human judgment), escalate to the operator.

### What does NOT change

- `notification-queue.ts` — types, eviction, dedup unchanged
- `event-classifier.ts` — classification buckets unchanged
- `plugin.ts` — `before_prompt_build` drain unchanged
- `TapMessagingService` in core — no runtime behavior changes
- Coalesce window — stays at 2s for all types

### Risks

- **Noise**: a chatty peer sending many messages triggers multiple agent wakes. Mitigated by 2s coalesce (burst of messages → one wake with batched notifications).
- **Cost**: more agent turns = more LLM calls. Acceptable trade-off for real-time awareness.

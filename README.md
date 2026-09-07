# pi-context-steering

**Tell your agent its context is running out — before auto-compaction fires.**

A [Pi](https://pi.dev) extension that steers the main session with injected user messages: escalating warnings as context usage crosses 70/80/90%, and a post-compaction notification that tells the agent what just happened and where to pick up.

Mirrors the `SteeringController` policy from [pi-subagent](https://github.com/BenjaminBilbro/pi-subagent), adapted for the main assistant.

## Motivation

I run my LLMs locally through llama.cpp, and context is the scarcest resource I have. Auto-compaction is the last-resort valve — but by the time it fires, the agent is mid-task and has no idea why the conversation just got shorter.

The problem: the agent cannot see its own context percentage. The footer shows it to *me*, but the model never reads the footer. So it plows ahead starting new work at 85% of the window, and then compaction yanks the rug out from under it.

pi-context-steering closes that gap by injecting plain user messages the agent can actually read: escalating "wrap it up" warnings as usage crosses thresholds, and a post-compaction note pointing at the summary and saying "continue from where you left off."

## Why pi-context-steering

**The agent can see the warning** — Steers are delivered as user messages in the transcript, so the model reads them, and you can see exactly what it was told.

**Escalating pressure** — 70% says finish the current step, 80% says stop starting new work, 90% says stop everything and summarize. Each threshold fires once per compaction cycle and re-arms after compaction.

**Compaction is no longer a mystery** — Right after `session_compact`, the agent is told the reason, how much was summarized, and an estimate of where the next round starts; a follow-up reports the actual LLM-reported usage once it's available.

**KV-cache friendly** — The extension only appends user messages. It never modifies the system prompt or rewrites history, so llama.cpp's prefix cache stays intact.

**Independent toggles** — Threshold warnings and the post-compaction notification are configured separately via env vars.

## Install

### Option 1: pi install

```bash
pi install git:github.com/clanker-wanker/pi-context-steering
```

### Option 2: Manual Installation

Clone this repository to your Pi extensions directory:

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/clanker-wanker/pi-context-steering.git
cd pi-context-steering
```

## Usage

### Threshold Warnings

On every assistant `message_end`, the extension reads `ctx.getContextUsage()`. When usage crosses a threshold that hasn't fired yet, it sends a steering user message — at most one per event, at the highest crossed threshold:

- While streaming, delivery uses `pi.sendUserMessage(text, { deliverAs: "steer" })`, queued until the current turn's tool calls finish and delivered before the next LLM call; when idle, it's a plain send.
- Each threshold fires once per compaction cycle; thresholds re-arm on `session_compact`.
- When auto-compaction is on, the top threshold is anchored 4 points below the compaction point (`contextWindow - reserveTokens`), so the final warning always lands pre-compaction; configured thresholds at or above the anchored top are dropped as unreachable.
- The warning appears in the transcript as a user message, so you see exactly what the agent is being told.

The wording depends on whether pi's auto-compaction is enabled (read from your settings, default on):

- **Auto-compaction on (default):** a short status line, since pi will compact before the hard limit — e.g. `Context is at ~80% of the limit (104000 / 131072 tokens).`
- **Auto-compaction off:** escalating urgency, since the agent must wrap up before the window runs out:

| Threshold | Instruction |
|-----------|-------------|
| 70% | Prioritize finishing the current step; avoid starting new work. |
| 80% | Stop starting new work; wrap up the current task and summarize progress. |
| 90% | Stop all work immediately and output a final summary of what was done and what remains. |

Messages include absolute figures, e.g. `Context is at ~80% of the limit (104000 / 131072 tokens). …`

### Post-Compaction Notification

On `session_compact`, the extension sends a two-stage steering message:

- **Stage 1 (immediate):** "Your context was just compacted (reason: …). ~N tokens of earlier conversation were summarized; … The next round will start at approximately M tokens (~P% of the limit). Continue from where you left off." The estimate is pi's own `estimateTokens` (chars/4 over the content of the actual kept messages + system prompt; message metadata and `toolResult.details` payloads are excluded; a lower bound, tool schemas are not counted). If the estimate is unavailable, it falls back to a message with just the summarized-token count, or with no numbers at all.
- **Stage 2 (follow-up):** on the first assistant `message_end` after compaction with a non-null token count, sends the actual LLM-reported usage, e.g. `Context is now 26000 tokens (~20% of the 131072 limit).`

Delivery matches the threshold feature: plain send when idle (manual `/compact`), `deliverAs: "steer"` while streaming (auto/overflow, delivered before the next LLM call).

### Config

| Env var | Default | Meaning |
|---------|---------|---------|
| `PI_CONTEXT_STEER` | `70,80,90` | Comma-separated percentages. `off` (or empty/`0`) disables **only** the threshold feature. |
| `PI_CONTEXT_STEER_POST_COMPACT` | `on` | `off` (or empty/`0`) disables **only** the post-compaction notification. |

## Features

- **Threshold steering** — escalating user-message warnings at 70/80/90% (configurable), at most one per event, once per compaction cycle
- **Post-compaction notification** — two-stage: immediate chars/4 estimate, then actual LLM-reported usage
- **Steer delivery** — `deliverAs: "steer"` while streaming, plain send when idle
- **KV-cache friendly** — user messages only; no system prompt or history modification
- **Independent toggles** — each feature can be disabled separately via env vars
- **Tested** — `test/steering.test.ts` covers threshold firing, re-arming, delivery modes, both post-compact stages, and the fallback variants

## Notes

- Built-in auto-compaction fires at `contextWindow - reserveTokens` (default reserve 16384), i.e. ~87.5% of a 131k window. With auto-compaction on, the top threshold is anchored 4 points below that point so the final warning lands pre-compaction (e.g. ~83.5% on a 131k window, ~75% on a 77k window).
- Right after compaction, `getContextUsage()` reports `null` until the next assistant response; the extension simply skips those events and re-arms on `session_compact`. Stage 2 of the post-compaction notification waits for the first non-null reading; if none comes (session ends), it is simply not sent.

## License

MIT

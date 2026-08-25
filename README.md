# pi-context-steering

Steers the main pi session in two ways:

1. **Threshold warnings** — when the session's context usage (as shown in the
   interactive footer) reaches 70%, 80%, or 90%, the extension injects a user
   message telling the agent to start wrapping up — so the agent, which cannot
   see its own context percentage, learns the limit is approaching before
   auto-compaction fires.
2. **Post-compaction notification** — right after compaction, tells the agent
   its context was just compacted, points it to the summary now in its
   context, and instructs it to continue from where it left off.

Mirrors the `SteeringController` policy from [pi-subagent](https://github.com/BenjaminBilbro/pi-subagent),
adapted for the main assistant.

## How it works

- On every assistant `message_end`, reads `ctx.getContextUsage()`.
- When usage crosses a threshold that hasn't fired yet, sends
  `pi.sendUserMessage(text, { deliverAs: "steer" })` — queued until the
  current turn's tool calls finish, delivered before the next LLM call.
- Each threshold fires once per compaction cycle; thresholds re-arm on
  `session_compact`.
- The warning appears in the transcript as a user message, so you see exactly
  what the agent is being told.

Escalating wording:

| Threshold | Instruction |
|-----------|-------------|
| 70% | Prioritize finishing the current step; avoid starting new work. |
| 80% | Stop starting new work; wrap up the current task and summarize progress. |
| 90% | Stop all work immediately; output a final summary of what was done and what remains. |

Messages include absolute figures, e.g. `Context is at ~80% of the limit (104000 / 131072 tokens). …`

### Post-compaction notification

On `session_compact`, the extension sends a two-stage steering message:

- **Stage 1 (immediate):** "Your context was just compacted (reason: …). ~N
  tokens of earlier conversation were summarized; … The next round will start
  at approximately M tokens (~P% of the limit). Continue from where you left
  off." The estimate is chars/4 over the actual kept messages + system prompt
  (a lower bound — tool schemas are not counted).
- **Stage 2 (follow-up):** on the first assistant `message_end` after
  compaction with a non-null token count, sends the actual LLM-reported usage,
  e.g. `Context is now 26000 tokens (~20% of the 131072 limit).`

Delivery matches the threshold feature: plain send when idle (manual
`/compact`), `deliverAs: "steer"` while streaming (auto/overflow, delivered
before the next LLM call).

## Config

| Env var | Default | Meaning |
|---------|---------|---------|
| `PI_CONTEXT_STEER` | `70,80,90` | Comma-separated percentages. `off` (or empty) disables **only** the threshold feature. |
| `PI_CONTEXT_STEER_POST_COMPACT` | `on` | `off` (or empty/`0`) disables **only** the post-compaction notification. |

The two features are independent; set both to `off` to disable everything.

```bash
PI_CONTEXT_STEER=60,75,90 pi
PI_CONTEXT_STEER=off PI_CONTEXT_STEER_POST_COMPACT=on pi   # only post-compact
PI_CONTEXT_STEER=70,80,90 PI_CONTEXT_STEER_POST_COMPACT=off pi   # only thresholds
```

## Install

```bash
pi install /path/to/pi-context-steering   # user-level
pi install -l /path/to/pi-context-steering  # project-level
```

Try without installing:

```bash
pi -e /path/to/pi-context-steering
```

## Notes

- Built-in auto-compaction fires at `contextWindow - reserveTokens`
  (default reserve 16384), i.e. ~87.5% of a 131k window — after the 80%
  warning, before the 90% warning.
- Right after compaction, `getContextUsage()` reports `null` until the next
  assistant response; the extension simply skips those events and re-arms on
  `session_compact`. Stage 2 of the post-compaction notification waits for the
  first non-null reading; if none comes (session ends), it is simply not sent.

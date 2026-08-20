# pi-context-steering

Steers the main pi session when context usage crosses a threshold. When the
session's context usage (as shown in the interactive footer) reaches 70%, 80%,
or 90%, the extension injects a user message telling the agent to start
wrapping up — so the agent, which cannot see its own context percentage,
learns the limit is approaching before auto-compaction fires.

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

## Config

| Env var | Default | Meaning |
|---------|---------|---------|
| `PI_CONTEXT_STEER` | `70,80,90` | Comma-separated percentages. `off` (or empty) disables. |

```bash
PI_CONTEXT_STEER=60,75,90 pi
PI_CONTEXT_STEER=off pi
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
  `session_compact`.

/**
 * pi-context-steering
 *
 * Watches the main session's context usage and injects a steering user
 * message when usage crosses a threshold (default 70/80/90%). Mirrors the
 * pi-subagent SteeringController policy, adapted for the main agent:
 *
 * - Observes `message_end` on assistant messages via ctx.getContextUsage().
 * - Fires at most one steer per event, at the highest crossed threshold.
 * - Each threshold fires once per compaction cycle; re-arms on
 *   `session_compact`.
 * - Delivery: `pi.sendUserMessage(text, { deliverAs: "steer" })` while
 *   streaming (queued until the current turn's tool calls finish, before
 *   the next LLM call); plain send when idle.
 *
 * Config: PI_CONTEXT_STEER=70,80,90 (comma-separated percentages).
 *         PI_CONTEXT_STEER=off (or empty) disables the extension.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLDS = [70, 80, 90];

function parseThresholds(): number[] {
	const raw = process.env.PI_CONTEXT_STEER;
	if (raw === undefined) return DEFAULT_THRESHOLDS;
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === "" || trimmed === "off" || trimmed === "0") return [];
	const values = trimmed
		.split(",")
		.map((s) => Number(s.trim()))
		.filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
	return [...new Set(values)].sort((a, b) => a - b);
}

function getSteeringText(threshold: number, pct: number, tokens: number | null, contextWindow: number): string {
	const abs = tokens != null ? ` (${tokens} / ${contextWindow} tokens)` : "";
	if (threshold >= 90) {
		return (
			`Context is at ~${pct}% of the limit${abs} — nearly exhausted. ` +
			"Stop all work immediately and output a final summary of what was done and what remains."
		);
	}
	if (threshold >= 80) {
		return `Context is at ~${pct}% of the limit${abs}. Stop starting new work; wrap up the current task and summarize progress.`;
	}
	return `Context is at ~${pct}% of the limit${abs}. Prioritize finishing the current step; avoid starting new work.`;
}

export default function (pi: ExtensionAPI) {
	const thresholds = parseThresholds();
	if (thresholds.length === 0) return;

	const fired = new Set<number>();

	function send(text: string, ctx: ExtensionContext) {
		if (ctx.isIdle()) {
			pi.sendUserMessage(text);
		} else {
			pi.sendUserMessage(text, { deliverAs: "steer" });
		}
	}

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.percent == null) return;

		const crossed = thresholds.filter((t) => usage.percent! >= t && !fired.has(t));
		if (crossed.length === 0) return;

		const threshold = Math.max(...crossed);
		crossed.forEach((c) => fired.add(c));
		send(getSteeringText(threshold, Math.round(usage.percent), usage.tokens, usage.contextWindow), ctx);
	});

	pi.on("session_compact", () => {
		fired.clear();
	});
}

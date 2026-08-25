/**
 * pi-context-steering
 *
 * Two independent features:
 *
 * 1. Threshold steering — watches the main session's context usage and
 *    injects a steering user message when usage crosses a threshold
 *    (default 70/80/90%). Mirrors the pi-subagent SteeringController
 *    policy, adapted for the main agent:
 *
 *    - Observes `message_end` on assistant messages via ctx.getContextUsage().
 *    - Fires at most one steer per event, at the highest crossed threshold.
 *    - Each threshold fires once per compaction cycle; re-arms on
 *      `session_compact`.
 *
 * 2. Post-compaction notification — after `session_compact`, sends a
 *    two-stage steering user message:
 *
 *    - Stage 1 (immediate, at `session_compact`): forewarning with an
 *      *estimated* next-round context (inline chars/4 over the real kept
 *      messages + system prompt) and `tokensBefore` as a reference.
 *    - Stage 2 (follow-up, on the first `message_end` after compaction
 *      where `getContextUsage().tokens` is non-null): the actual
 *      LLM-reported usage.
 *
 * Delivery (both features): `pi.sendUserMessage(text, { deliverAs: "steer" })`
 * while streaming (queued until the current turn's tool calls finish, before
 * the next LLM call); plain send when idle.
 *
 * Config: PI_CONTEXT_STEER=70,80,90 (comma-separated percentages).
 *         PI_CONTEXT_STEER=off (or empty) disables only the threshold feature.
 *         PI_CONTEXT_STEER_POST_COMPACT=on|off (default on) controls the
 *         post-compaction notification independently.
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

function parsePostCompact(): boolean {
	const raw = process.env.PI_CONTEXT_STEER_POST_COMPACT;
	if (raw === undefined) return true; // default on
	const t = raw.trim().toLowerCase();
	return t !== "" && t !== "off" && t !== "0";
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

function estimatePostCompactTokens(ctx: ExtensionContext): {
	estimatedInput: number;
	percent: number | null;
	contextWindow: number | null;
} | null {
	// Inline chars/4 — NO import of estimateTokens (pi package not resolvable in tests).
	// buildSessionContext().messages is the EXACT post-compaction list
	// [compactionSummary, ...keptMessages], rebuilt before session_compact emits.
	let messages: unknown[];
	try {
		messages = ctx.sessionManager.buildSessionContext().messages;
	} catch {
		return null; // estimate unavailable → Variant B fallback
	}
	const messagesTokens = messages.reduce(
		(s, m) => s + Math.ceil(JSON.stringify(m).length / 4),
		0
	);
	const systemPromptTokens = Math.ceil(ctx.getSystemPrompt().length / 4);
	const estimatedInput = messagesTokens + systemPromptTokens;
	const contextWindow = ctx.getContextUsage()?.contextWindow ?? null;
	const percent = contextWindow ? Math.round((estimatedInput / contextWindow) * 100) : null;
	return { estimatedInput, percent, contextWindow };
}

function getPostCompactText(
	reason: "manual" | "threshold" | "overflow",
	tokensBefore: number | null,
	estimate: { estimatedInput: number; percent: number | null; contextWindow: number | null } | null
): string {
	const hasTokens = tokensBefore != null && Number.isFinite(tokensBefore) && tokensBefore > 0;
	const summarized = hasTokens
		? `~${tokensBefore} tokens of earlier conversation were summarized; the most recent messages were kept. `
		: "The earlier conversation was summarized; the most recent messages were kept. ";

	if (estimate) {
		// Variant C (recommended): reason + tokensBefore + estimated usage
		const pct =
			estimate.percent != null && estimate.contextWindow != null
				? ` (~${estimate.percent}% of the ${estimate.contextWindow} limit)`
				: "";
		return (
			`Your context was just compacted (reason: ${reason}). ${summarized}` +
			`The next round will start at approximately ${estimate.estimatedInput} tokens${pct}. ` +
			"Continue from where you left off."
		);
	}
	if (hasTokens) {
		// Variant B (fallback): reason + tokensBefore, no new number
		return (
			`Your context was just compacted (reason: ${reason}). ~${tokensBefore} tokens of earlier ` +
			"conversation were summarized to free up space; the earlier conversation is now a summary in your context, " +
			"and your context is well below the limit again. Continue from where you left off."
		);
	}
	// Variant A (fallback): no numbers
	return (
		"Your context was just compacted. The earlier conversation has been summarized to free up space " +
		"and is now a summary in your context; your context is well below the limit again. " +
		"Continue from where you left off."
	);
}

export default function (pi: ExtensionAPI) {
	const thresholds = parseThresholds();
	const postCompact = parsePostCompact();
	if (thresholds.length === 0 && !postCompact) return; // both off → no handlers

	const fired = new Set<number>();
	let pendingPostCompactReport = false; // stage-2 follow-up pending

	function send(text: string, ctx: ExtensionContext) {
		if (ctx.isIdle()) {
			pi.sendUserMessage(text);
		} else {
			pi.sendUserMessage(text, { deliverAs: "steer" });
		}
	}

	pi.on("message_end", (event, ctx) => {
		// Stage 2: post-compaction actual-usage follow-up (independent of thresholds)
		if (postCompact && pendingPostCompactReport) {
			const usage = ctx.getContextUsage();
			if (usage?.tokens != null) {
				const pct = usage.contextWindow
					? ` (~${Math.round((usage.tokens / usage.contextWindow) * 100)}% of the ${usage.contextWindow} limit)`
					: "";
				send(`Context is now ${usage.tokens} tokens${pct}.`, ctx); // Variant D
				pendingPostCompactReport = false;
			}
			// tokens still null → keep the flag; retry on the next message_end
		}
		if (thresholds.length === 0) return; // guard: threshold path no-op when off
		if (event.message.role !== "assistant") return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.percent == null) return;

		const crossed = thresholds.filter((t) => usage.percent! >= t && !fired.has(t));
		if (crossed.length === 0) return;

		const threshold = Math.max(...crossed);
		crossed.forEach((c) => fired.add(c));
		send(getSteeringText(threshold, Math.round(usage.percent), usage.tokens, usage.contextWindow), ctx);
	});

	pi.on("session_compact", (event, ctx) => {
		fired.clear(); // re-arm thresholds
		if (postCompact) {
			const estimate = estimatePostCompactTokens(ctx); // null → Variant B fallback
			send(
				getPostCompactText(
					event.reason,
					event.compactionEntry?.tokensBefore ?? null,
					estimate
				),
				ctx
			);
			pendingPostCompactReport = true; // arm stage-2 follow-up
		}
	});
}

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
 *    - When auto-compaction is on, the top threshold is anchored a few
 *      points below the compaction point (contextWindow - reserveTokens),
 *      so the final warning lands pre-compaction.
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

import { statSync } from "node:fs";
import { join } from "node:path";
import {
	buildSessionContext,
	estimateTokens,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLDS = [70, 80, 90];

function parseThresholds(): number[] {
	const raw = process.env.PI_CONTEXT_STEER;
	if (raw === undefined) return DEFAULT_THRESHOLDS;
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === "" || trimmed === "off" || trimmed === "0") return [];
	const dropped: string[] = [];
	const values: number[] = [];
	for (const token of trimmed.split(",")) {
		const t = token.trim();
		if (t === "") continue; // tolerate empty segments (e.g. trailing comma)
		const n = Number(t);
		if (Number.isFinite(n) && n > 0 && n <= 100) values.push(n);
		else dropped.push(t);
	}
	if (dropped.length > 0) {
		console.error(`pi-context-steering: ignoring invalid PI_CONTEXT_STEER tokens: ${dropped.join(", ")}`);
	}
	return [...new Set(values)].sort((a, b) => a - b);
}

function isPostCompactEnabled(): boolean {
	const raw = process.env.PI_CONTEXT_STEER_POST_COMPACT;
	if (raw === undefined) return true; // default on
	const t = raw.trim().toLowerCase();
	return t !== "" && t !== "off" && t !== "0";
}

/** Max mtime of the global + project settings files (0 if neither exists). */
function settingsMtime(cwd: string): number {
	const paths = [join(getAgentDir(), "settings.json"), join(cwd, ".pi", "settings.json")];
	let mtime = 0;
	for (const p of paths) {
		try {
			mtime = Math.max(mtime, statSync(p).mtimeMs);
		} catch {
			/* missing file */
		}
	}
	return mtime;
}

/**
 * Read a settings value, caching it per-cwd and refreshing only when a
 * settings file actually changes (mtime bump). Falls back to `fallback`
 * when the read throws.
 */
function cachedSetting<T>(
	cache: Map<string, { mtime: number; value: T }>,
	cwd: string,
	fallback: T,
	read: () => T
): T {
	const mtime = settingsMtime(cwd);
	const cached = cache.get(cwd);
	if (cached && cached.mtime === mtime) return cached.value;
	let value = fallback;
	try {
		value = read();
	} catch {
		/* keep fallback */
	}
	cache.set(cwd, { mtime, value });
	return value;
}

const autoCompactCache = new Map<string, { mtime: number; value: boolean }>();

/** Auto-compaction flag, refreshed only when a settings file actually changes. */
function isAutoCompactionEnabled(cwd: string): boolean {
	return cachedSetting(autoCompactCache, cwd, true, () => SettingsManager.create(cwd).getCompactionEnabled());
}

const reserveCache = new Map<string, { mtime: number; value: number }>();

/** Compaction reserve (tokens), refreshed only when a settings file changes. */
function getCompactionReserveTokens(cwd: string): number {
	return cachedSetting(reserveCache, cwd, 16384, () => SettingsManager.create(cwd).getCompactionReserveTokens());
}

/** Percentage points the top threshold is anchored below the compaction point. */
const ANCHOR_MARGIN = 4;

/**
 * Effective thresholds: when auto-compaction is on, the top threshold is
 * anchored to a few points below the compaction point (contextWindow -
 * reserveTokens), so the final warning always lands pre-compaction. Any
 * configured threshold at or above the anchored top is dropped (unreachable
 * before compaction). When auto-compaction is off, thresholds are unchanged.
 */
function effectiveThresholds(thresholds: number[], contextWindow: number, cwd: string): number[] {
	if (!isAutoCompactionEnabled(cwd) || !Number.isFinite(contextWindow) || contextWindow <= 0) return thresholds;
	const reserve = getCompactionReserveTokens(cwd);
	const compactionPct = ((contextWindow - reserve) / contextWindow) * 100;
	const sorted = [...thresholds].sort((a, b) => a - b);
	const top = sorted[sorted.length - 1];
	const anchoredTop = Math.min(top, compactionPct - ANCHOR_MARGIN);
	const rest = sorted.slice(0, -1).filter((t) => t < anchoredTop);
	return [...rest, anchoredTop].sort((a, b) => a - b);
}

function getSteeringText(threshold: number, pct: number, tokens: number | null, contextWindow: number, cwd: string): string {
	const abs = tokens != null ? ` (${tokens} / ${contextWindow} tokens)` : "";
	if (isAutoCompactionEnabled(cwd)) {
		return `Context is at ~${pct}% of the limit${abs}.`;
	}
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

type PostCompactEstimate = {
	estimatedInput: number;
	percent: number | null;
	contextWindow: number | null;
};

function estimatePostCompactUsage(ctx: ExtensionContext): PostCompactEstimate | null {
	// buildSessionContext().messages is the EXACT post-compaction list
	// [compactionSummary, ...keptMessages], rebuilt before session_compact emits.
	let messages: SessionContext["messages"];
	try {
		messages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
	} catch {
		return null; // estimate unavailable → fallback without a new number
	}
	const messagesTokens = messages.reduce((s, m) => s + estimateTokens(m), 0);
	const systemPromptTokens = Math.ceil(ctx.getSystemPrompt().length / 4);
	const estimatedInput = messagesTokens + systemPromptTokens;
	const contextWindow = ctx.getContextUsage()?.contextWindow ?? null;
	const percent = contextWindow ? Math.round((estimatedInput / contextWindow) * 100) : null;
	return { estimatedInput, percent, contextWindow };
}

function getPostCompactText(
	reason: "manual" | "threshold" | "overflow",
	tokensBefore: number | null,
	estimate: PostCompactEstimate | null
): string {
	const hasTokens = tokensBefore != null && Number.isFinite(tokensBefore) && tokensBefore > 0;
	const summarized = hasTokens
		? `~${tokensBefore} tokens of earlier conversation were summarized; the most recent messages were kept. `
		: "The earlier conversation was summarized; the most recent messages were kept. ";

	if (estimate) {
		// Full estimate: reason + tokensBefore + estimated usage
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
		// Fallback: reason + tokensBefore, no new number
		return (
			`Your context was just compacted (reason: ${reason}). ~${tokensBefore} tokens of earlier ` +
			"conversation were summarized to free up space; the earlier conversation is now a summary in your context, " +
			"and your context is well below the limit again. Continue from where you left off."
		);
	}
	// Fallback: no numbers
	return (
		"Your context was just compacted. The earlier conversation has been summarized to free up space " +
		"and is now a summary in your context; your context is well below the limit again. " +
		"Continue from where you left off."
	);
}

export default function (pi: ExtensionAPI) {
	const thresholds = parseThresholds();
	const postCompact = isPostCompactEnabled();
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
				send(`Context is now ${usage.tokens} tokens${pct}.`, ctx); // stage-2 follow-up
				pendingPostCompactReport = false;
			}
			// tokens still null → keep the flag; retry on the next message_end
		}
		if (thresholds.length === 0) return; // guard: threshold path no-op when off
		if (event.message.role !== "assistant") return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.percent == null) return;

		const effThresholds = effectiveThresholds(thresholds, usage.contextWindow, ctx.cwd);
		const crossed = effThresholds.filter((t) => usage.percent! >= t && !fired.has(t));
		if (crossed.length === 0) return;

		const threshold = Math.max(...crossed);
		crossed.forEach((c) => fired.add(c));
		send(getSteeringText(threshold, Math.round(usage.percent), usage.tokens, usage.contextWindow, ctx.cwd), ctx);
	});

	pi.on("session_compact", (event, ctx) => {
		fired.clear(); // re-arm thresholds
		if (postCompact) {
			const estimate = estimatePostCompactUsage(ctx); // null → fallback without a new number
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

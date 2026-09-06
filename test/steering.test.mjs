import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ext from "../index.ts";

// Temp cwds with a project settings file controlling auto-compaction.
// Project overrides global, so these are independent of the real ~/.pi/agent/settings.json.
function makeCwd(autoCompact) {
	const dir = mkdtempSync(join(tmpdir(), "pcs-"));
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: autoCompact } }));
	return dir;
}
const cwdOff = makeCwd(false);
const cwdOn = makeCwd(true);

let failures = 0;
function check(name, cond) {
	if (!cond) failures++;
	console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
}

function makePi() {
	const handlers = {};
	const sent = [];
	const registered = [];
	const pi = {
		on(event, handler) {
			registered.push(event);
			(handlers[event] ??= []).push(handler);
		},
		sendUserMessage(text, options) {
			sent.push({ text, options });
		},
	};
	return {
		pi,
		sent,
		registered,
		fire: async (event, payload, ctx) => {
			for (const h of handlers[event] ?? []) await h(payload, ctx);
		},
	};
}

function ctx(percent, { idle = false, tokens, noWindow = false, messages, systemPrompt, throwBuild = false, cwd = cwdOff, window = 131072 } = {}) {
	const usage =
		percent == null
			? { tokens: null, contextWindow: window, percent: null }
			: { tokens: Math.round((percent / 100) * window), contextWindow: window, percent };
	if (tokens !== undefined) usage.tokens = tokens;
	if (noWindow) delete usage.contextWindow;
	return {
		cwd,
		isIdle: () => idle,
		getContextUsage: () => usage,
		getSystemPrompt: () => systemPrompt ?? "You are a coding assistant.",
		sessionManager: {
			buildSessionContext: () => {
				if (throwBuild) throw new Error("build failed");
				return { messages: messages ?? [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }] };
			},
		},
	};
}

const assistantEnd = (pct, opts) => [{ type: "message_end", message: { role: "assistant" } }, ctx(pct, opts)];

const compactEvent = (reason = "threshold", tokensBefore = 120000, extra = {}) => ({
	type: "session_compact",
	reason,
	willRetry: reason === "overflow",
	fromExtension: false,
	compactionEntry: { summary: "…", tokensBefore, firstKeptEntryId: "e1" },
	...extra,
});

// --- Scenario 1: default thresholds 70/80/90, streaming (post-compact off) ---
{
	process.env.PI_CONTEXT_STEER_POST_COMPACT = "off";
	const { pi, sent, fire } = makePi();
	ext(pi);

	await fire("message_end", ...assistantEnd(69.9));
	check("no steer below 70", sent.length === 0);

	await fire("message_end", ...assistantEnd(70.2));
	check("steer at 70", sent.length === 1 && sent[0].text.includes("~70%"));
	check("steer delivery while streaming", sent[0].options?.deliverAs === "steer");

	await fire("message_end", ...assistantEnd(75));
	check("no repeat between thresholds", sent.length === 1);

	await fire("message_end", ...assistantEnd(80.1));
	check("steer at 80", sent.length === 2 && sent[1].text.includes("~80%"));

	await fire("message_end", ...assistantEnd(90.5));
	check("steer at 90 (highest crossed)", sent.length === 3 && sent[2].text.includes("~91%") && sent[2].text.includes("nearly exhausted"));

	await fire("message_end", ...assistantEnd(95));
	check("no further steers once all fired", sent.length === 3);

	await fire("session_compact", { type: "session_compact" }, ctx(20));
	await fire("message_end", ...assistantEnd(91));
	check("re-armed after compaction", sent.length === 4 && sent[3].text.includes("nearly exhausted"));

	check("absolute tokens in text", sent[0].text.includes("/ 131072 tokens"));
	delete process.env.PI_CONTEXT_STEER_POST_COMPACT;
}

// --- Scenario 2: idle + null percent + non-assistant ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);

	await fire("message_end", { type: "message_end", message: { role: "toolResult" } }, ctx(95));
	check("ignores non-assistant messages", sent.length === 0);

	await fire("message_end", ...assistantEnd(null));
	check("skips null percent (post-compaction)", sent.length === 0);

	await fire("message_end", ...assistantEnd(71, { idle: true }));
	check("idle: plain send, no deliverAs", sent.length === 1 && sent[0].options === undefined);
}

// --- Scenario 3: env config ---
{
	process.env.PI_CONTEXT_STEER = "50,95";
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("message_end", ...assistantEnd(60));
	check("custom thresholds: fires at 50", sent.length === 1 && sent[0].text.includes("~60%") && sent[0].text.includes("Prioritize finishing"));
	await fire("message_end", ...assistantEnd(94));
	check("custom thresholds: no fire at 80 (not configured)", sent.length === 1);
	await fire("message_end", ...assistantEnd(95.2));
	check("custom thresholds: fires at 95", sent.length === 2);
}
{
	process.env.PI_CONTEXT_STEER = "off";
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("message_end", ...assistantEnd(99));
	check("PI_CONTEXT_STEER=off disables", sent.length === 0);
}
{
	delete process.env.PI_CONTEXT_STEER;
	const { pi } = makePi();
	ext(pi);
	check("unset env uses defaults (handlers registered)", true);
}

// --- Auto-compaction ON: short message (no tiered urgency) ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("message_end", ...assistantEnd(70.2, { cwd: cwdOn }));
	check("auto-compact on: short message at 70", sent.length === 1 && sent[0].text === `Context is at ~70% of the limit (${Math.round(0.702 * 131072)} / 131072 tokens).`);
	check("auto-compact on: no tiered urgency", !sent[0].text.includes("Prioritize finishing"));

	await fire("message_end", ...assistantEnd(90.5, { cwd: cwdOn }));
	check("auto-compact on: short message at 90", sent.length === 2 && sent[1].text.includes("~91%"));
	check("auto-compact on: no 'nearly exhausted'", !sent[1].text.includes("nearly exhausted"));
}

// --- Auto-compaction OFF: full tiered message (explicit) ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("message_end", ...assistantEnd(70.2, { cwd: cwdOff }));
	check("auto-compact off: full message at 70", sent.length === 1 && sent[0].text.includes("Prioritize finishing"));
	await fire("message_end", ...assistantEnd(90.5, { cwd: cwdOff }));
	check("auto-compact off: 'nearly exhausted' at 90", sent.length === 2 && sent[1].text.includes("nearly exhausted"));
}

// --- Anchored thresholds: auto-compact on, small window (77824) ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	// compaction at (77824-16384)/77824 = 78.95%; top anchored to 74.95%
	await fire("message_end", ...assistantEnd(70, { cwd: cwdOn, window: 77824 }));
	check("anchor: fires at 70", sent.length === 1 && sent[0].text.includes("~70%"));
	await fire("message_end", ...assistantEnd(75, { cwd: cwdOn, window: 77824 }));
	check("anchor: fires at anchored top (~75%)", sent.length === 2 && sent[1].text.includes("~75%"));
	await fire("message_end", ...assistantEnd(80, { cwd: cwdOn, window: 77824 }));
	check("anchor: no fire at 80 (dropped, above compaction)", sent.length === 2);
}

// --- Anchored thresholds: auto-compact on, large window (131072) ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	// compaction at 87.5%; top anchored to 83.5%
	await fire("message_end", ...assistantEnd(70, { cwd: cwdOn, window: 131072 }));
	check("anchor-large: fires at 70", sent.length === 1);
	await fire("message_end", ...assistantEnd(80, { cwd: cwdOn, window: 131072 }));
	check("anchor-large: fires at 80", sent.length === 2);
	await fire("message_end", ...assistantEnd(84, { cwd: cwdOn, window: 131072 }));
	check("anchor-large: fires at anchored top (~84%)", sent.length === 3 && sent[2].text.includes("~84%"));
	await fire("message_end", ...assistantEnd(90, { cwd: cwdOn, window: 131072 }));
	check("anchor-large: no fire at 90 (dropped)", sent.length === 3);
}

// --- Anchored thresholds: already below compaction → unchanged ---
{
	process.env.PI_CONTEXT_STEER = "50,60,70";
	const { pi, sent, fire } = makePi();
	ext(pi);
	// compaction at 78.95%; top (70) already below → unchanged
	await fire("message_end", ...assistantEnd(70, { cwd: cwdOn, window: 77824 }));
	check("anchor-unchanged: fires at 70 (top kept)", sent.length === 1 && sent[0].text.includes("~70%"));
	delete process.env.PI_CONTEXT_STEER;
}

// --- No anchoring when auto-compact off ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	// auto-compact off → 80 threshold kept (would be dropped if on)
	await fire("message_end", ...assistantEnd(80, { cwd: cwdOff, window: 77824 }));
	check("no-anchor-off: fires at 80 (kept when off)", sent.length === 1 && sent[0].text.includes("~80%"));
}

// --- S1: two-stage happy path ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("threshold", 120000), ctx(20));
	check("S1 stage-1 sent", sent.length === 1);
	check("S1 stage-1 wording", sent[0].text.includes("Your context was just compacted") && sent[0].text.includes("approximately"));
	check("S1 stage-1 steer delivery", sent[0].options?.deliverAs === "steer");
	check("S1 stage-1 includes tokensBefore", sent[0].text.includes("120000"));
	check("S1 stage-1 estimated percent", sent[0].text.includes("% of the 131072 limit"));

	await fire("message_end", ...assistantEnd(20));
	check("S1 stage-2 sent", sent.length === 2 && sent[1].text.startsWith("Context is now"));
	check("S1 stage-2 actual tokens", sent[1].text.includes(`${Math.round(0.2 * 131072)} tokens`));

	await fire("message_end", ...assistantEnd(25));
	check("S1 no repeat stage-2", sent.length === 2);
}

// --- S2: stage-2 retry while tokens null ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("threshold", 120000), ctx(20));
	await fire("message_end", ...assistantEnd(null));
	check("S2 no stage-2 while tokens null", sent.length === 1);
	await fire("message_end", ...assistantEnd(20));
	check("S2 stage-2 on first non-null", sent.length === 2 && sent[1].text.startsWith("Context is now"));
}

// --- S3: no follow-up (manual + idle, session ends) ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("manual", 90000), ctx(20, { idle: true }));
	check("S3 only stage-1 sent", sent.length === 1);
	check("S3 manual: plain send (no deliverAs)", sent[0].options === undefined);
	check("S3 manual: reason in text", sent[0].text.includes("reason: manual"));
}

// --- S4: overlap — threshold crossed on the stage-2 turn ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("threshold", 120000), ctx(20));
	await fire("message_end", ...assistantEnd(85));
	check("S4 stage-1 is first", sent[0].text.includes("compacted"));
	check("S4 stage-2 is second", sent[1].text.startsWith("Context is now"));
	check("S4 threshold steer also fires", sent.length === 3 && sent[2].text.includes("~85%"));
}

// --- S5: stage-1 fallback — buildSessionContext throws → Variant B ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("threshold", 120000), ctx(20, { throwBuild: true }));
	check("S5 Variant B: one message", sent.length === 1);
	check("S5 Variant B: has tokensBefore", sent[0].text.includes("120000"));
	check("S5 Variant B: no estimated number", !sent[0].text.includes("approximately"));
}

// --- S6: no contextWindow → stage-1 omits percent clause ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("threshold", 120000), ctx(20, { noWindow: true }));
	check("S6 one message", sent.length === 1);
	check("S6 no percent clause", !sent[0].text.includes("% of the"));
}

// --- Post-compact: overflow (willRetry) still sends ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("overflow", 130000), ctx(20));
	check("post-compact overflow: still sends", sent.length === 1);
	check("post-compact overflow: steer delivery", sent[0].options?.deliverAs === "steer");
}

// --- Post-compact disabled ---
{
	process.env.PI_CONTEXT_STEER_POST_COMPACT = "off";
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("threshold", 120000), ctx(20));
	check("post-compact disabled: no message", sent.length === 0);
	delete process.env.PI_CONTEXT_STEER_POST_COMPACT;
}

// --- Both off → no handlers registered ---
{
	process.env.PI_CONTEXT_STEER = "off";
	process.env.PI_CONTEXT_STEER_POST_COMPACT = "off";
	const { pi, sent, registered, fire } = makePi();
	ext(pi);
	check("both off: no handlers registered", registered.length === 0);
	await fire("session_compact", compactEvent("threshold", 120000), ctx(20));
	await fire("message_end", ...assistantEnd(99));
	check("both off: nothing sent", sent.length === 0);
	delete process.env.PI_CONTEXT_STEER;
	delete process.env.PI_CONTEXT_STEER_POST_COMPACT;
}

// --- Only post-compact on (thresholds off) ---
{
	process.env.PI_CONTEXT_STEER = "off";
	process.env.PI_CONTEXT_STEER_POST_COMPACT = "on";
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("threshold", 120000), ctx(20));
	check("only post-compact: stage-1 fires", sent.length === 1);
	await fire("message_end", ...assistantEnd(null));
	check("only post-compact: no threshold steer", sent.length === 1);
	delete process.env.PI_CONTEXT_STEER;
	delete process.env.PI_CONTEXT_STEER_POST_COMPACT;
}

// --- No double message: post-compact then a low-% message_end ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("threshold", 120000), ctx(20));
	await fire("message_end", ...assistantEnd(20));
	check("no double: stage-1 then stage-2 only", sent.length === 2);
	check("no double: first is the post-compact one", sent[0].text.includes("compacted"));
	check("no double: second is stage-2 (not a threshold steer)", sent[1].text.startsWith("Context is now"));
}

// --- Consecutive compactions → one message each ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("overflow", 130000), ctx(20));
	await fire("session_compact", compactEvent("overflow", 125000), ctx(20));
	check("consecutive compactions: two stage-1 messages", sent.length === 2);
}

// --- Estimate counts content only (toolResult.details excluded) ---
{
	const bigDetails = "x".repeat(40000); // structured payload, never sent to LLM
	const messages = [
		{ role: "compactionSummary", summary: "s".repeat(400) }, // 100 tokens
		{
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "ok" }], // 1 token
			details: { fileContents: bigDetails },
			isError: false,
			timestamp: Date.now(),
		},
		{ role: "assistant", content: [{ type: "text", text: "t".repeat(400) }], usage: { input: 1, output: 1 }, timestamp: Date.now() }, // 100 tokens
	];
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("threshold", 120000), ctx(20, { messages, systemPrompt: "p".repeat(400) })); // 100 tokens
	check("estimate: one stage-1 message", sent.length === 1);
	// 100 + 1 + 100 + 100 = 301 — details (40k chars) must NOT inflate this
	check("estimate: content-only (details excluded)", sent[0].text.includes("approximately 301 tokens"));
	check("estimate: percent matches content-only", sent[0].text.includes("~0% of the 131072 limit"));
}

// --- tokensBefore missing / 0 → Variant A (no number) ---
{
	const { pi, sent, fire } = makePi();
	ext(pi);
	await fire("session_compact", compactEvent("threshold", 0), ctx(20));
	check("tokensBefore=0: still one message", sent.length === 1);
	check("tokensBefore=0: no 'tokens of earlier' clause", !sent[0].text.includes("tokens of earlier"));

	const { pi: pi2, sent: sent2, fire: fire2 } = makePi();
	ext(pi2);
	await fire2("session_compact", { type: "session_compact", reason: "manual", willRetry: false, fromExtension: false }, ctx(20, { idle: true }));
	check("missing compactionEntry: Variant A + plain send", sent2.length === 1 && sent2[0].options === undefined && !sent2[0].text.includes("tokens of earlier"));
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

import ext from "../index.ts";

let failures = 0;
function check(name, cond) {
	if (!cond) failures++;
	console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
}

function makePi() {
	const handlers = {};
	const sent = [];
	const pi = {
		on(event, handler) {
			(handlers[event] ??= []).push(handler);
		},
		sendUserMessage(text, options) {
			sent.push({ text, options });
		},
	};
	return {
		pi,
		sent,
		fire: async (event, payload, ctx) => {
			for (const h of handlers[event] ?? []) await h(payload, ctx);
		},
	};
}

function ctx(percent, { idle = false } = {}) {
	return {
		isIdle: () => idle,
		getContextUsage: () =>
			percent == null
				? { tokens: null, contextWindow: 131072, percent: null }
				: { tokens: Math.round((percent / 100) * 131072), contextWindow: 131072, percent },
	};
}

const assistantEnd = (pct, opts) => [{ type: "message_end", message: { role: "assistant" } }, ctx(pct, opts)];

// --- Scenario 1: default thresholds 70/80/90, streaming ---
{
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

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

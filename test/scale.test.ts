/**
 * Check 7: growth and open time over many turns (faux model, tool call every
 * other turn). Set TURNS to change the length; default 300.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { afterAll, expect, it } from "vitest";
import { chatSetup, openChat } from "../node_modules/@earendil-works/pi-durable/test/chat-support.ts";
import { addTool } from "../node_modules/@earendil-works/pi-durable/test/harness-support.ts";
import { context } from "../node_modules/@earendil-works/pi-durable/test/session-support.ts";
import { HtmlStorage } from "../src/storage.ts";

const TURNS = Number(process.env.TURNS ?? 300);
const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "durable-html-scale-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it(`grows linearly and reopens quickly over ${TURNS} turns`, async () => {
	const path = join(root, "scale.html.gz");
	const storage = await HtmlStorage.open(path, "scale");
	const setup = chatSetup({ tokensPerSecond: 1_000_000 });
	addTool(
		setup.registry,
		defineTool({
			name: "echo",
			description: "echo",
			parameters: Type.Object({ text: Type.Optional(Type.String()) }),
			execute: async (args) => ({ output: [{ type: "text", text: `echo ${args.text ?? ""}` }] }),
		}),
	);
	const answer = "A typical answer of a few sentences. ".repeat(12);
	const responses = [];
	for (let i = 0; i < TURNS; i++) {
		if (i % 2) responses.push(fauxAssistantMessage([fauxToolCall("echo", { text: `t${i}` }, { id: `c${i}` })], { stopReason: "toolUse" }));
		responses.push(fauxAssistantMessage([fauxText(`${i}: ${answer}`)]));
	}
	setup.faux.setResponses(responses);
	const { harness, root: main } = await openChat(storage, setup);
	const marks: string[] = [];
	const started = Date.now();
	for (let i = 1; i <= TURNS; i++) {
		const settled = await (await main.submit({ type: "input", content: `question ${i}` }, context)).wait(context);
		expect(settled.status).toBe("done");
		if (i % (TURNS / 6) === 0) marks.push(`turn ${i}: ${(statSync(path).size / 1024).toFixed(0)} KB`);
	}
	const writeMs = Date.now() - started;
	await harness.close(context);

	const bytes = statSync(path).size;
	const text = gunzipSync(readFileSync(path)).toString("utf8");
	const rows = text.split("\n").length - 1;
	const commits = (text.match(/itemtype="\/sessions\/commit"/g) ?? []).length;

	const t0 = performance.now();
	const reopened = await HtmlStorage.open(path, "scale");
	const openMs = performance.now() - t0;
	const entries = (await reopened.scanEntries({ conversationId: main.id }, 100_000, undefined, context)).items.length;

	const t1 = performance.now();
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const sm = SessionManager.open(path);
	const messages = sm.buildSessionContext().messages.length;
	const piMs = performance.now() - t1;

	console.log(
		[
			`== ${TURNS} turns`,
			...marks,
			`file ${(bytes / 1024).toFixed(0)} KB gz, ${(text.length / 1024).toFixed(0)} KB raw (${(text.length / bytes).toFixed(1)}x), ${rows} rows, ${commits} commits, ${entries} entries`,
			`per turn ${(bytes / TURNS / 1024).toFixed(1)} KB gz, ${(commits / TURNS).toFixed(1)} commits`,
			`write ${writeMs} ms (${(writeMs / commits).toFixed(2)} ms per commit, fsync each)`,
			`HtmlStorage.open ${openMs.toFixed(0)} ms; pi SessionManager.open + context ${piMs.toFixed(0)} ms (${messages} messages)`,
		].join("\n"),
	);
}, 600_000);

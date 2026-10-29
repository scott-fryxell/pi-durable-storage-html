/**
 * Check 3: what Durable writes during real turns (faux model, no network).
 * Logs commits, rows by type, entry kinds, message-row share, and bytes.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { defineTool, type Seq, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { afterAll, expect, it } from "vitest";
import { allEntries, chatSetup, openChat } from "../node_modules/@earendil-works/pi-durable/test/chat-support.ts";
import { addTool } from "../node_modules/@earendil-works/pi-durable/test/harness-support.ts";
import { context } from "../node_modules/@earendil-works/pi-durable/test/session-support.ts";
import { writeToRow } from "../src/rows.ts";
import { HtmlStorage } from "../src/storage.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "durable-html-turns-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Log = { seq: Seq; writes: readonly StorageWrite[]; bytes: number }[];

/** Wraps HtmlStorage.commit to log each commit and the bytes it appended. */
function record(storage: HtmlStorage): { storage: Storage; log: Log } {
	const log: Log = [];
	const commit = storage.commit.bind(storage);
	storage.commit = async (writes, ctx) => {
		const before = statSync(storage.path).size;
		const seq = await commit(writes, ctx);
		log.push({ seq, writes: storage.lastCommit!.writes, bytes: statSync(storage.path).size - before });
		return seq;
	};
	return { storage, log };
}

function summarize(name: string, log: Log, path: string) {
	const rows = new Map<string, number>();
	const kinds = new Map<string, number>();
	let entries = 0;
	let messages = 0;
	for (const { writes } of log)
		for (const write of writes) {
			const row = writeToRow(write);
			rows.set(row.type as string, (rows.get(row.type as string) ?? 0) + 1);
			if (write.type === "entry") {
				entries++;
				if (row.type === "message") messages++;
				kinds.set(write.value.kind, (kinds.get(write.value.kind) ?? 0) + 1);
			}
			if (write.type === "document.create" || write.type === "document.change") {
				const key = `${write.type}:${write.type === "document.create" ? write.record.kind : write.id}`;
				rows.set(key, (rows.get(key) ?? 0) + 1);
			}
		}
	const bytes = log.map((c) => c.bytes);
	console.log(
		[
			`== ${name}`,
			`commits ${log.length}, file ${statSync(path).size} B, per commit min ${Math.min(...bytes)} / max ${Math.max(...bytes)} / avg ${Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length)} B`,
			`rows ${[...rows].map(([k, v]) => `${k}=${v}`).join(" ")}`,
			`entry kinds ${[...kinds].map(([k, v]) => `${k}=${v}`).join(" ")}`,
			`entries ${entries}, as /sessions/message ${messages}`,
		].join("\n"),
	);
}

const long = "word ".repeat(400);

it("plain answers, tool calls, thinking, a fork, and a compaction", async () => {
	const path = join(root, "turns.html.gz");
	const { storage, log } = record(await HtmlStorage.open(path, "turns", "+16282281824"));
	const setup = chatSetup({ tokensPerSecond: 20000, tokenSize: { min: 4, max: 8 } });
	addTool(
		setup.registry,
		defineTool({
			name: "echo",
			description: "echo",
			parameters: Type.Object({ text: Type.Optional(Type.String()) }),
			execute: async (args) => ({ output: [{ type: "text", text: `echo ${args.text ?? ""}` }] }),
		}),
	);
	setup.faux.setResponses([
		fauxAssistantMessage([fauxText("Short answer.")]),
		fauxAssistantMessage([fauxThinking("Let me check."), fauxToolCall("echo", { text: "hi" }, { id: "c1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText(long)]),
		fauxAssistantMessage([fauxText("Summary of the conversation so far.")]),
		fauxAssistantMessage([fauxText("Answer on the fork.")]),
	]);
	const { harness, root: main } = await openChat(storage, setup);

	const ask = async (conversation: typeof main, text: string) =>
		(await (await conversation.submit({ type: "input", content: text }, context)).wait(context)).status;

	const mark = (name: string, from: number) => summarize(name, log.slice(from), path);

	let at = log.length;
	expect(await ask(main, "hello")).toBe("done");
	mark("open + plain answer", 0);
	at = log.length;
	expect(await ask(main, "use echo")).toBe("done");
	mark("tool call + long streamed answer", at);
	at = log.length;
	const compaction = await main.compact(undefined, context);
	console.log("compaction settled", JSON.stringify(await harness.waitForTask(compaction, context)).slice(0, 200));
	mark("compaction", at);
	at = log.length;
	const first = (await allEntries(main))[1];
	const fork = await main.fork(first.id, { ownership: { kind: "ownerless" } }, context);
	expect(await ask(fork, "on the fork")).toBe("done");
	mark("fork + answer", at);
	summarize("whole session", log, path);
	await harness.close(context);

	const { gunzipSync } = await import("node:zlib");
	const { readFileSync } = await import("node:fs");
	const text = gunzipSync(readFileSync(path)).toString("utf8");
	console.log(`uncompressed ${text.length} B, ${text.split("\n").length - 1} rows`);
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const sm = SessionManager.open(path);
	console.log("pi leaf", sm.getLeafId(), "roots", sm.getTree().map((n) => n.entry.id).join(","));
	console.log("pi context", sm.buildSessionContext().messages.map((m) => m.role).join(","));
	const reopened = await HtmlStorage.open(path, "turns");
	expect((await reopened.scanEntries({ conversationId: main.id }, 1000, undefined, context)).items.length).toBeGreaterThan(0);
});

/**
 * Checks 4 and 5: pi's readers on a file HtmlStorage wrote, with Durable-only
 * rows (commit, conversation, task, submission, document) and a second root
 * (an owned subagent conversation).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, expect, it } from "vitest";
import { HtmlStorage } from "../src/storage.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "durable-html-pi-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const path = join(root, "explorer.html.gz");

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-completions",
	provider: "faux",
	model: "faux-1",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: 2,
});
const entry = (id: number, conversationId: number, kind: string, message: object) =>
	({ type: "entry", value: { id, conversationId, kind, model: [message] } }) as unknown as StorageWrite;

it("writes a store with Durable rows and two roots", async () => {
	const s = await HtmlStorage.open(path, "explorer", "+16282281824");
	await s.commit([{ type: "conversation", value: { id: 1 } } as StorageWrite], ctx);
	await s.commit(
		[
			entry(2, 1, "user", user("What is in ~/notes?")),
			{ type: "submission", value: { id: 3, conversationId: 1, type: "input", status: "placed", entry: 2 } } as unknown as StorageWrite,
		],
		ctx,
	);
	await s.commit(
		[
			{ type: "task", value: { id: 4, conversationId: 1, kind: "turn", version: 1, input: {}, background: false, abortRequested: false, state: { status: "running" } } } as unknown as StorageWrite,
			{ type: "conversation", value: { id: 5, owner: { conversationId: 1, taskId: 4 } } } as StorageWrite,
		],
		ctx,
	);
	await s.commit([entry(6, 5, "user", user("subagent: list files"))], ctx);
	await s.commit([entry(7, 5, "assistant", assistant("notes/a.md"))], ctx);
	await s.commit([entry(8, 1, "assistant", assistant("One file: a.md"))], ctx);
	await s.commit(
		[{ type: "document.create", record: { id: 9, kind: "plan", scope: { kind: "session" } }, content: { kind: "base", version: 1, value: { steps: [] } } } as unknown as StorageWrite],
		ctx,
	);
	await s.close(ctx);
	console.log(execFileSync("sh", ["-c", `gzip -dc ${path} | cut -c1-160`]).toString());
});

it("pi-session-read decodes every row", () => {
	const bin = join(__dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/session-read.js");
	const out = execFileSync("node", [bin, path]).toString().trim().split("\n");
	console.log(out.map((l) => l.slice(0, 120)).join("\n"));
	expect(out.length).toBe(1 + 7 + 9);
});

it("SessionManager opens it, builds the tree, and a context", () => {
	const sm = SessionManager.open(path);
	const entries = sm.getEntries();
	const roots = sm.getTree();
	console.log("entries", entries.length, "types", [...new Set(entries.map((e) => e.type))].join(","));
	console.log("roots", roots.map((r) => `${r.entry.type}:${r.entry.id}`).join(" "));
	console.log("leaf", sm.getLeafId());
	const context = sm.buildSessionContext();
	console.log("context from leaf", context.messages.map((m) => `${m.role}`).join(","));
	const main = buildSessionContext(entries, "8");
	console.log("context from entry 8", main.messages.map((m) => `${m.role}`).join(","));
	const sub = buildSessionContext(entries, "7");
	console.log("context from entry 7", sub.messages.map((m) => `${m.role}`).join(","));
	expect(sm.getLeafId()).toBe("8");
	expect(roots.map((r) => r.entry.id)).toEqual(["2", "6"]);
	expect(context.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	expect(main.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	expect(sub.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
});

it("HTML export renders it", async () => {
	const { exportFromFile } = await import(
		"../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/index.js"
	);
	const out = await exportFromFile(path, join(root, "export.html"));
	const html = execFileSync("cat", [out]).toString();
	console.log("export bytes", html.length, "has answer", html.includes("One file: a.md"));
	expect(html.length).toBeGreaterThan(0);
});

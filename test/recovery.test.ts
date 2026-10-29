/**
 * Check 6: crash recovery. Cut the file at every byte inside the last gzip
 * member; corrupt a middle member.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { afterAll, expect, it } from "vitest";
import { HtmlStorage } from "../src/storage.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "durable-html-recovery-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const entry = (id: number, text: string) =>
	({
		type: "entry",
		value: { id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: id }] },
	}) as unknown as StorageWrite;

const ids = async (s: HtmlStorage) =>
	(await s.conversation(1 as never, ctx))
		? (await s.scanEntries({ conversationId: 1 as never, order: "ascending" }, 100, undefined, ctx)).items.map((e) => e.id)
		: [];

/** A file with three commits; returns the size after each. */
async function build(path: string) {
	const s = await HtmlStorage.open(path, "r");
	const sizes = [statSync(path).size];
	await s.commit([{ type: "conversation", value: { id: 1 } } as StorageWrite], ctx);
	sizes.push(statSync(path).size);
	await s.commit([entry(2, "first")], ctx);
	sizes.push(statSync(path).size);
	await s.commit([entry(3, "second line\nwith a newline"), entry(4, "third")], ctx);
	sizes.push(statSync(path).size);
	await s.close(ctx);
	return sizes;
}

it("drops an unfinished last commit at every cut point, then appends cleanly", async () => {
	const source = join(root, "source.html.gz");
	const sizes = await build(source);
	const [, , beforeLast, full] = sizes;
	const cut = join(root, "cut.html.gz");
	let checked = 0;
	for (let size = beforeLast + 1; size < full; size++) {
		copyFileSync(source, cut);
		truncateSync(cut, size);
		const s = await HtmlStorage.open(cut, "r");
		expect(s.recovered?.dropped).toBe(size - beforeLast);
		expect(statSync(cut).size).toBe(beforeLast);
		expect(await ids(s)).toEqual([2]);
		await s.commit([entry(5, "after recovery")], ctx);
		await s.close(ctx);
		const again = await HtmlStorage.open(cut, "r");
		expect(again.recovered).toBeUndefined();
		expect(await ids(again)).toEqual([2, 5]);
		await again.close(ctx);
		checked++;
	}
	console.log(`cut points checked: ${checked} (last member ${full - beforeLast} bytes)`);
	expect(checked).toBe(full - beforeLast - 1);
});

it("a whole file opens with nothing dropped", async () => {
	const path = join(root, "whole.html.gz");
	await build(path);
	const s = await HtmlStorage.open(path, "r");
	expect(s.recovered).toBeUndefined();
	expect(await ids(s)).toEqual([2, 3, 4]);
});

it("a cut-off header starts the file again", async () => {
	const path = join(root, "header.html.gz");
	const [header] = await build(path);
	truncateSync(path, header - 3);
	const s = await HtmlStorage.open(path, "r");
	expect(s.recovered?.dropped).toBe(header - 3);
	expect(await ids(s)).toEqual([]);
});

it("corruption in a middle member fails the open and leaves the bytes alone", async () => {
	const path = join(root, "corrupt.html.gz");
	const sizes = await build(path);
	const original = readFileSync(path);
	// Inside the second commit's member, in its deflate data.
	const at = Math.floor((sizes[1] + sizes[2]) / 2);
	const damaged = Buffer.from(original);
	damaged[at] ^= 0xff;
	writeFileSync(path, damaged);
	await expect(HtmlStorage.open(path, "r")).rejects.toThrow();
	expect(readFileSync(path).equals(damaged)).toBe(true);
});

it("a damaged gzip header in the middle fails the open", async () => {
	const path = join(root, "magic.html.gz");
	const sizes = await build(path);
	const damaged = readFileSync(path);
	damaged[sizes[1]] = 0;
	writeFileSync(path, damaged);
	await expect(HtmlStorage.open(path, "r")).rejects.toThrow(/Invalid session gzip header/);
	expect(statSync(path).size).toBe(damaged.length);
});

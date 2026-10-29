/**
 * Check 1 (lossless round trip) and check 2 (upstream storage contract).
 * Every commit the conformance suite makes is decoded back from the file and
 * compared with the writes as prepared; a reopening variant rebuilds state
 * from the file after every commit.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Id, Seq, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import { decodeLog } from "../src/rows.ts";
import { HtmlStorage } from "../src/storage.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "durable-html-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `${++n}.html.gz`);

/** JSON's view of a value: undefined properties dropped. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

export const mismatches: { seq: Seq; expected: unknown; actual: unknown }[] = [];

class Checked implements Storage {
	constructor(
		private current: HtmlStorage,
		private readonly reopen: boolean,
	) {}

	async commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
		const seq = await this.current.commit(writes, context);
		const { commits } = decodeLog(gunzipSync(readFileSync(this.current.path)).toString("utf8"));
		const last = commits.at(-1);
		const expected = plain(this.current.lastCommit?.writes);
		const actual = plain(last?.writes);
		try {
			expect(last?.seq).toBe(seq);
			expect(actual).toEqual(expected);
		} catch (error) {
			mismatches.push({ seq, expected, actual });
			throw error;
		}
		if (this.reopen) {
			await this.current.close(BACKGROUND_CONTEXT);
			this.current = await HtmlStorage.open(this.current.path, this.current.session);
		}
		return seq;
	}

	mintId<I extends Id<string>>(): Promise<I> {
		return this.current.mintId<I>();
	}
	conversation: Storage["conversation"] = (...a) => this.current.conversation(...a);
	scanConversations: Storage["scanConversations"] = (...a) => this.current.scanConversations(...a);
	entry: Storage["entry"] = ((...a: unknown[]) =>
		(this.current.entry as (...b: unknown[]) => unknown)(...a)) as Storage["entry"];
	findLatestHeadMarker: Storage["findLatestHeadMarker"] = (...a) => this.current.findLatestHeadMarker(...a);
	scanEntries: Storage["scanEntries"] = (...a) => this.current.scanEntries(...a);
	task: Storage["task"] = (...a) => this.current.task(...a);
	scanTasks: Storage["scanTasks"] = (...a) => this.current.scanTasks(...a);
	submission: Storage["submission"] = (...a) => this.current.submission(...a);
	scanSubmissions: Storage["scanSubmissions"] = (...a) => this.current.scanSubmissions(...a);
	submissionByRequest: Storage["submissionByRequest"] = (...a) => this.current.submissionByRequest(...a);
	findDocument: Storage["findDocument"] = (...a) => this.current.findDocument(...a);
	document: Storage["document"] = (...a) => this.current.document(...a);
	scanDocuments: Storage["scanDocuments"] = (...a) => this.current.scanDocuments(...a);
	close: Storage["close"] = (...a) => this.current.close(...a);
}

registerStorageConformance({ describe, expect, it }, "HtmlStorage", async (use) =>
	use(new Checked(await HtmlStorage.open(fresh(), "s1"), false)),
);

registerStorageConformance({ describe, expect, it }, "HtmlStorage across reopen", async (use) =>
	use(new Checked(await HtmlStorage.open(fresh(), "s2"), true)),
);

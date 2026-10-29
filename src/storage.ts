/**
 * HtmlStorage: upstream MemoryStorage answers every read; each commit is one
 * gzip member of /sessions rows appended to one .html.gz file. Reads use the
 * shared member walk. On Node a server supplies an fsync option; browsers write
 * through a worker's sync handle, so their commit lands on the adapter.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { Context } from "@earendil-works/chord";
import { MemoryStorage, type Id, type Seq, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { entryToHtmlLine } from "@earendil-works/pi-coding-agent/session-rows";
import { read_session_gzip } from "@earendil-works/pi-coding-agent/session-rows/node";
import { decodeLog, encodeCommit } from "./rows.ts";

const append = (path: string, bytes: Buffer, fsync: boolean) => {
	appendFileSync(path, bytes);
	if (!fsync) return;
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
};

export interface HtmlStorageOptions {
	/** fsync after every commit. Node zlib defaults this off in upstream JSONL. */
	fsync?: boolean;
}

export class HtmlStorage implements Storage {
	/** The writes of the newest commit as prepared, for round-trip checks. */
	private lastCommit: { seq: Seq; writes: readonly StorageWrite[] } | undefined;
	/** Newest entry id per conversation, and each conversation's fork point. */
	private readonly tails = new Map<number, number>();
	private readonly forks = new Map<number, number>();
	private readonly memory = new MemoryStorage();

	private constructor(
		readonly path: string,
		readonly session: string,
		readonly owner: string | undefined,
		private readonly fsync: boolean,
	) {}

	static async open(path: string, session: string, owner?: string, options: HtmlStorageOptions = {}): Promise<HtmlStorage> {
		const storage = new HtmlStorage(path, session, owner, options.fsync ?? false);
		// A cut-off last member was never acknowledged: drop it before reading or appending.
		const read = existsSync(path) ? read_session_gzip(readFileSync(path)) : undefined;
		if (read && read.incomplete_bytes > 0) {
			storage.recovered = { dropped: read.incomplete_bytes };
			truncateSync(path, read.valid_bytes);
		}
		if (!read || read.valid_bytes === 0) {
			const header = { type: "session", version: 3, id: session, timestamp: new Date().toISOString(), cwd: "" };
			append(path, gzipSync(`${entryToHtmlLine(header, session, owner)}\n`), storage.fsync);
			return storage;
		}
		const { commits, complete } = decodeLog(read.text);
		// Each commit is one whole member, so a short commit inside one is corruption.
		if (!complete) throw new Error(`${path}: a commit has fewer rows than it promises`);
		for (const { seq, writes } of commits) {
			storage.memory.prepareCommit(writes, seq).apply();
			for (const write of writes) storage.track(write);
		}
		return storage;
	}

	/** Set when open dropped an unfinished last member. */
	recovered: { dropped: number } | undefined;

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		const prepared = this.memory.prepareCommit(writes);
		const lineage = (write: StorageWrite) => this.lineage(write);
		const bytes = gzipSync(encodeCommit(prepared.seq, prepared.writes, this.session, this.owner, lineage));
		try {
			append(this.path, bytes, this.fsync);
		} catch {
			throw new Error(`${this.path}: append failed; the commit was not acknowledged`);
		}
		// Adopt only the successful commit; lineage updates follow a durable write.
		const seq = prepared.apply();
		for (const write of prepared.writes) this.track(write);
		this.lastCommit = { seq, writes: prepared.writes };
		return seq;
	}

	/** Pi's parentId: the previous entry in the conversation, else the fork point, else none. */
	private lineage(write: StorageWrite) {
		if (write.type !== "entry") return undefined;
		const { id, conversationId } = write.value;
		const parent = this.tails.get(conversationId) ?? this.forks.get(conversationId);
		return { parentId: parent === undefined ? null : String(parent), timestamp: new Date().toISOString() };
	}

	/** Record lineage only after the write is durable; a failed append leaves it untouched. */
	private track(write: StorageWrite) {
		if (write.type === "conversation" && write.value.parent) this.forks.set(write.value.id, write.value.parent.at);
		if (write.type !== "entry") return;
		this.tails.set(write.value.conversationId, write.value.id);
	}

	mintId<I extends Id<string>>(): Promise<I> {
		return this.memory.mintId<I>();
	}

	conversation: Storage["conversation"] = (...a) => this.memory.conversation(...a);
	scanConversations: Storage["scanConversations"] = (...a) => this.memory.scanConversations(...a);
	entry: Storage["entry"] = (...a) =>
		(this.memory.entry as unknown as (...b: never[]) => unknown)(...a) as ReturnType<Storage["entry"]>;
	findLatestHeadMarker: Storage["findLatestHeadMarker"] = (...a) => this.memory.findLatestHeadMarker(...a);
	scanEntries: Storage["scanEntries"] = (...a) => this.memory.scanEntries(...a);
	task: Storage["task"] = (...a) => this.memory.task(...a);
	scanTasks: Storage["scanTasks"] = (...a) => this.memory.scanTasks(...a);
	submission: Storage["submission"] = (...a) => this.memory.submission(...a);
	scanSubmissions: Storage["scanSubmissions"] = (...a) => this.memory.scanSubmissions(...a);
	submissionByRequest: Storage["submissionByRequest"] = (...a) => this.memory.submissionByRequest(...a);
	findDocument: Storage["findDocument"] = (...a) => this.memory.findDocument(...a);
	document: Storage["document"] = (...a) => this.memory.document(...a);
	scanDocuments: Storage["scanDocuments"] = (...a) => this.memory.scanDocuments(...a);
	close: Storage["close"] = (...a) => this.memory.close(...a);
}
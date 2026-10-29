/**
 * Browser HtmlStorage: MemoryStorage answers reads; one OPFS file holds the
 * session members, appended by a dedicated worker's sync access handle. Reads
 * walk members with pako; Web Locks keep one tab the writer. Node's
 * session-rows/members.ts walk is shared; we provide the pako codec.
 */
import type { Context } from "@earendil-works/chord";
import { MemoryStorage, type Id, type Seq, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import {
	entryToHtmlLine,
	htmlLineToEntry,
	readMembers,
	type RawInflate,
} from "@earendil-works/pi-coding-agent/session-rows";
import { Inflate } from "pako";
import { WRITER_WORKER_SOURCE } from "./browser-writer.ts";
import { decodeLog, encodeCommit } from "./rows.ts";

const pako_inflate_raw: RawInflate = (data) => {
	const inflate = new Inflate({ raw: true });
	let threw: unknown;
	try {
		inflate.push(data, true);
	} catch (error) {
		threw = error;
	}
	if (!inflate.ended || threw !== undefined || inflate.err === -5) return { status: "short" };
	if (inflate.err) throw inflate.msg ? new Error(inflate.msg) : new Error("pako inflate failed");
	return { status: "end", output: inflate.result as Uint8Array, consumed: data.length - inflate.strm.avail_in };
};

type Req = { kind: "open" | "append" | "truncate"; name?: string; bytes?: Uint8Array; length?: number };

export class BrowserHtmlStorage implements Storage {
	private readonly memory = new MemoryStorage();
	private readonly tails = new Map<number, number>();
	private readonly forks = new Map<number, number>();
	private readonly worker: Worker;
	private next = 1;
	private readonly pending = new Map<number, (r: unknown) => void>();
	private closed = false;

	private constructor(
		readonly name: string,
		readonly session: string,
		readonly owner: string | undefined,
	) {
		const source = new Blob([WRITER_WORKER_SOURCE], { type: "text/javascript" });
		this.worker = new Worker(URL.createObjectURL(source), { type: "module" });
		this.worker.onmessage = (e) => {
			const p = this.pending.get(e.data.id);
			if (p) {
				this.pending.delete(e.data.id);
				p(e.data.result);
			}
		};
	}

	private call(message: Req): Promise<unknown> {
		const id = this.next++;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.worker.postMessage({ id, ...message });
		});
	}

	/** Open or truncate-recover the OPFS store, then replay committed members. */
	static async open(name: string, session: string, owner?: string): Promise<BrowserHtmlStorage> {
		const storage = new BrowserHtmlStorage(name, session, owner);
		let opened: { size: number; bytes: Uint8Array } | undefined;
		const res = (await storage.call({ kind: "open", name })) as { size: number; bytes: Uint8Array; error?: string };
		if (res.error) {
			// A second holder means another tab writes; hand Explorer its TakenError shape.
			const err = new Error(res.error) as Error & { name: string };
			err.name = "OwnershipLostError";
			throw err;
		}
		opened = res;
		const bytes = opened.bytes ?? new Uint8Array();
		// A torn tail is dropped from memory; the worker still holds the file bytes for appends.
		const read = readMembers(bytes, pako_inflate_raw);
		if (read.incomplete_bytes > 0 && read.valid_bytes > 0) {
			// Rewrite the file down to the last whole member.
			await storage.rewrite(bytes.subarray(0, read.valid_bytes));
		}
		if (read.text.length === 0) {
			const header = { type: "session", version: 3, id: session, timestamp: new Date().toISOString(), cwd: "" };
			await storage.call({
				kind: "append",
				bytes: await gzip(new TextEncoder().encode(`${entryToHtmlLine(header, session, owner)}\n`)),
			});
			return storage;
		}
		const { commits, complete } = decodeLog(read.text);
		if (!complete) throw new Error(`${name}: a commit has fewer rows than it promises`);
		for (const { seq, writes } of commits) {
			storage.memory.prepareCommit(writes, seq).apply();
			for (const w of writes) storage.track(w);
		}
		return storage;
	}

	/** Read the store without the writer's sync handle; commits are refused. */
	static async readOnly(name: string, session: string, owner?: string): Promise<BrowserHtmlStorage> {
		const storage = new BrowserHtmlStorage(name, session, owner);
		const root = await navigator.storage.getDirectory();
		let bytes = new Uint8Array();
		try {
			const file = await root.getFileHandle(name);
			bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
		} catch {
			bytes = new Uint8Array();
		}
		const read = readMembers(bytes, pako_inflate_raw);
		if (read.incomplete_bytes > 0 && read.valid_bytes > 0) bytes = bytes.subarray(0, read.valid_bytes);
		const { commits, complete } = decodeLog(read.text);
		if (read.text.length > 0 && !complete) throw new Error(`${name}: a commit has fewer rows than it promises`);
		if (read.text.length > 0)
			for (const { seq, writes } of commits) {
				storage.memory.prepareCommit(writes, seq).apply();
				for (const w of writes) storage.track(w);
			}
		return storage;
	}

	private async rewrite(bytes: Uint8Array) {
		await this.call({ kind: "truncate", length: bytes.length });
		if (bytes.length > 0) await this.call({ kind: "append", bytes });
	}

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		if (this.closed) throw new Error("read-only explorer tab cannot write");
		const prepared = this.memory.prepareCommit(writes);
		const lineage = (write: StorageWrite) => this.lineage(write);
		const text = encodeCommit(prepared.seq, prepared.writes, this.session, this.owner, lineage);
		const bytes = await gzip(new TextEncoder().encode(text));
		const res = (await this.call({ kind: "append", bytes })) as { size: number; error?: string };
		if (res.error) throw new Error(res.error);
		const seq = prepared.apply();
		for (const write of prepared.writes) this.track(write);
		return seq;
	}

	private lineage(write: StorageWrite) {
		if (write.type !== "entry") return undefined;
		const { id, conversationId } = write.value;
		const parent = this.tails.get(conversationId) ?? this.forks.get(conversationId);
		return { parentId: parent === undefined ? null : String(parent), timestamp: new Date().toISOString() };
	}

	private track(write: StorageWrite) {
		if (write.type === "conversation" && write.value.parent) this.forks.set(write.value.id, write.value.parent.at);
		if (write.type !== "entry") return;
		this.tails.set(write.value.conversationId, write.value.id);
	}

	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.worker.terminate();
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
}

const gzip = async (bytes: Uint8Array) =>
	new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
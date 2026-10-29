/**
 * Durable StorageWrites as /sessions rows (FORMAT.md, draft 3), using the
 * shared session-rows codec. Reference ids become `<link>` and read back as
 * numbers; everything else keeps its JSON type. Rows never interpret records:
 * they are an encoding of exactly what the Session committed.
 */
import type { JsonValue, Seq, StorageWrite } from "@earendil-works/pi-durable";
import {
	entryToHtmlLine,
	htmlLineToEntry,
	type LinkResolver,
} from "@earendil-works/pi-coding-agent/session-rows";

type Row = { [key: string]: JsonValue };

/* Dotted key paths that name another record; they link and read back as ids. */
const REF_PATHS = [
	"conversationId",
	"byTaskId",
	"head",
	"parent.conversationId",
	"parent.at",
	"owner.conversationId",
	"owner.taskId",
	"record.entry",
	"record.answer",
	"edits.target",
	"scope.taskId",
	"scope.conversationId",
	"source.id",
] as const;
const numericRefs = new Set<string>(REF_PATHS);

const json = (value: unknown) => value as JsonValue;

/** Keeps a key such as "__proto__" an ordinary property. */
const define = (target: Row, key: string, value: JsonValue) =>
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });

/** Drops undefined properties the way JSON does, so the codec sees JSON only. */
const plain = (value: unknown): JsonValue => {
	if (Array.isArray(value)) return value.map(plain);
	if (value !== null && typeof value === "object") {
		const out: Row = {};
		for (const [key, item] of Object.entries(value)) if (item !== undefined) define(out, key, plain(item));
		return out;
	}
	return json(value);
};

const without = (object: object, ...keys: string[]): Row => {
	const out: Row = {};
	for (const [key, value] of Object.entries(plain(object) as Row)) if (!keys.includes(key)) define(out, key, value);
	return out;
};

/** Pi's tree fields for an entry row; derived for reading, never decoded back. */
export type Lineage = (write: StorageWrite) => { parentId: string | null; timestamp: string } | undefined;

export function writeToRow(write: StorageWrite, lineage?: Lineage): Row {
	const row = encodeBody(write);
	const tree = lineage?.(write);
	if (!tree) return row;
	const { type, id, ...rest } = row;
	return { type, id, parentId: tree.parentId, timestamp: tree.timestamp, ...rest };
}

function encodeBody(write: StorageWrite): Row {
	switch (write.type) {
		case "conversation":
			return { type: "conversation", id: String(write.value.id), ...without(write.value, "id") };
		case "entry": {
			const { model, ...rest } = write.value;
			// Use /sessions/message only when it holds everything losslessly.
			const message = model?.length === 1 && !plain(rest).message;
			if (message) return { type: "message", id: String(rest.id), message: plain(model[0]), ...without(rest, "id") };
			return { type: "entry", id: String(write.value.id), ...without(write.value, "id") };
		}
		case "task":
			return { type: "task", id: String(write.value.id), ...without(write.value, "id") };
		case "submission":
			// A submission has its own `type` (input or write); keep it apart from the row's.
			return { type: "submission", id: String(write.value.id), record: without(write.value, "id") };
		case "document.create":
			return {
				type: "document/create",
				id: String(write.record.id),
				...without(write.record, "id"),
				content: plain(write.content),
			};
		case "document.copy":
			return {
				type: "document/copy",
				id: String(write.record.id),
				...without(write.record, "id"),
				source: plain(write.source),
			};
		case "document.change":
			return { type: "document/change", id: String(write.id), content: plain(write.content) };
		case "document.retire":
			return { type: "document/retire", id: String(write.id) };
		default:
			throw new Error(`Unknown StorageWrite type: ${(write as { type: string }).type}`);
	}
}

export function rowToWrite(row: Row): StorageWrite {
	const { type, id: text, parentId: _p, timestamp: _t, ...rest } = row as Row & { type: string; id: string };
	const id = Number(text);
	switch (type) {
		case "conversation":
			return { type: "conversation", value: { id, ...rest } } as unknown as StorageWrite;
		case "message": {
			const { message, ...fields } = rest;
			return { type: "entry", value: { id, ...fields, model: [message] } } as unknown as StorageWrite;
		}
		case "entry":
		case "task":
			return { type, value: { id, ...rest } } as unknown as StorageWrite;
		case "submission":
			return { type, value: { id, ...(rest.record as Row) } } as unknown as StorageWrite;
		case "document/create": {
			const { content, ...record } = rest;
			return { type: "document.create", record: { id, ...record }, content } as unknown as StorageWrite;
		}
		case "document/copy": {
			const { source, ...record } = rest;
			return { type: "document.copy", record: { id, ...record }, source } as unknown as StorageWrite;
		}
		case "document/change":
			return { type: "document.change", id, content: rest.content } as unknown as StorageWrite;
		case "document/retire":
			return { type: "document.retire", id } as unknown as StorageWrite;
		default:
			throw new Error(`Unknown row type: ${type}`);
	}
}

/** Reference values become `<link>` to the row in the same file. */
const makeLinks = (session: string): LinkResolver => (path, value) =>
	numericRefs.has(path.join(".")) ? `/sessions/${session}/${value}` : undefined;

/** One commit: its commit row, then one row per write, all in the same member's text. */
export function encodeCommit(
	seq: Seq,
	writes: readonly StorageWrite[],
	session: string,
	owner?: string,
	lineage?: Lineage,
): string {
	const rows = [{ type: "commit", id: `seq-${seq}`, writes: writes.length }, ...writes.map((w) => writeToRow(w, lineage))];
	return rows.map((row) => `${entryToHtmlLine(row, session, owner, makeLinks(session))}\n`).join("");
}

export type DecodedCommit = { seq: Seq; writes: StorageWrite[] };

/** Header first, then commits; a commit short of its rows ends the list. */
export function decodeLog(text: string): { header: Row | undefined; commits: DecodedCommit[]; complete: boolean } {
	const lines = text.split("\n").filter((line) => line.length > 0);
	const rows = lines.map((line) => htmlLineToEntry(line, numericRefs) as Row);
	const header = rows[0]?.type === "session" ? rows.shift() : undefined;
	const commits: DecodedCommit[] = [];
	for (let at = 0; at < rows.length; ) {
		const commit = rows[at] as Row & { type: string; id: string; writes: number };
		if (commit.type !== "commit") throw new Error(`Expected a commit row, got ${commit.type}`);
		const body = rows.slice(at + 1, at + 1 + commit.writes);
		if (body.length < commit.writes) return { header, commits, complete: false };
		commits.push({ seq: Number(commit.id.slice(4)) as Seq, writes: body.map(rowToWrite) });
		at += 1 + commit.writes;
	}
	return { header, commits, complete: true };
}
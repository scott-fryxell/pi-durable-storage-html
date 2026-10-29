/**
 * The shared member walk (fork's session-rows/members.ts) keeps the contract
 * the curve tests relied on: every truncated-tail byte recovers, checksum
 * corruption throws, and a whole file reads in order. Same code the browser
 * runs with pako; Node runs it with zlib here.
 */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { node_inflate_raw } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-rows/node.js";
import { crc32, readMembers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-rows/index.js";

const rows = ["<h>header</h>\n", "<c>one</c>\n", "<c>two long row with padding</c>\n".padStart(120, " ")]
	.map((row) => row.replace(/^ +/, ""));
const members = rows.map((row) => gzipSync(row));

describe("session member walk", () => {
	it("reads a whole file in order and reports nothing incomplete", () => {
		const bytes = Buffer.concat(members);
		const r = readMembers(bytes, node_inflate_raw);
		expect(r.text).toBe(rows.join(""));
		expect(r.valid_bytes).toBe(bytes.length);
		expect(r.incomplete_bytes).toBe(0);
	});

	it("keeps the last whole member at every truncated-tail byte", () => {
		const prefix = Buffer.concat(members.slice(0, 2));
		const tail = members[2];
		for (let cut = 0; cut < tail.length; cut += 1) {
			const bytes = Buffer.concat([prefix, tail.subarray(0, cut)]);
			const r = readMembers(bytes, node_inflate_raw);
			expect(r.valid_bytes).toBe(prefix.length);
			expect(r.incomplete_bytes).toBe(cut);
			expect(r.text).toBe(rows.slice(0, 2).join(""));
		}
	});

	it("rejects checksum corruption in any member", () => {
		for (let i = 0; i < members.length; i++) {
			const damaged = Buffer.from(members[i]);
			damaged[damaged.length - 8] ^= 1;
			expect(() => readMembers(Buffer.concat(members.map((m, j) => (j === i ? damaged : m))), node_inflate_raw)).toThrow();
		}
	});

	it("crc32 matches the RFC 1952 check value", () => {
		expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
	});
	it("rejects a bad gzip header and a missing newline", () => {
		expect(() => readMembers(Buffer.from("garbage"), node_inflate_raw)).toThrow(/header/);
		expect(() => readMembers(gzipSync("no newline"), node_inflate_raw)).toThrow(/newline/);
	});
});
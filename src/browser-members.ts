/**
 * Pako raw inflate as the member-walk's codec, for the browser. Mirrors the
 * Node adapter in the fork's `session-rows/node.ts`; `consumed` is read the
 * same way pako writes `strm.avail_in`.
 */
import { Inflate } from "pako";
import type { RawInflate } from "@earendil-works/pi-coding-agent/session-rows";

export const pako_inflate_raw: RawInflate = (data) => {
	const inflate = new Inflate({ raw: true });
	let threw: unknown;
	try {
		inflate.push(data, true);
	} catch (error) {
		threw = error;
	}
	// pako reports an input that ran out as Z_BUF_ERROR (-5, "buffer error");
	// corruption in the middle instead finishes the stream and then fails its CRC.
	if (!inflate.ended || threw !== undefined || inflate.err === -5) return { status: "short" };
	if (inflate.err) throw inflate.msg ? new Error(inflate.msg) : new Error("pako inflate failed");
	return { status: "end", output: inflate.result as Uint8Array, consumed: data.length - inflate.strm.avail_in };
};
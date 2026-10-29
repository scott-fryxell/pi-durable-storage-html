/**
 * OPFS writer worker: one file, one sync access handle, appended in place.
 * The main thread owns who holds this file; the worker only moves bytes.
 */
let handle: FileSystemSyncAccessHandle | undefined;
let size = 0;

/** Sync access under a Web Lock; a second call in another context fails. */
self.onmessage = async (e) => {
	const msg: { id: number; kind: "open" | "append" | "truncate"; name?: string; bytes?: Uint8Array; length?: number } = e.data;
	const post = (result: unknown) => self.postMessage({ id: msg.id, result });

	try {
		if (msg.kind === "open") {
			const root = await navigator.storage.getDirectory();
			const file = await root.getFileHandle(msg.name!, { create: true });
			handle = await (file as FileSystemFileHandle).createSyncAccessHandle();
			size = handle.getSize();
			const whole = new Uint8Array(size);
			if (size > 0) handle.read(whole, { at: 0 });
			post({ size, bytes: whole });
			return;
		}
		if (msg.kind === "append") {
			if (!handle) throw new Error("writer not open");
			handle.write(msg.bytes!, { at: size });
			handle.flush();
			size += msg.bytes!.length;
			post({ size });
			return;
		}
		if (msg.kind === "truncate") {
			if (!handle) throw new Error("writer not open");
			handle.truncate(msg.length!);
			handle.flush();
			size = msg.length!;
			post({ size });
			return;
		}
		throw new Error(`unknown op ${(msg as { kind: string }).kind}`);
	} catch (error) {
		post({ error: error instanceof Error ? error.message : String(error) });
	}
};
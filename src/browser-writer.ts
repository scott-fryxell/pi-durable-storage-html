/**
 * The OPFS writer worker, embedded so the durable lib build stays one file.
 * The worker holds one sync access handle and appends in place; the main thread
 * owns who holds the file (Web Locks) and only moves bytes.
 */
export const WRITER_WORKER_SOURCE = `
let handle, size = 0;
self.onmessage = async (e) => {
  const msg = e.data;
  const post = (result) => self.postMessage({ id: msg.id, result });
  try {
    if (msg.kind === "open") {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle(msg.name, { create: true });
      handle = await file.createSyncAccessHandle();
      size = handle.getSize();
      const whole = new Uint8Array(size);
      if (size > 0) handle.read(whole, { at: 0 });
      post({ size, bytes: whole });
      return;
    }
    if (msg.kind === "append") {
      if (!handle) throw new Error("writer not open");
      handle.write(msg.bytes, { at: size });
      handle.flush();
      size += msg.bytes.length;
      post({ size });
      return;
    }
    if (msg.kind === "truncate") {
      if (!handle) throw new Error("writer not open");
      handle.truncate(msg.length);
      handle.flush();
      size = msg.length;
      post({ size });
      return;
    }
    throw new Error("unknown op " + msg.kind);
  } catch (error) {
    post({ error: error instanceof Error ? error.message : String(error) });
  }
};
`;
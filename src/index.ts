/** Browser-safe entry for the durable bundle. The Node backend stays reachable
 * by its own path (`./storage.ts`, `./rows.ts`) so it is never bundled here. */
export { pako_inflate_raw } from "./browser-members.ts";
export { BrowserHtmlStorage } from "./browser-storage.ts";

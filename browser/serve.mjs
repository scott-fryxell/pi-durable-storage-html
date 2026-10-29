import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
const here = resolve("work/pi-durable-storage-html/browser");
const types = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json" };
createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const path = url === "/pi-durable.browser.js" ? resolve(here, "pi-durable.browser.js") : join(here, url === "/" ? "e2e.html" : url);
  const body = await readFile(path).catch(() => undefined);
  if (!body) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
  res.end(body);
}).listen(4399, "127.0.0.1");

// Static server for the browser checks: node browser/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
const WORK = new URL("..", new URL("./", import.meta.url)).pathname;
const APPS = "/Users/scott/Desktop/Realness/apps/realness";
const here = new URL(".", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
createServer(async (req, res) => {
	const path = req.url.startsWith("/node_modules/")
	? join(APPS, "node_modules", req.url.slice("/node_modules/".length))
	: join(here, req.url === "/" ? "index.html" : req.url.split("?")[0]);
	const body = await readFile(path).catch(() => undefined);
	if (body === undefined) return res.writeHead(404).end();
	res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
	res.end(body);
}).listen(Number(process.argv[2] ?? 4399), "127.0.0.1");

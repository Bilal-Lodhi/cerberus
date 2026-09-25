/**
 * A minimal static file server for the built Flutter web console.
 *
 * Used only for the v0.2.0 browser/visual QA pass: `flutter build web` produces a
 * directory of static files, and a browser needs them served over HTTP rather than
 * opened from the filesystem (Flutter web fetches its assets and service worker).
 *
 * Deliberately dependency-free — Node's own `http` module — so the QA pass adds
 * nothing to the project.
 *
 *   node scripts/qa/serve-web.mjs <dir> <port>
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "apps/console/build/web");
const port = Number.parseInt(process.argv[3] ?? "8090", 10);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  // `normalize` plus a prefix check keeps `..` from escaping the build directory.
  const candidate = normalize(join(root, decodeURIComponent(url.pathname)));
  let filePath = candidate.startsWith(root) ? candidate : root;

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    filePath = join(root, "index.html");
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      // The QA pass must observe current output, never a cached bundle.
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (error) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`not found: ${filePath} (${error instanceof Error ? error.message : error})`);
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`[qa] serving ${root} on http://127.0.0.1:${port}`);
});

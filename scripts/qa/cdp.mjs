/**
 * A minimal Chrome DevTools Protocol driver for the v0.2.0 browser/visual QA pass.
 *
 * Flutter web renders into a canvas, so DOM queries are not a reliable way to drive
 * it. This drives the real browser instead: navigate, screenshot, click at
 * coordinates, type, screenshot again. The screenshots are the evidence — a human
 * (or the agent) inspects the actual rendered pixels.
 *
 * Deliberately dependency-free: Node 22+ ships a global `WebSocket`, so CDP is
 * reachable without adding a browser-automation package to the project.
 *
 *   node scripts/qa/cdp.mjs <url> <outDir> <script.json>
 *
 * The script is a JSON array of steps:
 *   { "screenshot": "name" }        write <outDir>/name.png
 *   { "click": [x, y] }             click at viewport coordinates
 *   { "type": "text" }              insert text into the focused field
 *   { "key": "Tab" }                press a key
 *   { "wait": 1500 }                wait milliseconds
 *   { "eval": "expression" }        evaluate JS and print the result
 *   { "console": true }             dump console messages collected so far
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [url, outDir, scriptPath] = process.argv.slice(2);
if (!url || !outDir || !scriptPath) {
  console.error("usage: node cdp.mjs <url> <outDir> <script.json>");
  process.exit(2);
}

const steps = JSON.parse(await (await import("node:fs/promises")).readFile(scriptPath, "utf8"));
mkdirSync(outDir, { recursive: true });

const DEVTOOLS = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Find or create a page target ──
const targets = await (await fetch(`${DEVTOOLS}/json/list`)).json();
let page = targets.find((t) => t.type === "page");
if (!page) {
  page = await (await fetch(`${DEVTOOLS}/json/new?about:blank`, { method: "PUT" })).json();
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const consoleMessages = [];

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    consoleMessages.push({
      type: message.params.type,
      text: (message.params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(" "),
    });
  }
  if (message.method === "Runtime.exceptionThrown") {
    consoleMessages.push({
      type: "exception",
      text: message.params.exceptionDetails?.exception?.description ?? "unknown exception",
    });
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable");

async function screenshot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`[qa] screenshot -> ${file}`);
}

for (const step of steps) {
  if (step.navigate) {
    await send("Page.navigate", { url: step.navigate });
    console.log(`[qa] navigate ${step.navigate}`);
  } else if (step.screenshot) {
    await screenshot(step.screenshot);
  } else if (step.click) {
    const [x, y] = step.click;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    console.log(`[qa] click ${x},${y}`);
  } else if (step.type !== undefined) {
    await send("Input.insertText", { text: step.type });
    console.log(`[qa] type "${step.type}"`);
  } else if (step.typetext !== undefined) {
    // Flutter web renders to a canvas and routes text through a hidden DOM input,
    // and `Input.insertText` does not reach it. Per-character key events with an
    // explicit `text` field do, which is why this exists alongside `type`.
    for (const ch of step.typetext) {
      const code = ch.charCodeAt(0);
      await send("Input.dispatchKeyEvent", {
        type: "keyDown", text: ch, unmodifiedText: ch, key: ch,
        windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
      });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    }
    console.log(`[qa] typetext ${step.typetext.length} chars`);
  } else if (step.key) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: step.key, code: step.key });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: step.key, code: step.key });
    console.log(`[qa] key ${step.key}`);
  } else if (step.wait !== undefined) {
    await sleep(step.wait);
  } else if (step.eval) {
    const result = await send("Runtime.evaluate", { expression: step.eval, returnByValue: true, awaitPromise: true });
    console.log(`[qa] eval -> ${JSON.stringify(result.result?.value ?? result.result?.description)}`);
  } else if (step.console) {
    console.log(`[qa] console messages: ${consoleMessages.length}`);
    for (const m of consoleMessages) console.log(`       [${m.type}] ${m.text}`);
  }
}

console.log(`[qa] done. console messages total: ${consoleMessages.length}`);
const errors = consoleMessages.filter((m) => m.type === "error" || m.type === "exception");
console.log(`[qa] console errors/exceptions: ${errors.length}`);
for (const e of errors) console.log(`       [${e.type}] ${e.text}`);

ws.close();
process.exit(0);

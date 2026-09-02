#!/usr/bin/env node
// WebSocket byte meter for the Convex sync socket (sync-log-cargo E8 gate).
//
// Attaches to a page in the cast browser (or any Chrome with --remote-debugging)
// over CDP, listens to Network.webSocketFrameReceived, and attributes each
// Transition's bytes to the query names it updates (learned from the
// ModifyQuerySet/Add messages the client sends). Prints per-query bytes and
// frame counts over the window, so a fat-query retirement can be measured
// before/after instead of asserted.
//
//   node scripts/perf/ws-bytes.mjs --port 62066 --url local.codecast.sh --seconds 60 --reload 1
//
// --reload 1 reloads the page after attaching so every subscription's Add
// frame (and therefore its name) is seen; without it, queries subscribed before
// the meter attached show as query#<id>.
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter(Boolean));
const PORT = args.port ?? "9222";
const URL_MATCH = args.url ?? "codecast";
const SECONDS = Number(args.seconds ?? 60);
const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.url.includes(URL_MATCH));
if (!page) { console.error("no page matching", URL_MATCH, targets.map((t) => t.url)); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const send = (method, params) => new Promise((res) => {
  const my = ++id;
  const on = (ev) => { const d = JSON.parse(ev.data); if (d.id === my) { ws.removeEventListener("message", on); res(d.result); } };
  ws.addEventListener("message", on);
  ws.send(JSON.stringify({ id: my, method, params }));
});
const queryNames = new Map(); // queryId -> udfPath
const byQuery = new Map();    // udfPath -> { bytes, frames }
let total = 0, frames = 0;
ws.addEventListener("message", (ev) => {
  const d = JSON.parse(ev.data);
  if (d.method === "Network.webSocketFrameSent") {
    try {
      const m = JSON.parse(d.params.response.payloadData);
      if (m.type === "ModifyQuerySet") for (const mod of m.modifications ?? []) if (mod.type === "Add") queryNames.set(mod.queryId, mod.udfPath);
    } catch {}
  }
  if (d.method === "Network.webSocketFrameReceived") {
    const raw = d.params.response.payloadData;
    total += raw.length; frames++;
    try {
      const m = JSON.parse(raw);
      if (m.type === "Transition") {
        for (const mod of m.modifications ?? []) {
          const name = queryNames.get(mod.queryId) ?? `query#${mod.queryId}`;
          const size = JSON.stringify(mod).length;
          const e = byQuery.get(name) ?? { bytes: 0, frames: 0 };
          e.bytes += size; e.frames += 1; byQuery.set(name, e);
        }
      }
    } catch {}
  }
});
await send("Network.enable", {});
if (args.reload === "1") { await send("Page.enable", {}); await send("Page.reload", {}); }
console.log(`measuring ${SECONDS}s on ${page.url}${args.reload === "1" ? " (after reload)" : ""}`);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const rows = [...byQuery.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
console.log(`\ntotal ${total} bytes in ${frames} frames (${(total / SECONDS).toFixed(0)} B/s)`);
console.log("query".padEnd(48), "bytes".padStart(10), "updates".padStart(8));
for (const [name, e] of rows) console.log(name.padEnd(48), String(e.bytes).padStart(10), String(e.frames).padStart(8));
ws.close(); process.exit(0);

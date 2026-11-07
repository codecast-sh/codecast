// A `claude` that replays a recorded stream-json session (recording.ts), so
// tests run the real SDK and the real host process against it: `bun
// fakeClaude.ts <claude args...>`.
//
// FAKE_CLAUDE_RECORDINGS lists recordings, comma separated; each process the
// SDK starts takes the next one (FAKE_CLAUDE_COUNTER is the file holding the
// count), so a host that dies and is resumed replays the resume recording.
// FAKE_CLAUDE_LOG, when set, gets a line per spawn, per message received and
// per mismatch. FAKE_CLAUDE_VERSION overrides the version claude reports.
//
// Replay walks the recording in order: a `claude` line is written out at
// once, an `sdk` line waits for the SDK to send a message of the same kind.
// So a recorded interrupt or mid-turn message holds the replay at exactly the
// point the real session received it, and the test decides when that comes.
// Ids the SDK picks (control request ids, the session id) are mapped onto the
// recorded ones as they arrive.

import * as fs from "node:fs";
import { createInterface } from "node:readline";
import { loadRecording } from "./recording.js";

const recordings = (process.env.FAKE_CLAUDE_RECORDINGS ?? "").split(",").filter(Boolean);
const counterFile = process.env.FAKE_CLAUDE_COUNTER;
const logFile = process.env.FAKE_CLAUDE_LOG;
const note = (line: string) => { if (logFile) fs.appendFileSync(logFile, line + "\n"); };

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.319 (Claude Code)");
  process.exit(0);
}

let index = 0;
if (counterFile) {
  try { index = Number(fs.readFileSync(counterFile, "utf-8")) || 0; } catch {}
  fs.writeFileSync(counterFile, String(index + 1));
}
const name = recordings[Math.min(index, recordings.length - 1)];
if (!name) {
  note("no recording");
  process.exit(3);
}
const flag = (f: string) => {
  const i = args.indexOf(f);
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith(`${f}=`))?.slice(f.length + 1);
};
const sessionId = flag("--session-id") ?? flag("--resume");
note(`spawn ${index} ${name} session=${sessionId} args=${args.join(" ")}`);

const { lines } = loadRecording(name);
const script = lines.filter((l) => l.from !== "spawn");

const incoming: any[] = [];
let wake: (() => void) | null = null;
let stdinEnded = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  let m: any;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === "user") note(`user priority=${m.priority ?? "-"} images=${Array.isArray(m.message?.content) ? m.message.content.filter((b: any) => b.type === "image").length : 0}`);
  else if (m.type === "control_request") note(`control ${m.request?.subtype}`);
  incoming.push(m);
  wake?.();
});
process.stdin.on("end", () => {
  stdinEnded = true;
  wake?.();
});

const kind = (m: any) => (m.type === "control_request" ? `control_request:${m.request?.subtype}` : m.type === "control_response" ? "control_response" : m.type);
const idMap = new Map<string, string>();
// Uuids the SDK gave the user messages it sent, by the recorded message's uuid: results name them.
const uuidMap = new Map<string, string>();
const recordedSession = (() => {
  for (const l of script) if (l.from === "claude" && typeof l.message.session_id === "string") return l.message.session_id as string;
  return undefined;
})();

function rewrite(message: any): any {
  let text = JSON.stringify(message);
  if (sessionId && recordedSession) text = text.split(recordedSession).join(sessionId);
  for (const [recorded, live] of uuidMap) text = text.split(recorded).join(live);
  const out = JSON.parse(text, (key, v) => (key === "claude_code_version" && process.env.FAKE_CLAUDE_VERSION ? process.env.FAKE_CLAUDE_VERSION : v));
  if (out.type === "control_response" && out.response?.request_id && idMap.has(out.response.request_id)) {
    out.response = { ...out.response, request_id: idMap.get(out.response.request_id) };
  }
  return out;
}

async function nextIncoming(): Promise<any | null> {
  for (;;) {
    const m = incoming.shift();
    if (m) return m;
    if (stdinEnded) return null;
    await new Promise<void>((r) => (wake = r));
    wake = null;
  }
}

for (const line of script) {
  if (line.from === "claude") {
    process.stdout.write(JSON.stringify(rewrite(line.message)) + "\n");
    continue;
  }
  const want = kind(line.message);
  let got = await nextIncoming();
  // The SDK may send controls the recording never saw (an extra mcp status ask);
  // skip what does not match rather than wedge, and say so.
  while (got && kind(got) !== want) {
    note(`skip ${kind(got)} waiting for ${want}`);
    got = await nextIncoming();
  }
  if (!got) {
    note(`stdin ended waiting for ${want}`);
    process.exit(0);
  }
  if (got.type === "control_request" && line.message.request_id) idMap.set(line.message.request_id, got.request_id);
  if (got.type === "user" && line.message.uuid && got.uuid) uuidMap.set(line.message.uuid, got.uuid);
}
note("script done");
// A real claude waits for more input after its last turn; stay until stdin closes.
while (await nextIncoming()) {}
process.exit(0);

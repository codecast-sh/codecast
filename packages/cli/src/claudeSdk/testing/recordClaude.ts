// A `claude` stand-in that runs the real one and records the stream-json
// traffic both ways: `bun recordClaude.ts <claude args...>`, with
// RECORD_CLAUDE_REAL (the real binary), RECORD_CLAUDE_OUT (the .jsonl to
// write) and RECORD_CLAUDE_SCENARIO. Every line is scrubbed before it is
// written (recording.ts). Used by scripts/record-claude-sdk.ts.

import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { scrub, type RecordedLine } from "./recording.js";

const real = process.env.RECORD_CLAUDE_REAL;
const out = process.env.RECORD_CLAUDE_OUT;
if (!real || !out) {
  console.error("recordClaude: RECORD_CLAUDE_REAL and RECORD_CLAUDE_OUT are required");
  process.exit(2);
}
const args = process.argv.slice(2);
const append = (line: RecordedLine) => fs.appendFileSync(out, JSON.stringify(scrub(line)) + "\n");

if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
  const version = spawn(real, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let text = "";
  version.stdout.on("data", (d) => (text += d));
  await new Promise((r) => version.on("exit", r));
  const sdk = JSON.parse(fs.readFileSync(new URL("../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url), "utf-8")).version;
  fs.writeFileSync(out, JSON.stringify({ claudeCode: text.trim().split(" ")[0] || null, sdk, date: new Date().toISOString().slice(0, 10), scenario: process.env.RECORD_CLAUDE_SCENARIO ?? "" }) + "\n");
}
append({ from: "spawn", args });

const child = spawn(real, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
createInterface({ input: process.stdin }).on("line", (line) => {
  try { append({ from: "sdk", message: JSON.parse(line) }); } catch {}
  child.stdin.write(line + "\n");
});
process.stdin.on("end", () => child.stdin.end());
createInterface({ input: child.stdout }).on("line", (line) => {
  try { append({ from: "claude", message: JSON.parse(line) }); } catch {}
  process.stdout.write(line + "\n");
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => child.kill(sig));

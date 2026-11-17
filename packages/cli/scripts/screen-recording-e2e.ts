#!/usr/bin/env bun
// A screen recording reaching a real agent, end to end, without the live
// daemon: the message a person's phone sent (the tag and their words), turned
// into the agent's copy by the daemon's own delivery step
// (screenRecordingForDelivery: the call's words from the server, keyframes cut
// on this machine), typed into a real Claude Code pane by the daemon's own
// injector, and the agent's turn read back from its transcript.
//
// Isolation, as in proto-confirm-harness: TMUX_TMPDIR (scratch tmux server),
// CODECAST_DIR (scratch state), CLAUDE_CONFIG_DIR per pane (the transcript
// lands outside ~/.claude, so nothing reaches the feed). The server is the
// real one, read with this machine's token.
//
//   TMUX_TMPDIR=/tmp/sr-e2e-tmux CODECAST_DIR=/tmp/sr-e2e/codecast \
//     bun packages/cli/scripts/screen-recording-e2e.ts <cl-N> <transcript id> "<caption>" [project dir]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { launchClaude, waitFor, sleep, tmux, turnRunning, capturePane, dialogSignature } from "./lib/claudeScratch.ts";
import { injectViaTmux } from "../src/daemon.ts";
import { readAuthConfig } from "../src/config/readAuthConfig.ts";
import { screenRecordingForDelivery } from "../src/screenRecordingBrief.ts";
import { formatScreenRecordingMessage } from "@codecast/shared/contracts";

if (!process.env.TMUX_TMPDIR?.includes("sr-e2e") || !process.env.CODECAST_DIR?.includes("sr-e2e")) {
  console.error("refusing: set TMUX_TMPDIR and CODECAST_DIR to sr-e2e scratch paths");
  process.exit(2);
}
const [call, transcriptId, caption, projectArg] = process.argv.slice(2);
if (!call || !transcriptId) {
  console.error("usage: screen-recording-e2e.ts <cl-N> <transcript id> \"<caption>\" [project dir]");
  process.exit(2);
}
const RUN = "/tmp/sr-e2e";
fs.mkdirSync(process.env.TMUX_TMPDIR, { recursive: true, mode: 0o700 });
// The machine's login, read with the machine's own state dir (its token is
// sealed under that dir's key), before the scratch dir applies.
const scratchDir = process.env.CODECAST_DIR;
delete process.env.CODECAST_DIR;
const auth = readAuthConfig(path.join(os.homedir(), ".codecast"));
process.env.CODECAST_DIR = scratchDir;
if (!auth?.auth_token || !auth.convex_url) throw new Error("not signed in on this machine");

// 1. What the phone sent, byte for byte (the composer formats it with this).
const sent = formatScreenRecordingMessage({ call, transcriptId, durationMs: 0 }, caption ?? "");
// 2. The daemon's delivery step.
const t0 = Date.now();
const out = await screenRecordingForDelivery(sent, Date.now(), { siteUrl: auth.convex_url.replace(".cloud", ".site"), apiToken: auth.auth_token }, (l) => console.log(`[delivery] ${l}`));
if (out.wait) throw new Error("the recording's words are still being read; run again in a moment");
console.log(`[delivery] ${Date.now() - t0} ms\n----- agent's copy -----\n${out.content}\n------------------------`);

// 3. A real agent in a scratch pane, working in the project the recording is about.
const projectDir = projectArg ?? path.join(RUN, "proj");
const configDir = path.join(RUN, "claude", randomUUID().slice(0, 8));
const pane = await launchClaude("sr-e2e", projectDir, configDir, ["--model", process.env.SR_MODEL ?? "sonnet", "--permission-mode", "acceptEdits", "--allowedTools", "Read", "Edit", "Glob", "Grep"]);
const first = await waitFor(pane, (s) => /I trust this folder/.test(s) || /\? for shortcuts/.test(s), 40_000);
if (first && /I trust this folder/.test(first)) {
  await sleep(800);
  for (let i = 0; i < 5 && !/❯\s+Yes, I trust/.test(await capturePane(pane)); i++) { await tmux(["send-keys", "-t", pane, "Down"]); await sleep(600); }
  await tmux(["send-keys", "-t", pane, "Enter"]);
}
if (!(await waitFor(pane, (s) => /^❯/m.test(s) && !dialogSignature(s) && /shift\+tab|for shortcuts|\? for/.test(s), 30_000))) throw new Error(`composer never ready:\n${await capturePane(pane)}`);

// 4. The daemon's injector types it in.
await injectViaTmux(pane, out.content, "claude", { delivery: { messageId: `sr-${randomUUID().slice(0, 8)}`, conversationId: "sr-e2e" } } as any);
await waitFor(pane, turnRunning, 60_000);
// The turn is over when its transcript says so (an assistant message that
// ended the turn); a permission dialog on the way is accepted.
const transcriptFiles = (): string[] => {
  const out: string[] = [];
  const walk = (d: string) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith(".jsonl")) out.push(f); } };
  walk(path.join(configDir, "projects"));
  return out;
};
const turnEnded = () => transcriptFiles().some((f) => fs.readFileSync(f, "utf8").split("\n").some((l) => l.includes('"stop_reason":"end_turn"')));
const until = Date.now() + 6 * 60_000;
while (Date.now() < until && !turnEnded()) {
  if (dialogSignature(await capturePane(pane))) await tmux(["send-keys", "-t", pane, "Enter"]);
  await sleep(2000);
}

// 5. What the agent did: every image it opened, every file it changed, its reply.
const lines = transcriptFiles().flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const summary = { images_seen: 0, tools: [] as string[], reply: "" };
for (const l of lines) {
  const content = l.message?.content;
  if (!Array.isArray(content)) continue;
  for (const c of content) {
    if (l.type === "user" && c.type === "image") summary.images_seen++;
    if (l.type === "user" && c.type === "tool_result" && Array.isArray(c.content) && c.content.some((x: any) => x.type === "image")) summary.images_seen++;
    if (c.type === "tool_use") summary.tools.push(`${c.name} ${JSON.stringify(c.input).slice(0, 140)}`);
    if (l.type === "assistant" && c.type === "text") summary.reply = c.text;
  }
}
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(RUN, "pane.txt"), await capturePane(pane));
await tmux(["kill-session", "-t", "sr-e2e"]).catch(() => {});
process.exit(0);

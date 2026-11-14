#!/usr/bin/env bun
// Stage A of the delivery-confirm repro: the daemon's own tmux delivery into a
// real Claude Code pane, then the parser and the echo ledger's stamp on the
// transcript it wrote, the way syncService.addMessages stamps before upload.
// Isolation: TMUX_TMPDIR (scratch tmux server), CODECAST_DIR (private ledger
// and journal), CLAUDE_CONFIG_DIR per pane (transcripts outside ~/.claude).
//
//   TMUX_TMPDIR=/tmp/proto-confirm-tmux CODECAST_DIR=/tmp/proto-confirm-run/codecast \
//   CODECAST_TMUX_PER_SESSION=0 bun packages/cli/scripts/proto-confirm-harness.ts [case...]
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { launchClaude, dismissDialogs, capturePane, waitFor, sleep, tmux, turnRunning, composerReady, unplantLogins, dialogSignature } from "./lib/claudeScratch.ts";
import { injectViaTmux } from "../src/daemon.ts";
import { DeliveryEchoLedger, echoCandidatesOf } from "../src/deliveryEchoLedger.ts";
import { tmuxDeliveryJournal } from "../src/tmuxDeliveryJournal.ts";
import { parseSessionFile } from "../src/parser.ts";
import { formatSessionMessage } from "@codecast/shared/contracts";

if (!process.env.TMUX_TMPDIR?.includes("proto-confirm") || !process.env.CODECAST_DIR?.includes("proto-confirm")) {
  console.error("refusing: set TMUX_TMPDIR and CODECAST_DIR to proto-confirm scratch paths");
  process.exit(2);
}
const RUN = "/tmp/proto-confirm-run";
fs.mkdirSync(process.env.TMUX_TMPDIR, { recursive: true, mode: 0o700 });
const ledger = new DeliveryEchoLedger(path.join(RUN, "ledger.sqlite"));
const journal = tmuxDeliveryJournal();
const MODEL = process.env.PROTO_MODEL ?? "haiku";

type Pane = { name: string; pane: string; configDir: string; conversationId: string };

async function startPane(name: string, allowBash: boolean): Promise<Pane> {
  const session = `proto-confirm-${name}`;
  const configDir = path.join(RUN, "claude", name);
  const projectDir = path.join(RUN, "proj", name);
  const args = ["--model", MODEL, "--permission-mode", "default"];
  if (allowBash) args.push("--allowedTools", "Bash");
  const pane = await launchClaude(session, projectDir, configDir, args);
  await tmux(["set-option", "-t", session, "remain-on-exit", "on"]).catch(() => {});
  const first = await waitFor(pane, (s) => /I trust this folder/.test(s) || /\? for shortcuts/.test(s), 30_000);
  if (first && /I trust this folder/.test(first)) {
    await sleep(800);
    for (let i = 0; i < 5 && !/❯\s+Yes, I trust/.test(await capturePane(pane)); i++) { await tmux(["send-keys", "-t", pane, "Down"]); await sleep(600); }
    await tmux(["send-keys", "-t", pane, "Enter"]);
  }
  const ready = await waitFor(pane, (s) => /^❯\s/m.test(s) && !dialogSignature(s) && /shift\+tab|for shortcuts|\? for/.test(s), 20_000);
  if (!ready) throw new Error(`${name}: composer never ready:\n${await capturePane(pane)}`);
  return { name, pane, configDir, conversationId: `conv-${name}` };
}

function transcriptOf(p: Pane): string {
  const root = path.join(p.configDir, "projects");
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith(".jsonl")) files.push(f); } };
  if (fs.existsSync(root)) walk(root);
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ? fs.readFileSync(files[0], "utf8") : "";
}

/** Type a prompt the way a person does, to put the agent in a state. */
async function prompt(p: Pane, text: string) {
  await tmux(["send-keys", "-t", p.pane, "-l", "--", text]);
  await sleep(400);
  await tmux(["send-keys", "-t", p.pane, "Enter"]);
}

type Result = { case: string; messageId: string; inject: string; injectMs: number; rawShape: string; stampedIds: string[] | null; echoed: boolean; turnTs?: string };

/** Deliver one message with the daemon's code; returns what the ledger made of it. */
async function deliver(p: Pane, label: string, body: string): Promise<{ messageId: string; inject: string; injectMs: number; marker: string }> {
  const messageId = `msg-${label}-${randomUUID().slice(0, 8)}`;
  const marker = `MARK${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const content = formatSessionMessage("jx75h6r", `${body} ${marker}`);
  const t0 = Date.now();
  let inject = "ok";
  try {
    await injectViaTmux(p.pane, content, "claude", { delivery: { messageId, conversationId: p.conversationId }, journal, echoes: ledger });
  } catch (e) { inject = `${(e as Error).constructor.name}: ${String((e as Error).message).slice(0, 160)}`; }
  return { messageId, inject, injectMs: Date.now() - t0, marker };
}

async function settle(p: Pane, label: string, d: { messageId: string; inject: string; injectMs: number; marker: string }, waitMs = 90_000): Promise<Result> {
  const until = Date.now() + waitMs;
  let raw = "";
  while (Date.now() < until) {
    raw = transcriptOf(p);
    if (raw.split("\n").some((l) => l.includes(d.marker) && /"type":"(user|attachment)"/.test(l))) break;
    await sleep(1000);
  }
  // Raw shape of the record that carries the marker.
  const lines = raw.split("\n").filter((l) => l.includes(d.marker));
  const shape = lines.map((l) => { try { const j = JSON.parse(l); return j.type === "attachment" ? `attachment:${j.attachment?.type}` : `${j.type}`; } catch { return "?"; } }).join(",") || "absent";
  // Stamp the whole parse, the way an upload stamps its batch.
  const turns = parseSessionFile(raw);
  const stamped = ledger.stamp(p.conversationId, echoCandidatesOf(turns as any));
  const hit = stamped.find((m) => m.role === "user" && m.content.includes(d.marker));
  return { case: label, messageId: d.messageId, inject: d.inject, injectMs: d.injectMs, rawShape: shape, stampedIds: hit ? (hit.deliveryIds ?? []) : null, echoed: ledger.echoed(d.messageId), turnTs: hit ? new Date(hit.timestamp).toISOString() : undefined };
}

const LOOP = "Run these as eight separate Bash tool calls, one after another, never combined: `sleep 4; echo step 1`, `sleep 4; echo step 2`, `sleep 4; echo step 3`, `sleep 4; echo step 4`, `sleep 4; echo step 5`, `sleep 4; echo step 6`, `sleep 4; echo step 7`, `sleep 4; echo step 8`. If a message arrives while you work, acknowledge it in one line and keep going.";

const cases: Record<string, () => Promise<Result[]>> = {
  async busy() {
    const p = await startPane("busy", true);
    await prompt(p, LOOP);
    await waitFor(p.pane, turnRunning, 30_000);
    await sleep(6000);
    const d = await deliver(p, "busy", "Lead here, a note while you work.");
    return [await settle(p, "busy", d)];
  },
  async idle() {
    const p = await startPane("idle", true);
    const d = await deliver(p, "idle", "Lead here, reply with one word: ok.");
    return [await settle(p, "idle", d)];
  },
  async multiline() {
    const p = await startPane("multi", true);
    await prompt(p, LOOP);
    await waitFor(p.pane, turnRunning, 30_000);
    await sleep(6000);
    const d = await deliver(p, "multiline-busy", "Lead here.\n\nLine two of the note.\n- a bullet\n- another bullet\n\nLast line.");
    return [await settle(p, "multiline-busy", d)];
  },
  async backtoback() {
    const p = await startPane("b2b", true);
    await prompt(p, LOOP);
    await waitFor(p.pane, turnRunning, 30_000);
    await sleep(6000);
    const d1 = await deliver(p, "b2b-1", "Lead here, first of two.");
    const d2 = await deliver(p, "b2b-2", "Lead here, second of two.");
    return [await settle(p, "b2b-1", d1), await settle(p, "b2b-2", d2)];
  },
  async permission() {
    const p = await startPane("perm", false);
    await prompt(p, "Run the bash command `echo hello-perm` with the Bash tool.");
    await waitFor(p.pane, (s) => /Do you want to proceed|Yes, and don't ask|❯ 1\. Yes/.test(s), 60_000);
    const d = await deliver(p, "permission", "Lead here, a note while you wait on a prompt.");
    return [await settle(p, "permission", d, 30_000)];
  },
  async killed() {
    const p = await startPane("killed", true);
    await prompt(p, LOOP);
    await waitFor(p.pane, turnRunning, 30_000);
    // The pane is gone before the delivery can submit anything.
    await tmux(["kill-session", "-t", `proto-confirm-killed`]);
    const d = await deliver(p, "killed", "Lead here, this one never lands.");
    return [await settle(p, "killed", d, 10_000)];
  },
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases);
const out: Result[] = [];
try {
  for (const name of want) {
    console.error(`--- ${name}`);
    try { const r = await cases[name]!(); out.push(...r); console.log(JSON.stringify(r)); }
    catch (e) { console.log(JSON.stringify([{ case: name, error: String(e).slice(0, 3000) }])); }
  }
} finally {
  fs.writeFileSync(path.join(RUN, `stageA-${Date.now()}.json`), JSON.stringify(out, null, 2));
  for (const name of want) await tmux(["kill-session", "-t", `proto-confirm-${name === "multiline" ? "multi" : name === "backtoback" ? "b2b" : name === "permission" ? "perm" : name}`]).catch(() => {});
  unplantLogins();
  process.exit(0);
}

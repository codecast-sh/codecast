#!/usr/bin/env bun
// Soak harness for TYPED delivery into a Claude Code pane (ct-52703).
//
//   bun packages/cli/scripts/typed-delivery-soak.ts --run <dir> [--trials 3000] [--reads 5000] [--load 8]
//
// The question. Claude Code 2.1.277 wraps every bracketed paste in a
// <pasted_content> block that strips the human's authority from their own
// words, so codecast wants to TYPE messages into Claude's composer instead.
// Typed bytes are keystrokes: a dialog (trust, /model confirmation, a tool
// permission prompt) answers a lone key, and a lone "2" approved a Bash
// permission prompt on 2026-09-19. Hand tests then showed the dialog ignores
// any read longer than one key, which suggests a rule: never write a single
// character. This harness asks whether that rule holds at scale and under
// load, where the kernel could split a write into a one byte read.
//
// Two probes, both with and without CPU load:
//  1. dialog: thousands of typed bursts into REAL Claude Code dialogs, each
//     trial compared against the dialog's on screen signature (which row the
//     cursor is on, how many rows, whether it is still up). Any change is a
//     reaction. Lone key writes run as positive controls so a silent detector
//     cannot pass as a clean run.
//  2. reads: the same write pattern into a raw stdin reader in a pane that logs
//     every read size. A one byte read of a multi byte write is the split the
//     rule cannot survive, measured at the pty layer with no TUI in the way.
//
// Isolation follows prompt-dry-run.ts: a private CLAUDE_CONFIG_DIR under the
// run directory so the transcript lands outside ~/.claude/projects (the daemon
// syncs everything there into the feed), the login handed over in the
// environment only, no hooks and no settings from the machine.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { ccKeychainReadArgs, ccKeychainReadItems, ccKeychainWriteItem } from "../src/ccKeychain.ts";

const run = promisify(execFile);

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const runDir = path.resolve(arg("run") ?? "");
if (!arg("run")) {
  console.error("usage: typed-delivery-soak.ts --run <dir> [--trials N] [--reads N] [--load N] [--only dialog|reads]");
  process.exit(2);
}
const TRIALS = Number(arg("trials", "3000"));
const READS = Number(arg("reads", "5000"));
const LOAD = Number(arg("load", "8"));
const ONLY = arg("only");
const SESSION = "soak-typed";
const PANE = `${SESSION}:0.0`;
const CLAUDE = process.env.SOAK_CLAUDE ?? "claude";

// ---- the candidate delivery rule -------------------------------------------
// One `send-keys -l` per chunk with the newline bytes inside, never a chunk of
// one character. tmux refuses an argument near 16 KB ("command too long");
// 8 KB is accepted.
const CHUNK = 8192;
function chunksFor(payload: string): string[] {
  let text = payload.length === 1 ? `${payload} ` : payload;
  const out: string[] = [];
  for (let at = 0; at < text.length; at += CHUNK) out.push(text.slice(at, at + CHUNK));
  // A trailing chunk of one character is the case the rule forbids: move one
  // character from the previous chunk into it.
  if (out.length > 1 && out[out.length - 1]!.length === 1) {
    const prev = out[out.length - 2]!;
    out[out.length - 2] = prev.slice(0, -1);
    out[out.length - 1] = prev.slice(-1) + out[out.length - 1];
  }
  return out;
}

// ---- tmux ------------------------------------------------------------------
async function tmux(args: string[]): Promise<string> {
  const { stdout } = await run("tmux", args, { maxBuffer: 1 << 24 });
  return stdout;
}
const capture = () => tmux(["capture-pane", "-p", "-t", PANE, "-S", "-45"]);
// `--` ends tmux option parsing: without it a payload that starts with "-"
// ("-1", "- fix the thing") is read as a flag and the send fails.
const sendLiteral = (text: string) => tmux(["send-keys", "-t", PANE, "-l", "--", text]);
const sendKey = (key: string) => tmux(["send-keys", "-t", PANE, key]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- payloads ----------------------------------------------------------------
// Realistic message bodies, biased toward what a person types: short lines,
// digits, y/n answers, a few long briefs, tabs, leading command characters.
const TAILS = ["1", "2", "3", "4", "y", "n", "Y", "N", " ", "\n", "\t", "a", ".", "?", "!", "/", "#", "@", "-"];
const WORDS = "please check the auth flow and report what you find before the deploy tonight ok thanks".split(" ");
function rnd(n: number): number { return Math.floor(Math.random() * n); }
function pick<T>(xs: T[]): T { return xs[rnd(xs.length)]!; }
function body(len: number): string {
  let s = "";
  while (s.length < len) s += (rnd(9) === 0 ? "\n" : " ") + pick(WORDS);
  return s.slice(0, len);
}
type Payload = { text: string; kind: string };
function nextPayload(i: number): Payload {
  const r = rnd(100);
  if (r < 25) return { text: pick(TAILS), kind: "one-char" };            // the rule pads these
  if (r < 45) return { text: pick(TAILS) + pick(TAILS), kind: "two-char" };
  if (r < 80) return { text: body(2 + rnd(200)) + pick(TAILS), kind: "short" };
  if (r < 95) return { text: body(200 + rnd(2000)) + pick(TAILS), kind: "medium" };
  // Long: lands on chunk boundaries on purpose (8191, 8192, 8193 and beyond).
  const len = [8190, 8191, 8192, 8193, 8194, 12000, 16000 + rnd(2000)][i % 7]!;
  return { text: body(len) + pick(TAILS), kind: "long" };
}

// ---- load ------------------------------------------------------------------
const loaders: ChildProcess[] = [];
function loadOn(n: number) {
  for (let i = 0; i < n; i++) loaders.push(spawn("sh", ["-c", "yes > /dev/null"], { stdio: "ignore" }));
}
function loadOff() { for (const p of loaders.splice(0)) p.kill("SIGKILL"); }
process.on("exit", loadOff);

// ---- dialog probe ----------------------------------------------------------
// A select dialog on screen: an indented cursor row "❯ text" with sibling rows
// at the same text column (the trust dialog has no numbers; permission and
// model dialogs do). The composer's own "❯" sits at column 0 and never
// matches. The signature is what a reaction would change: whether the dialog
// is up, which row the cursor is on, how many rows there are, the first row.
function dialogSignature(pane: string): string | null {
  const lines = pane.split("\n");
  let cursorAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s+❯\s+\S/.test(lines[i]!)) { cursorAt = i; break; }
  }
  if (cursorAt === -1) return null;
  const col = lines[cursorAt]!.search(/❯\s+\S/) + lines[cursorAt]!.match(/❯\s+/)![0].length;
  const isRow = (l: string) => l.length > col && /^\s*$/.test(l.slice(0, col).replace("❯", " ")) && /\S/.test(l[col]!);
  const rows = lines.slice(Math.max(0, cursorAt - 8), cursorAt + 9).filter(isRow);
  if (rows.length < 2) return null;
  return JSON.stringify([lines[cursorAt]!.trim(), rows.length, rows[0]!.trim()]);
}

// The interactive TUI ignores CLAUDE_CODE_OAUTH_TOKEN and reads the keychain
// item scoped to its config dir (ccKeychain.ts), so the machine login is copied
// under that name for the run and removed at the end.
let plantedService: string | null = null;
function plantLogin(configDir: string): void {
  let blob: string | null = null;
  for (const item of ccKeychainReadItems(undefined)) {
    const r = spawnSync("security", ccKeychainReadArgs(item), { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) { blob = r.stdout.trim(); break; }
  }
  if (!blob) throw new Error("no Claude Code login in the keychain; run `claude` once on this machine");
  const item = ccKeychainWriteItem(configDir);
  // -A: an item `security` creates is readable only by `security` unless the
  // ACL says otherwise, and claude's read then fails without a word.
  const r = spawnSync("security", ["add-generic-password", "-U", "-A", "-a", item.account, "-s", item.service, "-w", blob], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`could not plant the scoped login: ${r.stderr}`);
  plantedService = item.service;
}
function unplantLogin(): void {
  if (!plantedService) return;
  spawnSync("security", ["delete-generic-password", "-s", plantedService], { encoding: "utf8" });
  plantedService = null;
}
process.on("exit", unplantLogin);

const DROP = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODECAST_LAUNCH_TOKEN", "CODECAST_SESSION_ID", "TMUX", "TMUX_PANE", "CLAUDE_CONFIG_DIR"]);

async function launchClaude(projectDir: string, configDir: string): Promise<void> {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  // Onboarding done, so a launch opens on the folder trust dialog rather than
  // the text style picker and the login method screen.
  const state = path.join(configDir, ".claude.json");
  if (!fs.existsSync(state)) fs.writeFileSync(state, JSON.stringify({ hasCompletedOnboarding: true, theme: "dark" }));
  try { await tmux(["kill-session", "-t", SESSION]); } catch { /* none */ }
  const envArgs: string[] = [];
  for (const k of DROP) envArgs.push("-e", `${k}=`);
  if (!plantedService) plantLogin(configDir);
  envArgs.push("-e", `CLAUDE_CONFIG_DIR=${configDir}`);
  await tmux(["new-session", "-d", "-s", SESSION, "-x", "180", "-y", "45", "-c", projectDir, ...envArgs,
    `${CLAUDE} --model sonnet --permission-mode default --setting-sources project`]);
}

async function waitFor(test: (pane: string) => boolean, timeoutMs: number, everyMs = 500): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const pane = await capture();
    if (test(pane)) return pane;
    await sleep(everyMs);
  }
  return null;
}

const composerReady = (p: string) => /^❯\s*$/m.test(p) && !dialogSignature(p);

// Each dialog kind knows how to raise itself and how to recover after a reaction.
type Dialog = { name: string; raise: () => Promise<boolean>; costly: boolean; control: string };

// Press Enter through whatever first-launch dialogs are up (text style, trust)
// until the composer is ready. Enter takes each dialog's highlighted default.
async function dismissDialogs(): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    const pane = await capture();
    if (composerReady(pane)) return true;
    // The trust dialog defaults to "No, exit": move to the trust row first.
    if (/I trust this folder/.test(pane) && /❯\s+No, exit/.test(pane)) await sendKey("Down");
    await sendKey("Enter");
    await sleep(1500);
  }
  return !!(await waitFor(composerReady, 30_000));
}

function dialogs(projectDir: string, configDir: string): Dialog[] {
  let trustDirs = 0;
  return [
    {
      name: "first-launch",
      costly: false,
      // No numbered rows here: the lone key that acts is Enter, so the control
      // is a bare newline byte, which takes "No, exit" and costs a relaunch.
      control: "\n",
      // A fresh project under a fresh config dir opens a dialog before any model
      // turn: onboarding (text style) and then the folder trust question. Any
      // select dialog serves; the log records which one by its first row.
      raise: async () => {
        const dir = path.join(projectDir, `launch-${++trustDirs}`);
        await launchClaude(dir, configDir);
        return !!(await waitFor((p) => !!dialogSignature(p), 30_000));
      },
    },
    {
      name: "model-confirm",
      costly: false,
      control: "2",
      // "/model opus" asks to confirm the switch; "No, go back" is row 2 and
      // costs nothing, so the control always picks it and the model never moves.
      raise: async () => {
        if (!(await dismissDialogs())) return false;
        await sendLiteral("/model opus");
        await sleep(300);
        await sendKey("Enter");
        return !!(await waitFor((p) => /Switch model\?/.test(p) && !!dialogSignature(p), 15_000));
      },
    },
    {
      name: "permission",
      costly: true,
      // One model turn per raise. The command is a harmless touch inside the
      // run directory; an approval only ever writes there.
      control: "4",
      raise: async () => {
        if (!(await dismissDialogs())) return false;
        const target = path.join(projectDir, `perm-${Date.now()}.txt`);
        await sendLiteral(`Run exactly this bash command and nothing else: touch ${target}`);
        await sleep(300);
        await sendKey("Enter");
        return !!(await waitFor((p) => /Do you want to proceed\?/.test(p) && !!dialogSignature(p), 120_000, 1000));
      },
    },
  ];
}

type Trial = { i: number; dialog: string; kind: string; len: number; chunks: number[]; tail: string; load: boolean; control: boolean; reaction: string | null; ms: number };

async function dialogProbe(log: fs.WriteStream): Promise<{ trials: number; reactions: Trial[]; controls: number; controlsReacted: number }> {
  const projectDir = path.join(runDir, "project");
  const configDir = path.join(runDir, ".claude");
  const ds = dialogs(projectDir, configDir);
  const reactions: Trial[] = [];
  let controls = 0, controlsReacted = 0, trials = 0;

  // Budget: the trust dialog and the model dialog are free, so they carry most
  // trials; the permission prompt gets a fixed slice because each raise is a
  // model turn.
  // The /model confirmation only appears once the conversation has a cached
  // turn behind it, so the permission prompt (one model turn) goes first.
  const plan: Array<[Dialog, number]> = [
    [ds[0]!, Math.round(TRIALS * 0.35)],
    [ds[2]!, TRIALS - Math.round(TRIALS * 0.35) - Math.round(TRIALS * 0.45)],
    [ds[1]!, Math.round(TRIALS * 0.45)],
  ];
  // Positive controls: one lone key every 100 trials on the free dialogs.
  for (const [dialog, count] of plan) {
    if (!(await dialog.raise())) { console.error(`could not raise ${dialog.name}`); continue; }
    let sig = dialogSignature(await capture());
    let load = false;
    for (let n = 0; n < count; n++) {
      if (n % 250 === 0) { loadOff(); load = n % 500 === 250; if (load) loadOn(LOAD); }
      if (!sig) {
        // The dialog is gone (a reaction, or the pane moved on): put it back.
        await sendKey("C-u");
        if (!(await dialog.raise())) { console.error(`lost ${dialog.name}`); break; }
        sig = dialogSignature(await capture());
        if (!sig) break;
      }
      const control = !dialog.costly && n % 100 === 50;
      const payload: Payload = control ? { text: dialog.control, kind: "control" } : nextPayload(n);
      const chunks = control ? [payload.text] : chunksFor(payload.text);
      const t0 = Date.now();
      // The payload goes to the log BEFORE it is sent: a burst that kills the
      // pane (a lone newline read takes "No, exit" on the trust dialog) must
      // still be on record.
      log.write(JSON.stringify({ pre: trials + 1, dialog: dialog.name, kind: payload.kind, chunks: chunks.map((c) => c.length), tail: JSON.stringify(payload.text.slice(-1)), load }) + "\n");
      let reaction: string | null;
      try {
        for (const c of chunks) await sendLiteral(c);
        await sleep(60);
        let after = dialogSignature(await capture());
        if (after !== sig) { await sleep(400); after = dialogSignature(await capture()); }
        reaction = after === sig ? null : (after === null ? "dialog gone" : `moved: ${after}`);
      } catch (err) {
        reaction = `pane gone: ${String((err as Error).message).split("\n")[0]}`;
      }
      const trial: Trial = {
        i: ++trials, dialog: dialog.name, kind: payload.kind, len: payload.text.length, chunks: chunks.map((c) => c.length),
        tail: JSON.stringify(payload.text.slice(-1)), load, control, reaction, ms: Date.now() - t0,
      };
      log.write(JSON.stringify(trial) + "\n");
      if (control) { controls++; if (reaction) controlsReacted++; }
      else if (reaction) { reactions.push(trial); console.error(`REACTION #${reactions.length}: ${JSON.stringify(trial)}`); }
      if (reaction) sig = null; else if (trials % 100 === 0) process.stderr.write(`  ${trials} trials, ${reactions.length} reactions\n`);
    }
    loadOff();
  }
  try { await tmux(["kill-session", "-t", SESSION]); } catch { /* gone */ }
  return { trials, reactions, controls, controlsReacted };
}

// ---- read size probe -------------------------------------------------------
// A raw stdin reader in the pane, same tmux transport, logging every read's
// byte length. Bun, because Claude Code runs on Bun.
const READER = `
process.stdin.setRawMode(true);
const out = require("node:fs").createWriteStream(process.argv[2], { flags: "a" });
process.stdin.on("data", (b) => { out.write(b.length + "\\n"); if (b.length === 1 && b[0] === 0x03) process.exit(0); });
`;

async function readsProbe(): Promise<{ writes: number; reads: number; oneByteReads: number; oneByteFromMulti: number; splits: number }> {
  const readerFile = path.join(runDir, "reader.ts");
  const sizesFile = path.join(runDir, "reads.txt");
  fs.writeFileSync(readerFile, READER);
  fs.writeFileSync(sizesFile, "");
  try { await tmux(["kill-session", "-t", SESSION]); } catch { /* none */ }
  await tmux(["new-session", "-d", "-s", SESSION, "-x", "180", "-y", "45", `bun ${readerFile} ${sizesFile}`]);
  await sleep(1500);
  const writes: number[] = [];
  let load = false;
  for (let n = 0; n < READS; n++) {
    if (n % 250 === 0) { loadOff(); load = n % 500 === 250; if (load) loadOn(LOAD); }
    const p = nextPayload(n);
    for (const c of chunksFor(p.text)) { await sendLiteral(c); writes.push(Buffer.byteLength(c)); }
    if (n % 500 === 0) process.stderr.write(`  ${n} writes\n`);
  }
  loadOff();
  await sleep(2000);
  await sendKey("C-c");
  await sleep(500);
  const reads = fs.readFileSync(sizesFile, "utf8").split("\n").filter(Boolean).map(Number);
  // A read is a split when it does not match a write boundary: walk both lists.
  let wi = 0, acc = 0, splits = 0, oneByteFromMulti = 0;
  const oneByteCases: Array<{ write: number; previous: number | null }> = [];
  for (const r of reads) {
    acc += r;
    if (r === 1 && writes[wi] !== undefined && writes[wi]! > 1) {
      oneByteFromMulti++;
      if (oneByteCases.length < 50) oneByteCases.push({ write: writes[wi]!, previous: wi > 0 ? writes[wi - 1]! : null });
    }
    while (wi < writes.length && acc >= writes[wi]!) { acc -= writes[wi]!; wi++; }
    if (acc !== 0) splits++;
  }
  fs.writeFileSync(path.join(runDir, "one-byte-cases.json"), JSON.stringify(oneByteCases, null, 2));
  return { writes: writes.length, reads: reads.length, oneByteReads: reads.filter((r) => r === 1).length, oneByteFromMulti, splits };
}

// ---- main --------------------------------------------------------------------
fs.mkdirSync(runDir, { recursive: true });
const summary: Record<string, unknown> = { startedAt: new Date().toISOString(), trials: TRIALS, reads: READS, load: LOAD };
if (ONLY !== "reads") {
  const log = fs.createWriteStream(path.join(runDir, "trials.jsonl"), { flags: "w" });
  const r = await dialogProbe(log);
  log.end();
  summary.dialog = { trials: r.trials, reactions: r.reactions.length, controls: r.controls, controlsReacted: r.controlsReacted, reactionsDetail: r.reactions };
  console.log(`dialog: ${r.trials} trials, ${r.reactions.length} reactions; controls ${r.controlsReacted}/${r.controls} reacted`);
}
if (ONLY !== "dialog") {
  const r = await readsProbe();
  summary.reads = r;
  console.log(`reads: ${r.writes} writes became ${r.reads} reads; ${r.splits} reads off a write boundary; ${r.oneByteFromMulti} one byte reads out of a longer write`);
}
summary.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
loadOff();
unplantLogin();
try { await tmux(["kill-session", "-t", SESSION]); } catch { /* gone */ }

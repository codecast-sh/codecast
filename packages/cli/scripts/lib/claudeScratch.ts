// A throwaway interactive Claude Code session in a tmux pane, isolated from the
// machine: a private CLAUDE_CONFIG_DIR under the run directory (its transcript
// lands outside ~/.claude/projects, which the daemon syncs into the feed), the
// machine login copied under the keychain name that config dir reads, no hooks
// and no settings from the machine. Shared by the delivery harnesses under
// scripts/ (typed-delivery-soak.ts, paste-authority-ablation.ts).
//
// The interactive TUI ignores CLAUDE_CODE_OAUTH_TOKEN and reads the keychain
// item scoped to its config dir (src/ccKeychain.ts). An item that `security`
// creates is readable only by `security` unless the ACL says otherwise (-A),
// and claude's read then fails without a word and opens the login screen.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { ccKeychainReadArgs, ccKeychainReadItems, ccKeychainWriteItem } from "../../src/ccKeychain.ts";

const run = promisify(execFile);

export async function tmux(args: string[]): Promise<string> {
  const { stdout } = await run("tmux", args, { maxBuffer: 1 << 24 });
  return stdout;
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const planted = new Set<string>();
export function plantLogin(configDir: string): void {
  let blob: string | null = null;
  for (const item of ccKeychainReadItems(undefined)) {
    const r = spawnSync("security", ccKeychainReadArgs(item), { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) { blob = r.stdout.trim(); break; }
  }
  if (!blob) throw new Error("no Claude Code login in the keychain; run `claude` once on this machine");
  const item = ccKeychainWriteItem(configDir);
  if (planted.has(item.service)) return;
  const r = spawnSync("security", ["add-generic-password", "-U", "-A", "-a", item.account, "-s", item.service, "-w", blob], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`could not plant the scoped login: ${r.stderr}`);
  planted.add(item.service);
}
export function unplantLogins(): void {
  for (const service of planted) spawnSync("security", ["delete-generic-password", "-s", service], { encoding: "utf8" });
  planted.clear();
}
process.on("exit", unplantLogins);

/**
 * A config dir that opens straight on the folder trust dialog: onboarding done,
 * and the paste wrapper flag cached the way the machine's own config dir has
 * it, so a session here pastes the way a real one does (the flag is fetched
 * remotely; a fresh dir would otherwise start without it).
 */
export function seedConfigDir(configDir: string, opts: { claudeMd?: string; settings?: object } = {}): void {
  fs.mkdirSync(configDir, { recursive: true });
  const state = path.join(configDir, ".claude.json");
  if (!fs.existsSync(state)) {
    let features: Record<string, unknown> = {};
    try {
      const machine = JSON.parse(fs.readFileSync(path.join(process.env.HOME ?? "", ".claude.json"), "utf8"));
      features = machine.cachedGrowthBookFeatures ?? {};
    } catch { /* no machine cache */ }
    fs.writeFileSync(state, JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      cachedGrowthBookFeatures: features,
      cachedGrowthBookFeaturesAt: Date.now(),
    }));
  }
  if (opts.claudeMd !== undefined) fs.writeFileSync(path.join(configDir, "CLAUDE.md"), opts.claudeMd);
  if (opts.settings !== undefined) fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(opts.settings, null, 2));
}

const DROP = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODECAST_LAUNCH_TOKEN", "CODECAST_SESSION_ID", "TMUX", "TMUX_PANE", "CLAUDE_CONFIG_DIR"];

/** Start claude in a fresh tmux session; the pane is `${session}:0.0`. */
export async function launchClaude(session: string, projectDir: string, configDir: string, claudeArgs: string[]): Promise<string> {
  fs.mkdirSync(projectDir, { recursive: true });
  seedConfigDir(configDir);
  plantLogin(configDir);
  try { await tmux(["kill-session", "-t", session]); } catch { /* none */ }
  const envArgs: string[] = [];
  for (const k of DROP) envArgs.push("-e", `${k}=`);
  envArgs.push("-e", `CLAUDE_CONFIG_DIR=${configDir}`);
  const claude = process.env.SCRATCH_CLAUDE ?? "claude";
  await tmux(["new-session", "-d", "-s", session, "-x", "180", "-y", "45", "-c", projectDir, ...envArgs, `${claude} ${claudeArgs.join(" ")}`]);
  return `${session}:0.0`;
}

export const capturePane = (pane: string) => tmux(["capture-pane", "-p", "-t", pane, "-S", "-45"]);
export const sendKey = (pane: string, key: string) => tmux(["send-keys", "-t", pane, key]);
// `--` ends tmux option parsing: without it a payload that starts with "-"
// ("-1", "- fix the thing") is read as a flag and the send fails.
export const sendLiteral = (pane: string, text: string) => tmux(["send-keys", "-t", pane, "-l", "--", text]);

/** A bracketed paste through a tmux buffer, the way the daemon delivers. */
export async function pasteIntoPane(pane: string, text: string): Promise<void> {
  const file = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "scratch-paste-")), "payload");
  fs.writeFileSync(file, text, { mode: 0o600 });
  const id = `scratch-${process.pid}-${Date.now()}`;
  try {
    await tmux(["load-buffer", "-b", id, file]);
    await tmux(["paste-buffer", "-p", "-t", pane, "-b", id, "-d"]);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

/**
 * A select dialog on screen: an indented cursor row "❯ text" with sibling rows
 * at the same text column (the trust dialog has no numbers; permission and
 * model dialogs do). The composer's own "❯" sits at column 0 and never
 * matches. The signature is what a reaction would change: whether the dialog
 * is up, which row the cursor is on, how many rows there are, the first row.
 */
export function dialogSignature(pane: string): string | null {
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

export const composerReady = (p: string) => /^❯\s*$/m.test(p) && !dialogSignature(p);
export const turnRunning = (p: string) => /esc to interrupt/.test(p);

export async function waitFor(pane: string, test: (p: string) => boolean, timeoutMs: number, everyMs = 500): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const p = await capturePane(pane);
    if (test(p)) return p;
    await sleep(everyMs);
  }
  return null;
}

/**
 * Press through whatever dialogs are up (trust, security notes) until the
 * composer is ready. The trust dialog defaults to "No, exit", so it needs a
 * Down first.
 */
export async function dismissDialogs(pane: string): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    const p = await capturePane(pane);
    if (composerReady(p)) return true;
    if (/I trust this folder/.test(p) && /❯\s+No, exit/.test(p)) await sendKey(pane, "Down");
    await sendKey(pane, "Enter");
    await sleep(1500);
  }
  return !!(await waitFor(pane, composerReady, 30_000));
}

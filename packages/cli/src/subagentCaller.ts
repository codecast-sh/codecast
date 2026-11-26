// Which agent of a Claude Code session issued the `cast` command running now.
//
// A Task-tool subagent (or a Workflow tool's agent) runs inside its parent's
// Claude process and its Bash calls get the parent's environment,
// CLAUDE_CODE_SESSION_ID included, so neither the environment nor the process
// tree tells the session's own agent from one of its subagents. The
// transcripts do: Claude Code writes every tool call to the transcript of the
// agent that made it before running it. A subagent's goes under
// <session>/subagents/ (a Workflow tool's agents one level down, in
// workflows/wf_*/), each entry carrying its `agentId`. The newest Bash call
// made just before this process started whose command names this process's
// words is the one that ran it.
//
// A call whose text does not spell the arguments out (a script that runs cast,
// a `$VAR`, a loop) is found nowhere, and the command counts as the session's
// own: a subagent that calls cast that way still adopts its parent.

import * as fs from "fs";
import * as path from "path";
import { claudeProjectsDirs } from "./claudeConfigDirs.js";

const TAIL_BYTES = 512 * 1024;
/** How long before this process started the call that started it can have been written: the PreToolUse hooks
 *  (10s timeouts each) and the shell's startup run in between, on a machine that may be heavily loaded. */
const BEFORE_START_MS = 30_000;
/** Clock skew allowed after the start: a call written later than this ran some other process. */
const AFTER_START_MS = 2_000;
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const BEFORE = /[\s'"=(;&|`]/;
const AFTER = /[\s'";&|)`]/;

/** Whether `command` (a Bash tool call's text) runs a process with these arguments: each plain argument appears
 *  as a word, in order. Arguments a shell would quote or expand are skipped, since their spelling in the text varies. */
export function commandRuns(command: string, args: string[]): boolean {
  const words = args.filter((a) => PLAIN.test(a));
  if (!words.length) return false;
  let from = 0;
  for (const w of words) {
    let at = command.indexOf(w, from);
    while (at >= 0 && !((at === 0 || BEFORE.test(command[at - 1]!)) && (at + w.length === command.length || AFTER.test(command[at + w.length]!)))) {
      at = command.indexOf(w, at + 1);
    }
    if (at < 0) return false;
    from = at + w.length;
  }
  return true;
}

function tail(file: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

type Call = { at: number; agentId: string | null };

/** The newest Bash call in `text` (transcript lines) made in [from, to] that runs `args`: its time and, when a
 *  subagent made it, that agent's id. */
function newestCall(text: string, args: string[], from: number, to: number): Call | null {
  let best: Call | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    const at = Date.parse(entry.timestamp ?? "");
    if (!(at >= from && at <= to)) continue;
    const ran = entry.message.content.some((b: any) => b?.type === "tool_use" && b.name === "Bash" && typeof b.input?.command === "string" && commandRuns(b.input.command, args));
    if (!ran) continue;
    const agentId = entry.agentId ? String(entry.agentId) : entry.isSidechain ? "subagent" : null;
    if (!best || at >= best.at) best = { at, agentId };
  }
  return best;
}

/** Every subagent transcript under a session's subagents dir: a Task tool's, and a Workflow tool's one level down. */
function subagentTranscripts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
      else if (e.isDirectory() && depth < 2) walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * The id of the subagent of `sessionId` that issued this command, or null when the session's own agent did, or when
 * no transcript names the call (a script that calls cast, a hook): then nothing says a subagent asked.
 */
export function subagentCalling(
  sessionId: string,
  args: string[],
  opts: { projectsDirs: string[]; startedAt?: number },
): string | null {
  const startedAt = opts.startedAt ?? Date.now() - process.uptime() * 1000;
  const from = startedAt - BEFORE_START_MS;
  const to = startedAt + AFTER_START_MS;
  for (const projects of opts.projectsDirs) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(projects); } catch { continue; }
    for (const d of dirs) {
      const main = path.join(projects, d, `${sessionId}.jsonl`);
      if (!fs.existsSync(main)) continue;
      // A session that never ran a subagent, or none lately, has no transcript but its own that could hold the call.
      const recent = subagentTranscripts(path.join(projects, d, sessionId, "subagents"))
        .filter((f) => { try { return fs.statSync(f).mtimeMs >= from; } catch { return false; } });
      if (!recent.length) return null;
      let best: Call | null = null;
      for (const f of [main, ...recent]) {
        const call = newestCall(tail(f), args, from, to);
        if (call && (!best || call.at > best.at)) best = call;
      }
      return best?.agentId ?? null;
    }
  }
  return null;
}

const asked = new Map<string, string | null>();
/** subagentCalling for this process (its own argv and start), once per session. */
export function subagentOf(sessionId: string): string | null {
  if (!asked.has(sessionId)) asked.set(sessionId, subagentCalling(sessionId, process.argv.slice(2), { projectsDirs: claudeProjectsDirs() }));
  return asked.get(sessionId)!;
}

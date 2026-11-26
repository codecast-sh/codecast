// Which agent of a Claude Code session issued the `cast` command running now.
//
// A Task-tool subagent runs inside its parent's Claude process and its Bash
// calls get the parent's environment, CLAUDE_CODE_SESSION_ID included, so
// neither the environment nor the process tree tells the session's own agent
// from one of its subagents. The transcripts do: Claude Code writes every tool
// call to the transcript of the agent that made it before running it, a
// subagent's to <session>/subagents/agent-<id>.jsonl with `isSidechain: true`
// and its `agentId` on each entry. The newest Bash call whose command names
// this process's words is the one that ran it.

import * as fs from "fs";
import * as path from "path";

const TAIL_BYTES = 512 * 1024;
/** A subagent transcript written this long before the command started can still hold the call that started it. */
const RECENT_MS = 120_000;
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

/** The newest Bash call in `text` (transcript lines) that runs `args`: its time and, when a subagent made it, that agent's id. */
function newestCall(text: string, args: string[]): { at: number; agentId: string | null } | null {
  let best: { at: number; agentId: string | null } | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const ran = content.some((b: any) => b?.type === "tool_use" && b.name === "Bash" && typeof b.input?.command === "string" && commandRuns(b.input.command, args));
    if (!ran) continue;
    const at = Date.parse(entry.timestamp ?? "") || 0;
    if (!best || at >= best.at) best = { at, agentId: entry.isSidechain ? String(entry.agentId || "subagent") : null };
  }
  return best;
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
  for (const projects of opts.projectsDirs) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(projects); } catch { continue; }
    for (const d of dirs) {
      const main = path.join(projects, d, `${sessionId}.jsonl`);
      if (!fs.existsSync(main)) continue;
      // A session that never ran a subagent has no subagents dir: its own agent asked.
      const subDir = path.join(projects, d, sessionId, "subagents");
      let subs: string[] = [];
      try { subs = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(subDir, f)); } catch { return null; }
      const recent = subs.filter((f) => { try { return fs.statSync(f).mtimeMs >= startedAt - RECENT_MS; } catch { return false; } });
      if (!recent.length) return null;
      let best: { at: number; agentId: string | null } | null = null;
      for (const f of [main, ...recent]) {
        const call = newestCall(tail(f), args);
        if (call && (!best || call.at > best.at)) best = call;
      }
      return best?.agentId ?? null;
    }
  }
  return null;
}

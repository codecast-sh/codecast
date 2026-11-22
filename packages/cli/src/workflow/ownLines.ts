// A session's own lines in a file another session also changed (flows.md FL4).
//
// Attribution is per file (land/attribute.ts), so a file two sessions edited
// in a shared checkout holds both of their lines, and freezing it whole puts
// the other session's lines in this session's change. The session's own
// version is rebuilt from the file at the freeze's base by replaying, in
// order, its Edit and MultiEdit calls on that file made after the file's last
// commit. Every other session that wrote the file since is replayed the same
// way, and the cut is used only when the frozen file is fully accounted for:
// the session's version merged with each other writer's reproduces it exactly.
// A line nobody's replay explains (one of the session's own from before the
// file's last commit that the commit left out, a formatter's, a script's)
// fails that, so it is never dropped from both changes. A writer replays only
// as a Claude session with no Write or shell command of the file, every edit
// landing on exactly one place, and its newest replayed edit being the newest
// write attribution saw. Anything else keeps the whole file, as before, and
// says why.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shellWrites, type SessionEdits } from "../land/attribute.js";
import { getAllSyncRecords } from "../syncLedger.js";

type Replace = { old_string: string; new_string: string; replace_all?: boolean };
export type WriteOp = { at: number; edits: Replace[] } | { at: number; other: string };
export type OwnCut = { ok: true; content: string } | { ok: false; why: string };

const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell", "container.exec"]);

/** The repo-relative path `p` names, under `root` as given or as its real path. */
function relTo(root: string, p: string): string | null {
  for (const base of new Set([root, realOr(root)])) {
    const rel = path.relative(base, realOr(p));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
    const direct = path.relative(base, p);
    if (direct && !direct.startsWith("..") && !path.isAbsolute(direct)) return direct.split(path.sep).join("/");
  }
  return null;
}
function realOr(p: string): string {
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; }
}

/** Every write the transcripts show to `rel` after `since`, oldest first; calls whose result was an error are left out. */
export function writesTo(transcripts: string[], root: string, rel: string, since: number): WriteOp[] {
  const ops: Array<WriteOp & { id: string }> = [];
  const failed = new Set<string>();
  const name = path.basename(rel);
  for (const file of transcripts) {
    let text: string;
    try { text = fs.readFileSync(file, "utf-8"); } catch { continue; }
    let cwd = root;
    for (const line of text.split("\n")) {
      if (!line) continue;
      const isError = line.includes("\"is_error\":true");
      if (!isError && !(line.includes("\"tool_use\"") && line.includes(name))) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (typeof obj?.cwd === "string") cwd = obj.cwd;
      const at = Date.parse(obj?.timestamp) || 0;
      for (const block of Array.isArray(obj?.message?.content) ? obj.message.content : []) {
        if (block?.type === "tool_result" && block.is_error) failed.add(String(block.tool_use_id));
        if (block?.type !== "tool_use" || at <= since) continue;
        const input = block.input ?? {};
        const id = String(block.id);
        if (block.name === "Edit" || block.name === "MultiEdit" || block.name === "Write" || block.name === "NotebookEdit") {
          const p = input.file_path ?? input.notebook_path;
          if (typeof p !== "string" || relTo(root, path.resolve(cwd, p)) !== rel) continue;
          if (block.name === "Edit") ops.push({ id, at, edits: [input] });
          else if (block.name === "MultiEdit" && Array.isArray(input.edits)) ops.push({ id, at, edits: input.edits });
          else ops.push({ id, at, other: `a ${block.name} call` });
        } else if (SHELL_TOOLS.has(block.name) && typeof input.command === "string" && shellWrites(input.command, cwd, root).includes(rel)) {
          ops.push({ id, at, other: "a shell command" });
        }
      }
    }
  }
  return ops.filter((op) => !failed.has(op.id)).sort((a, b) => a.at - b.at).map(({ id: _id, ...op }) => op);
}

/** `base` with the session's edits applied in order, or why they cannot be. */
export function replayEdits(base: string, ops: WriteOp[]): OwnCut {
  let content = base;
  for (const op of ops) {
    if ("other" in op) return { ok: false, why: `${op.other} wrote it` };
    for (const e of op.edits) {
      if (typeof e?.old_string !== "string" || typeof e?.new_string !== "string" || !e.old_string) return { ok: false, why: "an edit without a string to replace" };
      const n = content.split(e.old_string).length - 1;
      if (n === 0 || (n > 1 && !e.replace_all)) return { ok: false, why: "an edit no longer lands on one place in the committed file" };
      content = e.replace_all ? content.split(e.old_string).join(e.new_string) : content.replace(e.old_string, () => e.new_string);
    }
  }
  return { ok: true, content };
}

/** `ours` and `theirs`, two versions of `base`, merged three ways; null when their changes touch the same lines. */
export function merge3(ours: string, base: string, theirs: string): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-own-lines-"));
  try {
    const [a, b, c] = ["ours", "base", "theirs"].map((n) => path.join(dir, n));
    fs.writeFileSync(a, ours);
    fs.writeFileSync(b, base);
    fs.writeFileSync(c, theirs);
    const r = spawnSync("git", ["merge-file", "-p", a, b, c], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Every transcript of the session's conversation, its workers' included. */
export function sessionTranscripts(s: Pick<SessionEdits, "sessionId" | "conversationId" | "transcript">): string[] {
  const out = new Set<string>(s.transcript ? [s.transcript] : []);
  const ids = new Set([s.sessionId]);
  for (const [file, record] of Object.entries(getAllSyncRecords())) {
    const id = record.sourceGeneration?.sessionId ?? path.basename(file).replace(/\.jsonl$/, "");
    if ((s.conversationId && record.conversationId === s.conversationId) || id === s.sessionId) {
      out.add(file);
      ids.add(id);
    }
  }
  for (const file of [...out]) {
    for (const id of ids) {
      const sub = path.join(path.dirname(file), id, "subagents");
      const walk = (dir: string) => {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const f = path.join(dir, e.name);
          if (e.isDirectory()) walk(f);
          else if (e.name.endsWith(".jsonl")) out.add(f);
        }
      };
      walk(sub);
    }
  }
  return [...out];
}

/** A session that wrote the file: its transcripts, its newest write (attribution's), and its client. */
export type Writer = { id: string; transcripts: string[]; lastWrite: number; client: string };

/** `base` with only `w`'s edits since the file's last commit, or why they cannot be replayed. */
function replayWriter(root: string, rel: string, base: string, since: number, w: Writer): OwnCut {
  if (w.client !== "claude") return { ok: false, why: `${w.id} is a ${w.client} session, whose edits are not replayed` };
  const ops = writesTo(w.transcripts, root, rel, since);
  if (!ops.length || ops[ops.length - 1].at < w.lastWrite) return { ok: false, why: `${w.id} wrote it in a way its transcripts do not show` };
  const cut = replayEdits(base, ops);
  return cut.ok ? cut : { ok: false, why: `${w.id}'s edits do not replay: ${cut.why}` };
}

/**
 * The session's own version of `rel` (see the header): the file at `base` with only `mine`'s edits, when it and every
 * writer in `others` replay and together they account for the frozen file exactly. `since` is the file's last commit time.
 */
export function ownVersion(input: { root: string; rel: string; base: string | null; frozen: string | null; since: number; mine: Writer; others: Writer[] }): OwnCut {
  const { root, rel, base, frozen, since } = input;
  if (base === null) return { ok: false, why: "the file is new" };
  if (frozen === null) return { ok: false, why: "the file is deleted" };
  const own = replayWriter(root, rel, base, since, input.mine);
  if (!own.ok) return own;
  let all = own.content;
  for (const w of input.others) {
    const theirs = replayWriter(root, rel, base, since, w);
    if (!theirs.ok) return theirs;
    const merged = merge3(all, base, theirs.content);
    if (merged === null) return { ok: false, why: `${w.id}'s lines touch this session's` };
    all = merged;
  }
  if (all !== frozen) return { ok: false, why: "it holds lines no session's edits since its last commit account for" };
  return own;
}

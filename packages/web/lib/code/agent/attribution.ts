// Which session wrote a file, or is writing it now. A name is shown only when
// the evidence points at exactly one session: a wrong name is worse than none,
// so two plausible writers read as an unknown one.
//
// Evidence, strongest first:
//   - a recent tool call in the session's loaded transcript that names the
//     file's absolute path (Edit/Write/MultiEdit input, a patch header),
//   - a path in the session row's activity line ("editing src/chat.ts"),
//     resolved against the session's folders,
//   - a bare basename in that line ("editing chat.ts"): a weak hint, kept only
//     for a session with no stronger evidence, and accepted only when the
//     caller knows the name is unambiguous (writerFor's `weak`). Presence
//     never takes it; attribution of a change takes it when no other open
//     buffer in the vault shares the name.
// Either way the session must be working now (the inbox's work state).

import { SESSION_ACTIVITY_FRESH_MS } from "@codecast/shared/contracts";
import { pathWithin, workRoots, type AgentSessionRow } from "./sessions";

export interface ToolCallLike {
  name?: string;
  input?: unknown;
}
export interface MessageLike {
  role: string;
  timestamp: number;
  tool_calls?: ToolCallLike[] | null;
}

/** How far back a tool call still counts. Presence asks about the latest call
 *  only; attribution of a change that just landed looks a little further. */
export interface EvidenceWindow {
  /** Tool calls per session to read, newest first. */
  calls: number;
  /** Oldest call that counts, in ms before now. */
  maxAgeMs: number;
}

export const PRESENCE_WINDOW: EvidenceWindow = { calls: 1, maxAgeMs: 2 * 60_000 };
export const ATTRIBUTION_WINDOW: EvidenceWindow = { calls: 8, maxAgeMs: 3 * 60_000 };

const WRITE_TOOL = /edit|write|patch|replace|create|notebook/i;

/** Absolute paths a tool call writes: path-like input fields, and the file
 *  headers of a patch. */
export function writtenPaths(call: ToolCallLike): string[] {
  if (!call?.name || !WRITE_TOOL.test(call.name)) return [];
  let input: unknown = call.input;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      // A raw patch body.
    }
  }
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("/")) out.add(v);
  };
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["file_path", "filePath", "path", "notebook_path", "target_file"]) add(o[k]);
    if (Array.isArray(o.edits)) for (const e of o.edits) if (e && typeof e === "object") add((e as Record<string, unknown>).file_path);
    for (const k of ["patch", "input", "command"]) if (typeof o[k] === "string") patchPaths(o[k] as string).forEach(add);
  } else if (typeof input === "string") patchPaths(input).forEach(add);
  return [...out];
}

function patchPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\*\*\* (?:Update|Add) File: (.+)$/gm)) out.push(m[1].trim());
  return out;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Who touched what, gathered once per store change and asked per file. */
export interface EditIndex {
  /** Absolute path to the sessions whose tool calls name it. */
  full: Map<string, Set<string>>;
  /** Basename to the sessions whose activity line names it, with their folders. */
  base: Map<string, Array<{ sessionId: string; roots: string[] }>>;
}

export function emptyEditIndex(): EditIndex {
  return { full: new Map(), base: new Map() };
}

function addFull(index: EditIndex, path: string, sessionId: string) {
  const set = index.full.get(path) ?? new Set<string>();
  set.add(sessionId);
  index.full.set(path, set);
}

export function buildEditIndex(opts: {
  rows: Iterable<AgentSessionRow>;
  isWorking: (row: AgentSessionRow) => boolean;
  messagesOf: (sessionId: string) => readonly MessageLike[] | undefined;
  now: number;
  window: EvidenceWindow;
}): EditIndex {
  const { rows, isWorking, messagesOf, now, window } = opts;
  const index = emptyEditIndex();
  for (const row of rows) {
    if (!row || !isWorking(row)) continue;
    const msgs = messagesOf(row._id);
    let strong = false;
    if (msgs?.length) {
      let seen = 0;
      for (let i = msgs.length - 1; i >= 0 && seen < window.calls; i--) {
        const m = msgs[i];
        if (now - m.timestamp > window.maxAgeMs) break;
        const calls = m.role === "assistant" ? (m.tool_calls ?? []) : [];
        for (let j = calls.length - 1; j >= 0 && seen < window.calls; j--) {
          seen++;
          for (const p of writtenPaths(calls[j])) {
            addFull(index, p, row._id);
            strong = true;
          }
        }
      }
    }
    const act = row.activity;
    if (act?.text && WRITE_TOOL.test(act.tool || act.text) && now - act.at <= Math.min(window.maxAgeMs, SESSION_ACTIVITY_FRESH_MS)) {
      const roots = workRoots(row);
      const names: string[] = [];
      let resolved = false;
      for (const raw of act.text.split(/\s+/)) {
        const word = raw.replace(/[`'",:;()]+$/g, "").replace(/^[`'"(]+/, "");
        const name = basename(word);
        if (!name || !name.includes(".")) continue;
        if (word.includes("/")) {
          // An agent writes paths relative to where it runs: its project.
          const cwd = row.project_path ?? row.git_root;
          const abs = word.startsWith("/") ? word : cwd ? `${cwd.replace(/\/+$/, "")}/${word.replace(/^\.\//, "")}` : null;
          if (abs) addFull(index, abs, row._id);
          resolved = true;
        } else names.push(name);
      }
      // A session that named a file outright says nothing by a bare name.
      if (!strong && !resolved) {
        for (const name of names) {
          const list = index.base.get(name) ?? [];
          if (!list.some((e) => e.sessionId === row._id)) list.push({ sessionId: row._id, roots });
          index.base.set(name, list);
        }
      }
    }
  }
  return index;
}

/** The one session the index names for a file, or null (none, or several).
 *  A bare-basename hint counts only when `weak` says the name is unambiguous
 *  for this file (no other file the person has open shares it). */
export function writerFor(index: EditIndex, absPath: string, weak?: (basename: string) => boolean): string | null {
  const strong = index.full.get(absPath);
  if (strong?.size === 1) return [...strong][0];
  if (strong && strong.size > 1) return null;
  if (!weak?.(basename(absPath))) return null;
  const hint = (index.base.get(basename(absPath)) ?? []).filter((e) => e.roots.some((r) => pathWithin(absPath, r)));
  return hint.length === 1 ? hint[0].sessionId : null;
}

/** A string naming everything in the index, to tell a real change from a
 *  rebuild that found the same evidence. */
export function editIndexDigest(index: EditIndex): string {
  const full = [...index.full].map(([p, s]) => `${p}=${[...s].sort().join(",")}`).sort();
  const base = [...index.base].map(([n, l]) => `${n}=${l.map((e) => e.sessionId).sort().join(",")}`).sort();
  return `${full.join(";")}|${base.join(";")}`;
}

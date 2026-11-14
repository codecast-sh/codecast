// The doc revisions this session last read or wrote, so a whole-body write
// can say which version of the text it was computed from (convex
// lib/docBody.ts writeDocBody). The server refuses a write whose base is
// older than the doc, which is how a person's edit in the editor, or another
// agent's write, between an agent's read and its write survives.
//
// One small file per session under ~/.codecast/doc-reads/ (outside a session,
// per shell). Only the reads that show a whole body record (`cast doc show`
// in full, `cast brief`), and the writes of a body the caller wrote itself;
// writers ask docReadBase for the doc they are about to replace.
import fs from "fs";
import path from "path";
import { codecastPath } from "./codecastDir.js";

type Ledger = Record<string, { rev: string; at: number }>;

const MAX_ENTRIES = 300;

// Outside a session the shell that ran the command stands in for one, so two
// terminals never share a read.
const SHELL_ENTRY_TTL_MS = 12 * 60 * 60 * 1000;

function ledgerFile(session: string | null | undefined): string {
  const name = (session || `shell-${process.ppid}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return codecastPath("doc-reads", `${name}.json`);
}

function load(file: string): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Remember `rev` for each key. Best effort: a ledger that cannot be written
 *  only means the next whole-body write asks for a fresh read. */
export function recordDocRead(session: string | null | undefined, keys: string[], rev: string | null | undefined): void {
  if (!rev || keys.length === 0) return;
  const file = ledgerFile(session);
  try {
    const ledger = load(file);
    const at = Date.now();
    for (const k of keys) ledger[k] = { rev, at };
    const kept = Object.entries(ledger).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)));
    fs.renameSync(tmp, file);
  } catch {}
}

/** The revision this session last saw for `key`, if any. */
export function docReadBase(session: string | null | undefined, key: string): string | undefined {
  const entry = load(ledgerFile(session))[key];
  if (!entry || (!session && Date.now() - entry.at > SHELL_ENTRY_TTL_MS)) return undefined;
  return entry.rev;
}

/** The newest revision this session saw under any of `keys`: one body can be
 *  read under two names (a plan, and the doc behind it). */
export function latestDocReadBase(session: string | null | undefined, keys: string[]): string | undefined {
  const ledger = load(ledgerFile(session));
  const fresh = keys.map((k) => ledger[k]).filter((e) => e && (session || Date.now() - e.at <= SHELL_ENTRY_TTL_MS));
  return fresh.sort((a, b) => b!.at - a!.at)[0]?.rev;
}

export const docKey = (id: string) => `doc:${id}`;
export const planKey = (ref: string) => `plan:${ref}`;
export const briefKey = (ref: string) => `brief:${ref}`;

/** Record the revision a body read or whole-body write answered with. A patch
 *  or a title change is computed on the server from text the caller has not
 *  seen, so its answer never becomes the base of the caller's next rewrite. */
export function noteDocRevisions(session: string | null | undefined, urlPath: string, body: Record<string, any>, result: any): void {
  if (!result || typeof result !== "object") return;
  switch (urlPath) {
    case "/cli/docs/update":
      if (body.content === undefined) return;
    // falls through
    case "/cli/docs/get":
    case "/cli/docs/create": {
      const id = result._id ?? result.id ?? body.id;
      if (id) recordDocRead(session, [docKey(String(id))], result.revision);
      return;
    }
    case "/cli/plans/update":
      if (body.body === undefined) return;
    // falls through
    case "/cli/plans/create": {
      const keys = [body.short_id, result.short_id].filter(Boolean).map((r: string) => planKey(String(r)));
      if (result.doc_id) keys.push(docKey(String(result.doc_id)));
      recordDocRead(session, [...new Set(keys)], result.doc_revision);
      return;
    }
    case "/cli/brief/get":
    case "/cli/brief/edit": {
      const keys = [body.role_id, result.role?._id, result.role_id].filter(Boolean).map((r: string) => briefKey(String(r)));
      if (result.brief_doc_id) keys.push(docKey(String(result.brief_doc_id)));
      recordDocRead(session, [...new Set(keys)], result.brief_revision);
      return;
    }
  }
}

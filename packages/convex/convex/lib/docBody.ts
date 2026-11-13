import { ConvexError } from "convex/values";
import { draftTextNodes } from "@codecast/shared/docs";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { packSnapshotContent } from "./docSnapshot";
import { resolveSessionConversation } from "./access";
import { resolveActor } from "./actor";

// ── Whole-body writes ───────────────────────────────────────────────────────
// A doc's text lives in two places: `content` (markdown) and the collab
// editor's history (doc_snapshots + doc_deltas). The editor saves its live
// state back to `content` one second after the last keystroke
// (docSync.submitSnapshot), so until then the newest delta is ahead of the
// newest snapshot and `content` trails what the person sees.
//
// Every write that replaces the body goes through writeDocBody. It refuses
// while the editor holds unsaved steps (rewriting the collab history would
// delete them), refuses a write computed from an older read (its `base`), and
// writes `content` and the collab snapshot in one transaction so an open
// editor remounts on the new text. A role doc's after-write hook
// (orgRoles.afterRoleDocWrite) stays with the caller, which may already own it.

/** The collab history's newest version, and its newest delta when that delta
 *  is not in `content` yet. */
export async function docLiveState(ctx: QueryCtx, docId: string): Promise<{ version: number; unsaved: any | null }> {
  const delta = await ctx.db.query("doc_deltas").withIndex("id_version", (q: any) => q.eq("id", docId)).order("desc").first();
  const snapshot = await ctx.db.query("doc_snapshots").withIndex("id_version", (q: any) => q.eq("id", docId)).order("desc").first();
  const saved = snapshot?.version ?? 0;
  return { version: Math.max(delta?.version ?? 0, saved), unsaved: delta && delta.version > saved ? delta : null };
}

/** What a read saw: the collab version and a hash of `content`. A person's
 *  steps move the version; any other write changes the hash. */
export function docRevision(content: string | undefined | null, version: number): string {
  const text = content ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${version}.${(h >>> 0).toString(36)}.${text.length.toString(36)}`;
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

async function personName(ctx: QueryCtx, userId: Id<"users"> | undefined): Promise<string> {
  const user = userId ? await ctx.db.get(userId) : null;
  return user?.name || (user as any)?.github_username || "Someone";
}

/** A person's editor has sent steps more recently than this: they are typing,
 *  and the save lands in about a second. Older unsaved steps were left by a
 *  tab that closed or failed to save. */
const LIVE_EDIT_FRESH_MS = 30_000;

function docConflict(reason: "stale" | "live_edit" | "no_base", message: string): ConvexError<any> {
  return new ConvexError({ code: "CONFLICT", reason, message });
}

export type DocWriter = { name: string; session?: string };

/** The writer a CLI call acts as: the token's person, and the session it runs in. */
export async function cliDocWriter(ctx: MutationCtx, userId: Id<"users">, sessionRef: string | undefined): Promise<DocWriter> {
  const conv = sessionRef ? await resolveSessionConversation(ctx, userId, sessionRef) : null;
  const actor = await resolveActor(ctx, userId, conv);
  return { name: actor.name ?? "Someone", session: (conv as any)?.short_id ?? undefined };
}

/**
 * Replace a doc's (content, title) as one write. `base` is the revision the
 * new text was computed from. A caller whose text came from outside this
 * transaction (a CLI, the assistant) passes `requireBase`, so a write that
 * names no base is refused rather than trusted; a write computed here from
 * the stored text needs none. The unsaved-steps check always runs. `force`
 * skips both, discarding whatever they protect.
 */
export async function writeDocBody(
  ctx: MutationCtx,
  doc: Doc<"docs">,
  fields: { content: string; title: string },
  opts: { writer: DocWriter; base?: string; requireBase?: boolean; force?: boolean; reread?: string; extra?: Record<string, unknown> },
): Promise<{ revision: string }> {
  const now = Date.now();
  // How this caller reads the doc again; each writer names its own read.
  const reread = opts.reread ?? `re-read it with \`cast doc show ${doc._id}\``;
  const live = await docLiveState(ctx, doc._id);
  if (!opts.force && live.unsaved) {
    const who = await personName(ctx, live.unsaved.user_id);
    const at = live.unsaved._creationTime;
    throw docConflict("live_edit", now - at < LIVE_EDIT_FRESH_MS
      ? `${who} is editing it in the editor right now and their last change is not saved to the doc yet. Nothing was written. Wait a few seconds, ${reread}, and write again.`
      : `${who}'s editor left changes unsaved ${ago(at, now)}. Opening the doc in the browser saves them; \`--force\` writes over them.`);
  }
  if (!opts.force && opts.requireBase && opts.base === undefined) {
    throw docConflict("no_base", `This write does not say which version of "${doc.title}" it was computed from, so it could undo edits made since. Nothing was written. ${reread[0].toUpperCase()}${reread.slice(1)} and write again (an older cast needs \`cast update\` first).`);
  }
  if (!opts.force && opts.base !== undefined && opts.base !== docRevision(doc.content, live.version)) {
    const baseVersion = Number(opts.base.split(".")[0]);
    const step = Number.isFinite(baseVersion) && live.version > baseVersion
      ? await ctx.db.query("doc_deltas").withIndex("id_version", (q: any) => q.eq("id", doc._id).gt("version", baseVersion)).order("desc").first()
      : null;
    const writer = (doc as any).content_writer as { name: string; session?: string; at: number } | undefined;
    const newer = step
      ? `${await personName(ctx, step.user_id)} edited it in the editor ${ago(step._creationTime, now)}`
      : writer
        ? `${writer.name}${writer.session ? ` (session ${writer.session})` : ""} wrote it ${ago(writer.at, now)}`
        : `it was edited ${ago(doc.updated_at, now)}`;
    throw docConflict("stale", `"${doc.title}" changed since you read it: ${newer}. Nothing was written. ${reread[0].toUpperCase()}${reread.slice(1)}, redo your change on that text, and write again.`);
  }
  const version = live.version + 1;
  await ctx.db.patch(doc._id, {
    content: fields.content,
    title: fields.title,
    updated_at: now,
    cli_edited_at: now,
    content_writer: { name: opts.writer.name, ...(opts.writer.session ? { session: opts.writer.session } : {}), at: now },
    ...opts.extra,
  } as any);
  await rewriteCollab(ctx, doc._id, fields.content, version);
  return { revision: docRevision(fields.content, version) };
}

/** Replace the collab history with `content` as one snapshot at `version`,
 *  which must be past every version an open editor holds, snapshots AND
 *  deltas (the newest snapshot often trails the deltas). A version at or
 *  below one a tab already reached would let that tab keep syncing steps
 *  written against the old content on top of the new (docSync's stepsAfter
 *  refuses only clients behind the rewrite). */
export async function rewriteCollab(ctx: MutationCtx, docId: string, content: string, version: number): Promise<void> {
  const snapshots = await ctx.db.query("doc_snapshots").withIndex("id_version", (q: any) => q.eq("id", docId)).collect();
  const deltas = await ctx.db.query("doc_deltas").withIndex("id_version", (q: any) => q.eq("id", docId)).collect();
  for (const d of deltas) await ctx.db.delete(d._id);
  const content_gz = packSnapshotContent(JSON.stringify(markdownToDoc(content)));
  const [keep, ...rest] = snapshots.sort((a: any, b: any) => b.version - a.version);
  // Write the compressed form and drop any legacy uncompressed content so the
  // row carries exactly one representation (see doc_snapshots in schema.ts).
  if (keep) await ctx.db.patch(keep._id, { content_gz, content: undefined, version });
  else await ctx.db.insert("doc_snapshots", { id: docId, version, content_gz });
  for (const s of rest) await ctx.db.delete(s._id);
}


// The markdown a CLI or API write stores, as the collab editor's document.
type DocNode = { type: string; attrs?: Record<string, any>; content?: DocNode[]; text?: string };

export function markdownToDoc(text: string): DocNode {
  const lines = text.split("\n");
  const content: DocNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const node: DocNode = { type: "codeBlock" };
      if (lang) node.attrs = { language: lang };
      if (codeLines.length > 0) node.content = [{ type: "text", text: codeLines.join("\n") }];
      content.push(node);
      continue;
    }

    if (/^---+$/.test(line.trim())) { content.push({ type: "horizontalRule" }); i++; continue; }

    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) {
      content.push({ type: "heading", attrs: { level: hm[1].length }, content: draftTextNodes(hm[2]) });
      i++;
      continue;
    }

    if (line.startsWith("> ")) {
      const ql: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) { ql.push(lines[i].slice(2)); i++; }
      content.push({ type: "blockquote", content: [{ type: "paragraph", content: draftTextNodes(ql.join("\n")) }] });
      continue;
    }

    if (/^[-*]\s/.test(line)) {
      const items: DocNode[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push({ type: "listItem", content: [{ type: "paragraph", content: draftTextNodes(lines[i].replace(/^[-*]\s/, "")) }] });
        i++;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }

    if (line.trim() === "") { i++; continue; }

    // A paragraph runs until a line another block claims. Its first line is
    // always its own: a line no block above took ("#tag", "####" with no
    // text) would otherwise stop the loop without consuming anything.
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" &&
           !/^#{1,6}\s+\S/.test(lines[i]) && !lines[i].startsWith("```") &&
           !lines[i].startsWith("> ") && !/^[-*]\s/.test(lines[i]) &&
           !/^---+$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    const pc: DocNode[] = [];
    paraLines.forEach((pl, idx) => {
      if (idx > 0) pc.push({ type: "hardBreak" });
      // Drafting spans (@codecast/shared/docs drafting) open as live editor marks.
      pc.push(...draftTextNodes(pl));
    });
    if (pc.length > 0) content.push({ type: "paragraph", content: pc });
  }

  if (content.length === 0) content.push({ type: "paragraph" });
  return { type: "doc", content };
}

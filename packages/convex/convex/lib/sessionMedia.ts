// What a session made, read back for surfaces that tell its work to others:
// the images it posted or looked at (task evidence, Changes stories) and its
// edits to instruction text (prompts, skills, agent guides), which Changes
// tells as a change in how an agent behaves. Callers decide who may see a
// session; these readers only find what it made in a window of time.
import type { Doc, Id } from "../_generated/dataModel";
import { readFileChangeBody } from "./fileChangeBody";

type StorageCtx = { db: any; storage?: { getUrl: (id: any) => Promise<string | null> } };

export type SessionImage = {
  conversation_id: Id<"conversations">;
  message_id: Id<"messages">;
  url: string;
  timestamp: number;
  seq: number;
};

/** A stored file's serving URL, when the context can resolve one. */
export const storageUrl = async (ctx: StorageCtx, storageId: unknown): Promise<string | undefined> =>
  storageId && ctx.storage?.getUrl ? (await ctx.storage.getUrl(storageId)) ?? undefined : undefined;

/**
 * A session's images posted in [since, until], newest first, at most `max`,
 * with their serving URLs. Rows are never inserted before their message, so
 * the walk stops at the first row created before `since`.
 */
export async function sessionImages(
  ctx: StorageCtx,
  conversationId: Id<"conversations">,
  opts: { since: number; until?: number; max: number },
): Promise<SessionImage[]> {
  const rows: Doc<"conversation_images">[] = [];
  for await (const row of ctx.db.query("conversation_images").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId)).order("desc")) {
    if (row._creationTime < opts.since) break;
    if (row.timestamp < opts.since || (opts.until !== undefined && row.timestamp > opts.until)) continue;
    rows.push(row);
    if (rows.length >= opts.max) break;
  }
  const out: SessionImage[] = [];
  for (const row of rows) {
    const url = (await storageUrl(ctx, row.storage_id)) ?? row.src;
    if (url) out.push({ conversation_id: row.conversation_id, message_id: row.message_id, url, timestamp: row.timestamp, seq: row.seq });
  }
  return out;
}

/** Paths whose text is instructions to an agent rather than code. */
const INSTRUCTION_PATH = /(^|\/)(prompts?|skills?|agents?)\/|prompt|instruction|(^|\/)(CLAUDE|AGENTS|SKILL)\.md$/i;
const TEST_PATH = /(\.|\/)(test|spec)s?[./]|__tests__|__fixtures__|fixtures?\//i;

/**
 * Whether an edit reads as instruction prose: a known instruction path, or
 * replacement text that is mostly sentences (code and data are not). Tests
 * and fixtures never count, however wordy.
 */
export function isInstructionEdit(path: string, after: string): boolean {
  if (TEST_PATH.test(path)) return false;
  if (INSTRUCTION_PATH.test(path)) return true;
  const words = after.match(/[A-Za-z]{3,}/g) ?? [];
  const sentences = after.match(/[a-z][.?!](\s|$)/g) ?? [];
  return after.length >= 200 && sentences.length >= 2 && words.join("").length / after.length >= 0.55;
}

export type InstructionEdit = { path: string; before: string; after: string; timestamp: number };

/**
 * A session's edits to instruction text in [since, until], largest first, at
 * most `max`, each side clipped to `chars`. Whole-file writes are skipped:
 * their before and after are the file, not the change.
 */
export async function sessionInstructionEdits(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  opts: { since: number; until: number; max: number; chars: number },
): Promise<InstructionEdit[]> {
  const rows: Doc<"file_changes">[] = await ctx.db
    .query("file_changes")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .filter((q: any) => q.and(q.eq(q.field("change_type"), "edit"), q.gte(q.field("timestamp"), opts.since), q.lte(q.field("timestamp"), opts.until)))
    .take(400);
  const found: Array<InstructionEdit & { size: number }> = [];
  for (const row of rows) {
    const body = await readFileChangeBody(ctx, conversationId, row.change_key, row);
    const before = body?.oldContent ?? "";
    const after = body?.newContent ?? "";
    if (!after.trim() || before === after || !isInstructionEdit(row.file_path, after)) continue;
    found.push({ path: row.file_path, before: before.slice(0, opts.chars), after: after.slice(0, opts.chars), timestamp: row.timestamp, size: before.length + after.length });
  }
  return found
    .sort((a, b) => b.size - a.size)
    .slice(0, opts.max)
    .map(({ size: _size, ...e }) => e);
}

/** A published page or a canvas a session made, embeddable whole in a story's article. */
export type SessionArtifact =
  | { kind: "page"; url: string; title: string; timestamp: number }
  | { kind: "canvas"; block: string; title: string; timestamp: number };

const PAGE_URL = /https:\/\/(?:www\.)?codecast\.sh\/a\/[A-Za-z0-9_-]+/g;
const CANVAS_BLOCK = /```cast-canvas\n[\s\S]*?\n```/g;
/** A canvas past this is a whole app, not a figure for an article. */
const CANVAS_MAX_CHARS = 24_000;

/** Words standing in for a page or canvas: the canvas's declared title, else the line around the page link. */
function artifactTitle(text: string, at: number, block?: string): string {
  const declared = block?.match(/data-canvas-title="([^"]{1,120})"/)?.[1];
  if (declared) return declared;
  const line = text.slice(Math.max(0, text.lastIndexOf("\n", at) + 1), (text.indexOf("\n", at) + 1 || text.length + 1) - 1);
  return line.replace(/https?:\/\/\S+/g, "").replace(/[*_`#>[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
}

/**
 * The pages a session published and the canvases it drew in [since, until],
 * newest first, at most `max`, from its own replies: what it made to show its
 * work, which an article can embed as made.
 */
export async function sessionArtifacts(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  opts: { since: number; until: number; max: number },
): Promise<SessionArtifact[]> {
  const out: SessionArtifact[] = [];
  const seen = new Set<string>();
  const messages: Doc<"messages">[] = await ctx.db
    .query("messages")
    .withIndex("by_conversation_role_timestamp", (q: any) =>
      q.eq("conversation_id", conversationId).eq("role", "assistant").gte("timestamp", opts.since).lte("timestamp", opts.until))
    .order("desc")
    .take(300);
  for (const m of messages) {
    const text = m.content ?? "";
    for (const match of text.matchAll(CANVAS_BLOCK)) {
      if (match[0].length > CANVAS_MAX_CHARS || seen.has(match[0])) continue;
      seen.add(match[0]);
      out.push({ kind: "canvas", block: match[0], title: artifactTitle(text, match.index ?? 0, match[0]), timestamp: m.timestamp });
    }
    for (const match of text.matchAll(PAGE_URL)) {
      if (seen.has(match[0])) continue;
      seen.add(match[0]);
      // The page's own title says what it shows; the line around the link is the fallback.
      const slug = match[0].split("/").pop()!;
      const page: Doc<"artifacts"> | null = await ctx.db.query("artifacts").withIndex("by_slug", (q: any) => q.eq("slug", slug)).first();
      out.push({ kind: "page", url: match[0], title: page?.title?.trim() || artifactTitle(text, match.index ?? 0), timestamp: m.timestamp });
    }
    if (out.length >= opts.max) break;
  }
  return out.slice(0, opts.max);
}

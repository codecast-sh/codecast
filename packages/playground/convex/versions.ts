// Versions: immutable snapshots of an app's files, numbered 1..n per app.
// An app made from a request starts on v0, the starter: scaffolding for
// Clay's first build, never shown as a version, so the maker's first build
// is v1. Appending one is the only way the live
// version moves, and the only writer is commitVersion, so numbering, counts
// and the live pointer cannot drift.
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { fail } from "./lib/errors";
import { isModulePath, type EntryFile } from "./lib/entryPage";
import { ENTRY_PATH, byteLength, contentTypeFor, fileSetProblems, manifestHash, needsTranspile, normalizeFilePath, type FileDraft } from "./lib/files";
import { sha256Hex } from "./lib/identity";
import { TIMELINE_MAX } from "./lib/limits";
import { transpile } from "./lib/transpile";
import { cleanSummary, nextVersionNumber, restoreSummary, undoneBy, type VersionKind } from "./lib/versions";
import { takeRate } from "./limits";
import { appBySlug, postSystemNote, requireApp } from "./model";
import { publicVisitors, requireVisitor, type PublicVisitor } from "./visitors";
import { versionKind, versionRef, visitorArgs } from "./validators";

export type VersionMeta = {
  kind: VersionKind;
  summary: string;
  author_id: Id<"visitors">;
  /** The version this one was made from; defaults to the live version. A
   *  build passes its base, which a restore may have moved past meanwhile. */
  parent_number?: number;
  request_message_id?: Id<"messages">;
  source?: { app_id: Id<"apps">; version: number };
  undid?: number;
  spotlight?: string;
  try_it?: string;
  /** The starter under a first build: v0, never shown. */
  scaffold?: boolean;
};

type FileRow = { path: string; hash: string; served_hash?: string };

async function blobByHash(ctx: QueryCtx, hash: string): Promise<Doc<"blobs"> | null> {
  return ctx.db.query("blobs").withIndex("by_hash", (q) => q.eq("hash", hash)).first();
}

/** Store text by content hash, once. */
async function putBlob(ctx: MutationCtx, text: string): Promise<{ hash: string; size: number }> {
  const hash = await sha256Hex(text);
  const size = byteLength(text);
  if (!(await blobByHash(ctx, hash))) await ctx.db.insert("blobs", { hash, size, text });
  return { hash, size };
}

async function commitVersion(
  ctx: MutationCtx,
  app: Doc<"apps">,
  meta: VersionMeta,
  files: FileRow[],
  stats: { bytes: number; files_hash: string },
): Promise<{ version_id: Id<"versions">; number: number }> {
  const number = meta.scaffold ? 0 : nextVersionNumber(app.version_count);
  const parent_number = meta.parent_number ?? (app.version_count > 0 ? app.live_version : undefined);
  const now = Date.now();
  const firstByAuthor = !(await ctx.db
    .query("versions")
    .withIndex("by_app_author", (q) => q.eq("app_id", app._id).eq("author_id", meta.author_id))
    .first());
  const version_id = await ctx.db.insert("versions", {
    app_id: app._id,
    number,
    ...(parent_number !== undefined ? { parent_number } : {}),
    kind: meta.kind,
    summary: cleanSummary(meta.summary),
    author_id: meta.author_id,
    ...(meta.request_message_id ? { request_message_id: meta.request_message_id } : {}),
    ...(meta.source ? { source: meta.source } : {}),
    ...(meta.undid ? { undid: meta.undid } : {}),
    ...(meta.spotlight ? { spotlight: meta.spotlight } : {}),
    ...(meta.try_it ? { try_it: meta.try_it } : {}),
    file_count: files.length,
    bytes: stats.bytes,
    files_hash: stats.files_hash,
    created_at: now,
  });
  for (const f of files) await ctx.db.insert("version_files", { version_id, ...f });
  await ctx.db.patch(app._id, {
    version_count: number,
    live_version: number,
    contributor_count: app.contributor_count + (firstByAuthor ? 1 : 0),
    last_activity_at: now,
  });
  return { version_id, number };
}

/** Append a version from file texts and make it live. Paths are normalized,
 *  the set must pass the file rules, and JSX/TS must transpile; otherwise
 *  this throws `invalid` with every problem, and nothing is written. */
export async function appendVersion(ctx: MutationCtx, app: Doc<"apps">, meta: VersionMeta, drafts: FileDraft[]) {
  const files = drafts.map((f) => ({ path: normalizeFilePath(f.path) ?? f.path, text: f.text }));
  const compiled = files.map((f) => (needsTranspile(f.path) ? transpile(f.path, f.text) : null));
  const problems = [...fileSetProblems(files), ...compiled.flatMap((c) => (c && !c.ok ? [c.error] : []))];
  if (problems.length) fail("invalid", problems.join("\n"));

  const rows: FileRow[] = [];
  let bytes = 0;
  for (const [i, f] of files.entries()) {
    const source = await putBlob(ctx, f.text);
    const c = compiled[i];
    const served = c?.ok ? await putBlob(ctx, c.code) : null;
    bytes += source.size;
    rows.push({ path: f.path, hash: source.hash, ...(served ? { served_hash: served.hash } : {}) });
  }
  return commitVersion(ctx, app, meta, rows, { bytes, files_hash: await manifestHash(rows) });
}

/** Append a version holding exactly the files of `from` (any app's), for
 *  restore and fork. Blobs are shared, so this copies only path rows. */
export async function appendCopiedVersion(ctx: MutationCtx, app: Doc<"apps">, meta: VersionMeta, from: Doc<"versions">) {
  const rows = (await fileRows(ctx, from._id)).map(({ path, hash, served_hash }) => ({
    path,
    hash,
    ...(served_hash ? { served_hash } : {}),
  }));
  return commitVersion(ctx, app, meta, rows, { bytes: from.bytes, files_hash: from.files_hash });
}

function fileRows(ctx: QueryCtx, versionId: Id<"versions">) {
  return ctx.db.query("version_files").withIndex("by_version_path", (q) => q.eq("version_id", versionId)).collect();
}

export async function versionByNumber(ctx: QueryCtx, appId: Id<"apps">, number: number): Promise<Doc<"versions"> | null> {
  return ctx.db
    .query("versions")
    .withIndex("by_app_number", (q) => q.eq("app_id", appId).eq("number", number))
    .unique();
}

/** A version people can see, view, restore or fork from: any but v0. */
export async function shownVersion(ctx: QueryCtx, appId: Id<"apps">, number: number): Promise<Doc<"versions"> | null> {
  const row = await versionByNumber(ctx, appId, number);
  return row && row.number > 0 ? row : null;
}

/** A version as the timeline shows it: no file contents. */
export type TimelineEntry = {
  number: number;
  parent_number: number | null;
  kind: VersionKind;
  summary: string;
  author: PublicVisitor | null;
  request_message_id: Id<"messages"> | null;
  source: { app_id: Id<"apps">; version: number } | null;
  /** restore: the version it undid, or null when it brought an older one back. */
  undid: number | null;
  /** build: the element its change is about, and what to try. */
  spotlight: string | null;
  try_it: string | null;
  file_count: number;
  created_at: number;
  /** The apps forked from this version, oldest first, each with who forked it. */
  forks: ForkOf[];
};

export type ForkOf = { slug: string; name: string; by: PublicVisitor | null };

/** Forks of `appId`, grouped by the version each one came from. */
async function forksByVersion(ctx: QueryCtx, appId: Id<"apps">): Promise<Map<number, ForkOf[]>> {
  const forks = await ctx.db
    .query("apps")
    .withIndex("by_forked_from", (q) => q.eq("forked_from.app_id", appId))
    .take(TIMELINE_MAX);
  const people = await publicVisitors(ctx, forks.map((f) => f.created_by));
  const by = new Map<number, ForkOf[]>();
  for (const f of forks) {
    const n = f.forked_from!.version;
    by.set(n, [...(by.get(n) ?? []), { slug: f.slug, name: f.name, by: people.get(f.created_by) ?? null }]);
  }
  return by;
}

async function timelineEntries(ctx: QueryCtx, appId: Id<"apps">, rows: Doc<"versions">[]): Promise<TimelineEntry[]> {
  const [people, forks] = await Promise.all([publicVisitors(ctx, rows.map((r) => r.author_id)), forksByVersion(ctx, appId)]);
  return rows.filter((r) => r.number > 0).map((r) => ({
    number: r.number,
    // A first build's parent is the starter, which nobody goes back to.
    parent_number: r.parent_number || null,
    kind: r.kind,
    summary: r.summary,
    author: people.get(r.author_id) ?? null,
    request_message_id: r.request_message_id ?? null,
    source: r.source ?? null,
    undid: r.undid ?? null,
    spotlight: r.spotlight ?? null,
    try_it: r.try_it ?? null,
    file_count: r.file_count,
    created_at: r.created_at,
    forks: forks.get(r.number) ?? [],
  }));
}

/** The timeline, oldest first: the latest TIMELINE_MAX versions. */
export const list = query({
  args: { ...visitorArgs, app_id: v.id("apps") },
  handler: async (ctx, args): Promise<TimelineEntry[]> => {
    await requireVisitor(ctx, args);
    await requireApp(ctx, args.app_id);
    const rows = await ctx.db
      .query("versions")
      .withIndex("by_app_number", (q) => q.eq("app_id", args.app_id))
      .order("desc")
      .take(TIMELINE_MAX);
    return timelineEntries(ctx, args.app_id, rows.reverse());
  },
});

export const get = query({
  args: { ...visitorArgs, app_id: v.id("apps"), number: v.number() },
  handler: async (ctx, args): Promise<TimelineEntry | null> => {
    await requireVisitor(ctx, args);
    const row = await shownVersion(ctx, args.app_id, args.number);
    return row ? (await timelineEntries(ctx, args.app_id, [row]))[0] : null;
  },
});

/** Restore: a new live version holding version `number`'s files, announced
 *  in the room. Nothing rewinds; the versions in between stay on the timeline.
 *  `expected_live` is the live version the person was looking at when they
 *  chose: if anything went live since, the restore is refused rather than
 *  silently undoing it too, which also makes a double Undo a no-op. */
export const restore = mutation({
  args: { ...visitorArgs, app_id: v.id("apps"), number: v.number(), expected_live: v.number() },
  handler: async (ctx, args): Promise<{ number: number }> => {
    const visitor = await requireVisitor(ctx, args);
    const app = await requireApp(ctx, args.app_id);
    if (app.live_version !== args.expected_live) fail("invalid", `The app changed: v${app.live_version} is live now. Look again before you restore.`);
    if (args.number === app.live_version) fail("invalid", `v${args.number} is already live.`);
    const from = (await shownVersion(ctx, app._id, args.number)) ?? fail("not_found", `v${args.number} does not exist.`);
    const live = await versionByNumber(ctx, app._id, app.live_version);
    const undone = live && undoneBy(live, from.number) !== null ? live : null;
    await takeRate(ctx, "restore", visitor._id);
    await takeRate(ctx, "appRestore", app._id);
    const { number } = await appendCopiedVersion(
      ctx,
      app,
      {
        kind: "restore",
        summary: restoreSummary(undone, from),
        author_id: visitor._id,
        source: { app_id: app._id, version: from.number },
        ...(undone ? { undid: undone.number } : {}),
      },
      from,
    );
    await postSystemNote(
      ctx,
      app._id,
      { type: "restore", visitor_id: visitor._id, from_version: from.number, version: number, ...(undone ? { undid: undone.number } : {}) },
      undone ? `v${undone.number} undone as v${number}` : `v${from.number} brought back as v${number}`,
    );
    return { number };
  },
});

export type VersionFile = { path: string; hash: string; size: number; text: string | null; url: string | null };

async function readFiles(ctx: QueryCtx, versionId: Id<"versions">): Promise<VersionFile[]> {
  const rows = await fileRows(ctx, versionId);
  return Promise.all(
    rows.map(async (r) => {
      const blob = await blobByHash(ctx, r.hash);
      if (!blob) throw new Error(`missing blob ${r.hash} for ${r.path}`);
      const url = blob.storage_id ? await ctx.storage.getUrl(blob.storage_id) : null;
      return { path: r.path, hash: r.hash, size: blob.size, text: blob.text ?? null, url };
    }),
  );
}

/** The source files of one version, sorted by path. */
export const files = query({
  args: { ...visitorArgs, app_id: v.id("apps"), number: v.number() },
  handler: async (ctx, args) => {
    await requireVisitor(ctx, args);
    const row = await versionByNumber(ctx, args.app_id, args.number);
    if (!row) return null;
    return { number: row.number, files_hash: row.files_hash, files: await readFiles(ctx, row._id) };
  },
});

/** The builder's starting draft: a version's source files as text. */
export const draft = internalQuery({
  args: { app_id: v.id("apps"), number: v.number() },
  handler: async (ctx, args): Promise<FileDraft[]> => {
    const row = (await versionByNumber(ctx, args.app_id, args.number)) ?? fail("not_found", `v${args.number} does not exist`);
    return (await readFiles(ctx, row._id)).map((f) => ({ path: f.path, text: f.text ?? "" }));
  },
});

/** One file as the runtime serves it: transpiled when the source is JSX/TS. */
export const served = internalQuery({
  args: { slug: v.string(), number: v.number(), path: v.string() },
  handler: async (ctx, args) => {
    const app = await appBySlug(ctx, args.slug);
    const row = app && (await versionByNumber(ctx, app._id, args.number));
    if (!row) return null;
    const file = await ctx.db
      .query("version_files")
      .withIndex("by_version_path", (q) => q.eq("version_id", row._id).eq("path", args.path))
      .unique();
    const blob = file && (await blobByHash(ctx, file.served_hash ?? file.hash));
    if (!blob) return null;
    return {
      content_type: contentTypeFor(args.path),
      hash: blob.hash,
      text: blob.text ?? null,
      storage_id: blob.storage_id ?? null,
    };
  },
});

/** A version's index.html and its modules, all as served, for the entry
 *  page (http.ts, lib/entryPage). */
export const entry = internalQuery({
  args: { slug: v.string(), number: v.number() },
  handler: async (ctx, args): Promise<{ html: string; hash: string; files: EntryFile[] } | null> => {
    const app = await appBySlug(ctx, args.slug);
    const row = app && (await versionByNumber(ctx, app._id, args.number));
    if (!row) return null;
    const rows = await fileRows(ctx, row._id);
    const served = async (f: Doc<"version_files">) => blobByHash(ctx, f.served_hash ?? f.hash);
    const index = rows.find((f) => f.path === ENTRY_PATH);
    const html = index && (await served(index));
    if (!html?.text) return null;
    const files = await Promise.all(rows.filter((f) => isModulePath(f.path)).map(async (f) => ({ path: f.path, text: (await served(f))?.text ?? null })));
    return { html: html.text, hash: html.hash, files };
  },
});

/** The live version number behind an app link, for /run/<slug>/live. */
export const liveNumber = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args): Promise<number | null> => (await appBySlug(ctx, args.slug))?.live_version ?? null,
});

/** The builder's commit: append a version from its finished draft. */
export const append = internalMutation({
  args: {
    app_id: v.id("apps"),
    files: v.array(v.object({ path: v.string(), text: v.string() })),
    kind: versionKind,
    summary: v.string(),
    author_id: v.id("visitors"),
    parent_number: v.optional(v.number()),
    request_message_id: v.optional(v.id("messages")),
    source: v.optional(versionRef),
  },
  handler: async (ctx, { app_id, files, ...meta }) => {
    return appendVersion(ctx, await requireApp(ctx, app_id), meta, files);
  },
});

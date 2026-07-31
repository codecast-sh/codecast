// HTTP layer for published artifacts: everything that needs Web Crypto or
// ctx.storage.store lives here as httpActions; http.ts just routes to these.
// Data logic is artifacts.ts, presentation is artifactPages.ts.

import { httpAction, action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { marked } from "marked";
import {
  MAX_ARTIFACT_BYTES,
  newSlug,
  newSecret,
  artifactUrl,
  lineDiff,
  accessSummary,
} from "./artifacts";
import {
  brandArtifactHtml,
  passwordGatePage,
  emailGatePage,
  expiredPage,
  sourcePage,
  diffPage,
  editorPage,
  mdDocumentHtml,
} from "./artifactPages";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export const corsPreflight = httpAction(async () => new Response(null, { status: 204, headers: CORS }));

async function sha256Hex(s: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function passwordHash(password: string, slug: string): Promise<string> {
  return await sha256Hex(`${password}:${slug}`);
}

/** Deterministic unlock token — knowing it ≈ knowing the password, and it
 * rotates when the password changes. Deterministic so the ?k= URL stays a
 * stable cache key. */
async function kTokenFor(password_hash: string, slug: string): Promise<string> {
  return (await sha256Hex(`${password_hash}:${slug}`)).slice(0, 24);
}

async function eTokenFor(owner_key: string, slug: string): Promise<string> {
  return (await sha256Hex(`${owner_key}:emailgate:${slug}`)).slice(0, 24);
}

/** The public https origin of this deployment. TLS terminates at the proxy in
 * front of us, so request.url says http — force https for any non-local host
 * or in-page fetches get blocked as mixed content. */
function apiBaseFrom(request: Request): string {
  const url = new URL(request.url);
  return /^(localhost|127\.)/.test(url.hostname) ? url.origin : `https://${url.host}`;
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  wasm: "application/wasm",
  csv: "text/csv; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Normalize a bundle-relative path; null = rejected. Blocks traversal,
 * absolute paths, and our reserved `_v/` versioned-asset namespace. */
export function normalizeAssetPath(raw: string): string | null {
  const path = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!path || path.startsWith("/") || path.startsWith("_v/") || path.includes("..") || path.includes("\0")) return null;
  if (path.length > 512) return null;
  return path;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function renderMarkdown(md: string, title: string): Promise<string> {
  const bodyHtml = await marked.parse(md, { async: true });
  return mdDocumentHtml({ title, bodyHtml });
}

/** Inject <base> right after <head> for bundle docs so relative asset URLs
 * resolve under the slug (and under _v/N/ for past versions). */
function injectBase(html: string, href: string): string {
  if (/<base\s/i.test(html)) return html;
  const headMatch = html.match(/<head[^>]*>/i);
  if (!headMatch) return `<base href="${href}">` + html;
  const at = html.indexOf(headMatch[0]) + headMatch[0].length;
  return html.slice(0, at) + `<base href="${href}">` + html.slice(at);
}

type AccessInput = {
  password?: string | null;
  email_gate?: boolean;
  expires_in_ms?: number | null;
  edit_mode?: string;
};

/** Plain access flags → the pre-hashed patch the mutations accept. */
async function buildAccessSet(
  access: AccessInput,
  slug: string,
  existingEditUrl: string | null,
): Promise<Record<string, unknown>> {
  const set: Record<string, unknown> = {};
  if (access.password !== undefined) {
    set.password_hash = access.password === null || access.password === "" ? null : await passwordHash(access.password, slug);
  }
  if (access.email_gate !== undefined) set.email_gate = !!access.email_gate;
  if (access.expires_in_ms !== undefined) {
    set.expires_at = access.expires_in_ms === null ? null : Date.now() + Math.max(60_000, access.expires_in_ms);
  }
  if (access.edit_mode !== undefined) {
    if (!["owner", "link", "team"].includes(access.edit_mode)) throw new Error(`Invalid edit_mode "${access.edit_mode}"`);
    set.edit_mode = access.edit_mode;
    if (access.edit_mode === "link" && !existingEditUrl) set.edit_key = newSecret();
  }
  return set;
}

// ---------------------------------------------------------------------------
// POST /cli/artifacts/publish
// ---------------------------------------------------------------------------

export const publish = httpAction(async (ctx, request) => {
  try {
    const body = await request.json();
    const { api_token, content, title, source_path, force_new, kind: rawKind, files, session_ref, access, thumb_b64 } = body;
    if (!api_token || !title) return json({ error: "Missing api_token or title" }, 400);
    const kind = rawKind === "markdown" || rawKind === "bundle" ? rawKind : "html";
    if (kind !== "bundle" && typeof content !== "string") return json({ error: "Missing content" }, 400);
    if (kind === "bundle" && (!Array.isArray(files) || !files.length)) return json({ error: "Bundle publish needs files[]" }, 400);

    const who = await ctx.runQuery(internal.artifacts.verify, { api_token });
    if (!who) return json({ error: "Unauthorized" }, 401);

    // Resolve the row this publish updates (slug is the password-hash salt, so
    // it must exist before hashing). Create path: pre-mint slug + owner_key.
    const existing =
      !force_new && source_path
        ? await ctx.runQuery(internal.artifacts.byUserPath, { user_id: who.user_id, source_path })
        : null;
    let slug = existing?.slug;
    let ownerKey = existing?.owner_key;
    if (!slug) {
      slug = newSlug();
      while (await ctx.runQuery(internal.artifacts.slugTaken, { slug })) slug = newSlug();
      ownerKey = newSecret();
    }

    // --- Build the document + hash per kind ---
    let docHtml: string;
    let contentHash: string;
    let sourceText: string | undefined;
    let assetInputs: Array<{ path: string; bytes: Uint8Array; content_type: string }> = [];

    if (kind === "markdown") {
      sourceText = content as string;
      contentHash = await sha256Hex(sourceText);
      docHtml = await renderMarkdown(sourceText, title);
    } else if (kind === "bundle") {
      const seen = new Set<string>();
      let entryHtml: string | null = null;
      let entryPath: string | null = null;
      const htmlCandidates: string[] = [];
      let total = 0;
      for (const f of files) {
        const path = typeof f?.path === "string" ? normalizeAssetPath(f.path) : null;
        if (!path) return json({ error: `Invalid bundle path: ${JSON.stringify(f?.path ?? null)}` }, 400);
        if (seen.has(path)) return json({ error: `Duplicate bundle path: ${path}` }, 400);
        seen.add(path);
        if (typeof f.content_b64 !== "string") return json({ error: `Missing content for ${path}` }, 400);
        const bytes = b64ToBytes(f.content_b64);
        total += bytes.byteLength;
        if (/\.html?$/i.test(path)) htmlCandidates.push(path);
        assetInputs.push({ path, bytes, content_type: contentTypeFor(path) });
      }
      if (total > MAX_ARTIFACT_BYTES) {
        return json({ error: `Bundle is ${(total / 1024 / 1024).toFixed(1)}MB — the limit is 8MB total.` }, 413);
      }
      entryPath = htmlCandidates.includes("index.html")
        ? "index.html"
        : htmlCandidates.length === 1
          ? htmlCandidates[0]
          : null;
      if (!entryPath) {
        return json({ error: "Bundle needs an index.html (or exactly one .html file) as the entry page" }, 400);
      }
      const entry = assetInputs.find((a) => a.path === entryPath)!;
      entryHtml = new TextDecoder().decode(entry.bytes);
      assetInputs = assetInputs.filter((a) => a.path !== entryPath);
      // Hash over the canonical file list so any file change bumps a version.
      const parts: string[] = [];
      parts.push(`${entryPath}:${await sha256Hex(entryHtml)}`);
      for (const a of assetInputs.slice().sort((x, y) => (x.path < y.path ? -1 : 1))) {
        const hex = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", a.bytes as unknown as ArrayBuffer)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        parts.push(`${a.path}:${hex}`);
      }
      contentHash = await sha256Hex(parts.join("\n"));
      docHtml = entryHtml;
    } else {
      docHtml = content as string;
      contentHash = await sha256Hex(docHtml);
    }

    const size = new TextEncoder().encode(docHtml).byteLength;
    if (size > MAX_ARTIFACT_BYTES) {
      return json({ error: `Artifact is ${(size / 1024 / 1024).toFixed(1)}MB — the limit is 8MB. Inline fewer assets or split the page.` }, 413);
    }

    // Access flags → hashed set (needs slug).
    let accessSet: Record<string, unknown> | undefined;
    if (access && typeof access === "object") {
      const existingEditUrl = existing?.edit_mode === "link" && existing?.edit_key ? "set" : null;
      try {
        accessSet = await buildAccessSet(access as AccessInput, slug, existingEditUrl);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "Invalid access flags" }, 400);
      }
    }

    // Unchanged fast path — common under --watch: no blob stores at all.
    if (existing && existing.content_hash === contentHash && !thumb_b64) {
      if (accessSet && Object.keys(accessSet).length) {
        await ctx.runMutation(internal.artifacts.applyManage, { artifact_id: existing._id, set: accessSet });
      }
      const url = artifactUrl(existing.slug);
      return json({
        slug: existing.slug,
        url,
        version: existing.version,
        updated: true,
        unchanged: true,
        manage_url: ownerKey ? `${url}#o=${ownerKey}` : url,
      });
    }

    // Provenance.
    let sessionShortId: string | undefined;
    let sessionConversationId: string | undefined;
    if (typeof session_ref === "string" && session_ref) {
      const resolved = await ctx.runQuery(internal.artifacts.resolveSessionRef, { ref: session_ref, user_id: who.user_id });
      if (resolved) {
        sessionShortId = resolved.short_id;
        sessionConversationId = resolved.conversation_id;
      }
    }

    // --- Store blobs ---
    const storageId = await ctx.storage.store(new Blob([docHtml], { type: "text/html; charset=utf-8" }));
    const sourceStorageId =
      sourceText !== undefined
        ? await ctx.storage.store(new Blob([sourceText], { type: "text/markdown; charset=utf-8" }))
        : undefined;
    const assets = [];
    for (const a of assetInputs) {
      const id = await ctx.storage.store(new Blob([a.bytes as unknown as ArrayBuffer], { type: a.content_type }));
      assets.push({ path: a.path, storage_id: id, content_type: a.content_type, size: a.bytes.byteLength });
    }
    let thumbStorageId;
    if (typeof thumb_b64 === "string" && thumb_b64 && thumb_b64.length < 3 * 1024 * 1024) {
      try {
        const bytes = b64ToBytes(thumb_b64);
        thumbStorageId = await ctx.storage.store(new Blob([bytes as unknown as ArrayBuffer], { type: "image/png" }));
      } catch {
        /* bad thumb never blocks a publish */
      }
    }

    const result = await ctx.runMutation(internal.artifacts.upsertFromPublish, {
      user_id: who.user_id,
      storage_id: storageId,
      title,
      size,
      source_path: source_path || undefined,
      force_new: !!force_new,
      content_hash: contentHash,
      kind,
      source_storage_id: sourceStorageId,
      session_short_id: sessionShortId,
      session_conversation_id: sessionConversationId as never,
      slug,
      owner_key: ownerKey,
      access: accessSet as never,
      assets: assets as never,
      thumb_storage_id: thumbStorageId,
    });
    return json({ ...result, manage_url: result.owner_key ? `${result.url}#o=${result.owner_key}` : result.url });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Internal error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Gate endpoints
// ---------------------------------------------------------------------------

export const unlock = httpAction(async (ctx, request) => {
  try {
    const { slug, password } = await request.json();
    if (!slug || typeof password !== "string") return json({ error: "Missing slug or password" }, 400);
    const artifact = await ctx.runQuery(internal.artifacts.bySlug, { slug });
    if (!artifact?.password_hash) return json({ error: "Not found" }, 404);
    const hash = await passwordHash(password, slug);
    if (hash !== artifact.password_hash) return json({ error: "Wrong password" }, 403);
    return json({ k: await kTokenFor(artifact.password_hash, slug) });
  } catch {
    return json({ error: "Bad request" }, 400);
  }
});

export const emailUnlock = httpAction(async (ctx, request) => {
  try {
    const { slug, email } = await request.json();
    if (!slug || typeof email !== "string" || !email.includes("@") || email.length > 254) {
      return json({ error: "Enter a valid email" }, 400);
    }
    const artifact = await ctx.runQuery(internal.artifacts.bySlug, { slug });
    if (!artifact?.email_gate || !artifact.owner_key) return json({ error: "Not found" }, 404);
    await ctx.runMutation(internal.artifacts.recordViewerEmail, { slug, email });
    return json({ e: await eTokenFor(artifact.owner_key, slug) });
  } catch {
    return json({ error: "Bad request" }, 400);
  }
});

// ---------------------------------------------------------------------------
// Manage (owner_key auth, callable from the served page)
// ---------------------------------------------------------------------------

export const manage = httpAction(async (ctx, request) => {
  try {
    const body = await request.json();
    const { slug, owner_key, set, rollback_to, resolve_comment_id, delete_comment_id } = body;
    if (!slug || !owner_key) return json({ error: "Missing slug or owner_key" }, 400);
    const panel = await ctx.runQuery(internal.artifacts.ownerPanel, { slug, owner_key });
    if (!panel) return json({ error: "Not found" }, 403);

    if (set && typeof set === "object") {
      const accessSet = await buildAccessSet(set as AccessInput, slug, panel.edit_url ? "set" : null);
      if (typeof set.title === "string" && set.title.trim()) accessSet.title = set.title.trim();
      await ctx.runMutation(internal.artifacts.applyManage, { artifact_id: panel.artifact_id, set: accessSet as never });
    }
    if (resolve_comment_id || delete_comment_id) {
      await ctx.runMutation(internal.artifacts.applyManage, {
        artifact_id: panel.artifact_id,
        resolve_comment_id: resolve_comment_id as never,
        delete_comment_id: delete_comment_id as never,
      });
    }
    if (typeof rollback_to === "number") {
      const err = await performRollback(ctx, slug, rollback_to);
      if (err) return json({ error: err }, 400);
    }
    const fresh = await ctx.runQuery(internal.artifacts.ownerPanel, { slug, owner_key });
    return json({ ok: true, ...fresh });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Bad request" }, 400);
  }
});

// ---------------------------------------------------------------------------
// Rollback — promote a past version to a NEW current version, copying its
// blobs (blob-ownership invariant: no row ever shares a storage_id).
// ---------------------------------------------------------------------------

type ActionCtx = Parameters<Parameters<typeof httpAction>[0]>[0];

async function performRollback(ctx: ActionCtx, slug: string, targetVersion: number): Promise<string | null> {
  const art = await ctx.runQuery(internal.artifacts.historyBySlug, { slug });
  if (!art) return "Not found";
  if (targetVersion === art.version) return `v${targetVersion} is already current`;
  const past = art.versions.find((x: { version: number }) => x.version === targetVersion);
  if (!past) return `Version ${targetVersion} is no longer available (history keeps the last 20)`;

  const mainBlob = await ctx.storage.get(past.storage_id);
  if (!mainBlob) return "Version content missing";
  const mainText = await mainBlob.text();
  const newMain = await ctx.storage.store(new Blob([mainText], { type: "text/html; charset=utf-8" }));

  let newSource;
  let sourceText: string | undefined;
  if (past.source_storage_id) {
    const src = await ctx.storage.get(past.source_storage_id);
    if (src) {
      sourceText = await src.text();
      newSource = await ctx.storage.store(new Blob([sourceText], { type: "text/markdown; charset=utf-8" }));
    }
  }

  const pastAssets = await ctx.runQuery(internal.artifacts.assetsForVersion, {
    artifact_id: art._id,
    version: targetVersion,
  });
  const assets = [];
  const assetHashes: string[] = [];
  for (const a of pastAssets) {
    const blob = await ctx.storage.get(a.storage_id);
    if (!blob) continue;
    const buf = await blob.arrayBuffer();
    const id = await ctx.storage.store(new Blob([buf], { type: a.content_type }));
    assets.push({ path: a.path, storage_id: id, content_type: a.content_type, size: a.size });
    const hex = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)), (b) => b.toString(16).padStart(2, "0")).join("");
    assetHashes.push(`${a.path}:${hex}`);
  }

  // Recompute the content hash the same way publish would, so a later
  // identical republish of the restored content no-ops correctly.
  let contentHash: string;
  const kind = past.kind ?? "html";
  if (kind === "markdown" && sourceText !== undefined) {
    contentHash = await sha256Hex(sourceText);
  } else if (kind === "bundle") {
    const parts = [`index.html:${await sha256Hex(mainText)}`, ...assetHashes.sort()];
    contentHash = await sha256Hex(parts.join("\n"));
  } else {
    contentHash = await sha256Hex(mainText);
  }

  await ctx.runMutation(internal.artifacts.appendVersion, {
    artifact_id: art._id,
    storage_id: newMain,
    size: past.size,
    title: past.title,
    kind,
    source_storage_id: newSource,
    content_hash: contentHash,
    edited_by: `rollback to v${targetVersion}`,
    assets: assets as never,
  });
  return null;
}

export const rollback = httpAction(async (ctx, request) => {
  try {
    const { api_token, target, version } = await request.json();
    if (!api_token || !target || typeof version !== "number") {
      return json({ error: "Missing api_token, target, or version" }, 400);
    }
    const resolved = await ctx.runQuery(internal.artifacts.resolveTargetForCLI, { api_token, target });
    if ("error" in resolved && resolved.error) return json({ error: resolved.error }, 403);
    const artifact = (resolved as { artifact: { slug: string } }).artifact;
    if (!artifact) return json({ error: `No artifact matches "${target}"` }, 404);
    const err = await performRollback(ctx, artifact.slug, version);
    if (err) return json({ error: err }, 400);
    const fresh = await ctx.runQuery(internal.artifacts.bySlug, { slug: artifact.slug });
    return json({ slug: artifact.slug, version: fresh?.version, url: artifactUrl(artifact.slug) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Bad request" }, 400);
  }
});

// ---------------------------------------------------------------------------
// Link/owner editing — save publishes a new version
// ---------------------------------------------------------------------------

export const edit = httpAction(async (ctx, request) => {
  try {
    const { slug, key, content, editor_name } = await request.json();
    if (!slug || !key || typeof content !== "string") return json({ error: "Missing slug, key, or content" }, 400);
    const auth = await ctx.runQuery(internal.artifacts.editTarget, { slug, key });
    if (!auth) return json({ error: "This link doesn't grant editing" }, 403);
    const artifact = auth.artifact;
    const kind = artifact.kind ?? "html";

    let docHtml: string;
    let contentHash: string;
    let sourceStorageId;
    if (kind === "markdown") {
      contentHash = await sha256Hex(content);
      docHtml = await renderMarkdown(content, artifact.title);
      sourceStorageId = await ctx.storage.store(new Blob([content], { type: "text/markdown; charset=utf-8" }));
    } else {
      docHtml = content;
      contentHash = await sha256Hex(docHtml);
    }
    const size = new TextEncoder().encode(docHtml).byteLength;
    if (size > MAX_ARTIFACT_BYTES) return json({ error: "Content exceeds the 8MB limit" }, 413);
    if (artifact.content_hash === contentHash && kind !== "bundle") {
      if (sourceStorageId) await ctx.storage.delete(sourceStorageId).catch(() => {});
      return json({ version: artifact.version, unchanged: true });
    }

    const storageId = await ctx.storage.store(new Blob([docHtml], { type: "text/html; charset=utf-8" }));

    // Bundles: the editor edits the entry page; assets carry forward as blob
    // copies (ownership invariant).
    const assets = [];
    if (kind === "bundle") {
      const current = await ctx.runQuery(internal.artifacts.assetsForVersion, {
        artifact_id: artifact._id,
        version: artifact.version,
      });
      for (const a of current) {
        const blob = await ctx.storage.get(a.storage_id);
        if (!blob) continue;
        const buf = await blob.arrayBuffer();
        const id = await ctx.storage.store(new Blob([buf], { type: a.content_type }));
        assets.push({ path: a.path, storage_id: id, content_type: a.content_type, size: a.size });
      }
    }

    const editedBy = auth.is_owner ? undefined : (typeof editor_name === "string" && editor_name.trim() ? editor_name.trim().slice(0, 80) : "link editor");
    const result = await ctx.runMutation(internal.artifacts.appendVersion, {
      artifact_id: artifact._id,
      storage_id: storageId,
      size,
      kind,
      source_storage_id: sourceStorageId,
      content_hash: contentHash,
      edited_by: editedBy,
      assets: assets as never,
    });
    return json({ version: result.version });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Bad request" }, 400);
  }
});

// ---------------------------------------------------------------------------
// Web team editing — an authed convex action (the signed-in gallery calls it
// directly, so no keys ever reach a teammate). Owner always may edit; a
// teammate only when the artifact's edit_mode is "team" and they share a team.
// ---------------------------------------------------------------------------

export const editForWeb = action({
  args: { slug: v.string(), content: v.string(), editor_name: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ version?: number; unchanged?: boolean; error?: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Not signed in" };
    const auth = await ctx.runQuery(internal.artifacts.teamEditAuth, { slug: args.slug, editor_user_id: userId });
    if (!auth) return { error: "You don't have edit access to this artifact" };
    const artifact = auth.artifact;
    const kind = artifact.kind ?? "html";

    let docHtml: string;
    let contentHash: string;
    let sourceStorageId;
    if (kind === "markdown") {
      contentHash = await sha256Hex(args.content);
      docHtml = await renderMarkdown(args.content, artifact.title);
      sourceStorageId = await ctx.storage.store(new Blob([args.content], { type: "text/markdown; charset=utf-8" }));
    } else {
      docHtml = args.content;
      contentHash = await sha256Hex(docHtml);
    }
    const size = new TextEncoder().encode(docHtml).byteLength;
    if (size > MAX_ARTIFACT_BYTES) return { error: "Content exceeds the 8MB limit" };
    if (artifact.content_hash === contentHash && kind !== "bundle") {
      if (sourceStorageId) await ctx.storage.delete(sourceStorageId).catch(() => {});
      return { version: artifact.version, unchanged: true };
    }
    const storageId = await ctx.storage.store(new Blob([docHtml], { type: "text/html; charset=utf-8" }));

    const assets = [];
    if (kind === "bundle") {
      const current = await ctx.runQuery(internal.artifacts.assetsForVersion, {
        artifact_id: artifact._id,
        version: artifact.version,
      });
      for (const a of current) {
        const blob = await ctx.storage.get(a.storage_id);
        if (!blob) continue;
        const buf = await blob.arrayBuffer();
        const id = await ctx.storage.store(new Blob([buf], { type: a.content_type }));
        assets.push({ path: a.path, storage_id: id, content_type: a.content_type, size: a.size });
      }
    }

    const result: { version: number } = await ctx.runMutation(internal.artifacts.appendVersion, {
      artifact_id: artifact._id,
      storage_id: storageId,
      size,
      kind,
      source_storage_id: sourceStorageId,
      content_hash: contentHash,
      edited_by: auth.is_owner ? undefined : (args.editor_name?.trim().slice(0, 80) || auth.editor_name),
      assets: assets as never,
    });
    return { version: result.version };
  },
});

// Source text for the authed web editor (teammates can't use ?src=raw on a
// password-gated artifact — this path is authed instead of token-gated).
export const sourceForWeb = action({
  args: { slug: v.string() },
  handler: async (ctx, args): Promise<{ source?: string; kind?: string; version?: number; error?: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Not signed in" };
    const auth = await ctx.runQuery(internal.artifacts.teamEditAuth, { slug: args.slug, editor_user_id: userId });
    if (!auth) return { error: "You don't have edit access to this artifact" };
    const artifact = auth.artifact;
    const kind = artifact.kind ?? "html";
    const id = kind === "markdown" && artifact.source_storage_id ? artifact.source_storage_id : artifact.storage_id;
    const blob = await ctx.storage.get(id);
    if (!blob) return { error: "Source missing" };
    return { source: await blob.text(), kind, version: artifact.version };
  },
});

// ---------------------------------------------------------------------------
// Comment + view passthroughs (public mutations behind CORS)
// ---------------------------------------------------------------------------

export const comment = httpAction(async (ctx, request) => {
  try {
    const body = await request.json();
    const result = await ctx.runMutation(api.artifacts.submitComments, {
      slug: String(body.slug ?? ""),
      author_name: String(body.author_name ?? ""),
      author_email: typeof body.author_email === "string" ? body.author_email : undefined,
      version: typeof body.version === "number" ? body.version : 0,
      comments: Array.isArray(body.comments)
        ? body.comments.map((c: { text?: unknown; anchor?: unknown }) => ({
            text: String(c?.text ?? ""),
            anchor: typeof c?.anchor === "string" ? c.anchor : undefined,
          }))
        : [],
    });
    return json(result);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Bad request" }, 400);
  }
});

export const view = httpAction(async (ctx, request) => {
  try {
    const body = await request.json();
    await ctx.runMutation(api.artifacts.recordView, {
      slug: String(body.slug ?? ""),
      email: typeof body.email === "string" ? body.email : undefined,
    });
    return json({ ok: true });
  } catch {
    return json({ ok: false });
  }
});

// ---------------------------------------------------------------------------
// GET /cli/a/<slug>[/<asset>] — the serve route with gates and modes
// ---------------------------------------------------------------------------

const notFound = (msg: string) =>
  new Response(msg, { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

const htmlResponse = (html: string, status: number, cache: string) =>
  new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock",
      "X-Robots-Tag": "noindex",
      "Cache-Control": cache,
      "Access-Control-Allow-Origin": "*",
    },
  });

const CACHE_CURRENT = "public, max-age=60, stale-while-revalidate=300";
const CACHE_IMMUTABLE = "public, max-age=3600, stale-while-revalidate=86400";
const CACHE_GATE = "public, max-age=60";

export const serve = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/cli\/a\//, "");
  const [slug, ...tailParts] = rest.split("/");
  const tail = tailParts.join("/");
  if (!slug) return notFound("Artifact not found");
  const apiBase = apiBaseFrom(request);
  const q = url.searchParams;

  const artifact = await ctx.runQuery(internal.artifacts.bySlug, { slug });
  if (!artifact) return notFound("Artifact not found");
  const kind = artifact.kind ?? "html";
  const shareUrl = artifactUrl(artifact.slug);

  // --- Gates (order: expiry → password → email wall) ---
  if (artifact.expires_at && Date.now() > artifact.expires_at) {
    return htmlResponse(expiredPage({ title: artifact.title }), 410, CACHE_GATE);
  }
  let kToken = "";
  if (artifact.password_hash) {
    kToken = await kTokenFor(artifact.password_hash, slug);
    if (q.get("k") !== kToken) {
      if (q.get("meta") === "1") return json({ error: "Locked" }, 403);
      if (q.get("thumb") === "1") return notFound("Not found");
      return htmlResponse(passwordGatePage({ slug, title: artifact.title, apiBase, shareUrl }), 200, CACHE_GATE);
    }
  }
  if (artifact.email_gate && artifact.owner_key) {
    const eToken = await eTokenFor(artifact.owner_key, slug);
    // The email wall is a capture step, not secrecy: meta stays open, thumb
    // stays hidden (no visual leak in unfurls).
    if (q.get("e") !== eToken && q.get("meta") !== "1") {
      if (q.get("thumb") === "1") return notFound("Not found");
      return htmlResponse(emailGatePage({ slug, title: artifact.title, apiBase, shareUrl }), 200, CACHE_GATE);
    }
  }

  // --- ?meta=1 — version/state JSON for the in-page bar (never cached) ---
  if (q.get("meta") === "1") {
    const art = await ctx.runQuery(internal.artifacts.historyBySlug, { slug });
    if (!art) return notFound("Artifact not found");
    return new Response(
      JSON.stringify({
        version: art.version,
        updated_at: art.updated_at,
        kind,
        views: art.views,
        comment_count: artifact.comment_count,
        session: art.session_short_id ? { short_id: art.session_short_id } : null,
        gated: { password: !!art.password_hash, email: !!art.email_gate },
        versions: art.versions.map((x) => ({
          version: x.version,
          title: x.title,
          size: x.size,
          published_at: x.published_at,
          edited_by: x.edited_by,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } },
    );
  }

  // --- ?thumb=1 (gated artifacts never serve it — checked above) ---
  if (q.get("thumb") === "1") {
    if (!artifact.thumb_storage_id) return notFound("No thumbnail");
    const blob = await ctx.storage.get(artifact.thumb_storage_id);
    if (!blob) return notFound("No thumbnail");
    return new Response(blob, {
      status: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": CACHE_IMMUTABLE, "Access-Control-Allow-Origin": "*" },
    });
  }

  // --- Asset paths (current or versioned via _v/N/...) ---
  if (tail) {
    let version = artifact.version;
    let path = tail;
    const versioned = tail.match(/^_v\/(\d+)\/(.+)$/);
    if (versioned) {
      version = parseInt(versioned[1], 10);
      path = versioned[2];
    }
    const asset = await ctx.runQuery(internal.artifacts.assetByPath, { artifact_id: artifact._id, version, path });
    if (!asset) return notFound("Not found");
    const blob = await ctx.storage.get(asset.storage_id);
    if (!blob) return notFound("Not found");
    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": asset.content_type,
        "Cache-Control": versioned ? CACHE_IMMUTABLE : CACHE_CURRENT,
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Bundles need a trailing slash so the document's relative URLs resolve
  // under the slug. (The edge worker rewrites the Location back to its host.)
  if (kind === "bundle" && !url.pathname.endsWith("/")) {
    return new Response(null, {
      status: 301,
      headers: { Location: `${url.pathname}/${url.search}`, "Cache-Control": CACHE_GATE },
    });
  }

  const withHistory = async () => await ctx.runQuery(internal.artifacts.historyBySlug, { slug });

  // --- ?diff=A..B ---
  const diffParam = q.get("diff");
  if (diffParam) {
    const m = diffParam.match(/^(\d+)\.\.(\d+)$/);
    if (!m) return notFound("Bad diff range (use ?diff=2..5)");
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    const art = await withHistory();
    if (!art) return notFound("Artifact not found");
    const va = art.versions.find((x) => x.version === a);
    const vb = art.versions.find((x) => x.version === b);
    if (!va || !vb) return notFound("One of those versions is no longer available (history keeps the last 20)");
    const load = async (row: typeof va) => {
      // Diff the meaningful source: raw markdown for markdown artifacts.
      const id = art.kind === "markdown" && row.source_storage_id ? row.source_storage_id : row.storage_id;
      const blob = await ctx.storage.get(id);
      return blob ? await blob.text() : "";
    };
    const [textA, textB] = [await load(va), await load(vb)];
    if (textA.length > 600_000 || textB.length > 600_000) return notFound("These versions are too large to diff in the browser");
    const { ops } = lineDiff(textA, textB);
    return htmlResponse(
      diffPage({ slug, title: artifact.title, a, b, ops, apiBase, shareUrl }),
      200,
      CACHE_IMMUTABLE,
    );
  }

  // --- version resolution for doc/src/edit ---
  const vParam = q.get("v");
  const wanted = vParam && /^\d+$/.test(vParam) ? parseInt(vParam, 10) : null;
  let doc = {
    storage_id: artifact.storage_id,
    source_storage_id: artifact.source_storage_id,
    title: artifact.title,
    updated_at: artifact.updated_at,
    version: artifact.version,
  };
  if (wanted !== null && wanted !== artifact.version) {
    const art = await withHistory();
    const past = art?.versions.find((x) => x.version === wanted);
    if (!past) return notFound(`Version ${wanted} of this artifact is no longer available`);
    doc = {
      storage_id: past.storage_id,
      source_storage_id: past.source_storage_id,
      title: past.title,
      updated_at: past.published_at,
      version: past.version,
    };
  }

  const loadText = async (id: typeof doc.storage_id) => {
    const blob = await ctx.storage.get(id);
    return blob ? await blob.text() : null;
  };

  // --- ?src=raw | ?src=1 ---
  const srcParam = q.get("src");
  if (srcParam) {
    const sourceId = kind === "markdown" && doc.source_storage_id ? doc.source_storage_id : doc.storage_id;
    const source = await loadText(sourceId);
    if (source === null) return notFound("Source missing");
    if (srcParam === "raw") {
      return new Response(source, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": CACHE_CURRENT, "Access-Control-Allow-Origin": "*" },
      });
    }
    return htmlResponse(
      sourcePage({
        slug,
        title: doc.title,
        source,
        kind,
        version: doc.version,
        apiBase,
        shareUrl,
        canEdit: artifact.edit_mode === "link" || artifact.edit_mode === "team",
      }),
      200,
      doc.version < artifact.version ? CACHE_IMMUTABLE : CACHE_CURRENT,
    );
  }

  // --- ?edit=1 (always current version) ---
  if (q.get("edit") === "1") {
    const sourceId = kind === "markdown" && artifact.source_storage_id ? artifact.source_storage_id : artifact.storage_id;
    const source = await loadText(sourceId);
    if (source === null) return notFound("Source missing");
    return htmlResponse(
      editorPage({ slug, title: artifact.title, kind, source, version: artifact.version, apiBase, shareUrl }),
      200,
      "no-store",
    );
  }

  // --- the document itself ---
  const raw = await loadText(doc.storage_id);
  if (raw === null) return notFound("Artifact content missing");
  let html = raw;
  if (kind === "bundle") {
    html = injectBase(html, doc.version < artifact.version ? `_v/${doc.version}/` : "./");
  }
  // Bake the validated gate tokens into the meta URL so the bar's polling
  // clears the same gates the document did.
  const metaTokens = `${kToken ? `&k=${kToken}` : ""}${artifact.email_gate && q.get("e") ? `&e=${q.get("e")}` : ""}`;
  const branded = brandArtifactHtml(html, {
    title: doc.title,
    author: artifact.author_name,
    updatedAt: doc.updated_at,
    shareUrl,
    version: doc.version,
    currentVersion: artifact.version,
    metaUrl: `${apiBase}/cli/a/${artifact.slug}?meta=1${metaTokens}`,
    apiBase,
    slug: artifact.slug,
    kind,
    sessionShortId: artifact.session_short_id ?? null,
    views: artifact.views,
    commentCount: artifact.comment_count,
    gated: { password: !!artifact.password_hash, email: !!artifact.email_gate },
    editMode: artifact.edit_mode ?? "owner",
    live: q.get("live") === "1",
    hasThumb: !!artifact.thumb_storage_id,
  });
  return htmlResponse(branded, 200, doc.version < artifact.version ? CACHE_IMMUTABLE : CACHE_CURRENT);
});

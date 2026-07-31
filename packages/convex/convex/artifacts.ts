// Published HTML artifacts — `cast publish <file.html>` → https://codecast.sh/a/<slug>.
//
// Access model mirrors doc share links: the slug is an unguessable secret, so
// anyone holding the URL can view. The HTML body lives in Convex file storage
// (rows stay small, no document-size ceiling); the raw page is served by the
// GET /cli/a/<slug> HTTP action in http.ts, and the codecast.sh/a/<slug>
// wrapper page renders it in a sandboxed iframe with share controls.
//
// Publish identity: (user_id, source_path). Re-publishing the same file updates
// the same artifact in place — the URL is stable across revisions — unless the
// caller forces a fresh one (`cast publish --new`).

import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Serve-time branding: the raw artifact HTML is the document users share, so
// the codecast chrome is injected INTO it — a slim sticky header that occupies
// layout space (in-flow, never floating over content) plus og meta tags. No
// wrapper page, no iframe, no SPA: one fast response.
// ---------------------------------------------------------------------------

// The codecast mark (components/Logo.tsx paths, 1024 canvas). C follows
// currentColor via the bar's text color; the coral arrow is theme-stable.
const LOGO_C =
  "M484.642334,414.398438 C441.085785,414.100739 407.961426,431.836365 389.038177,470.938019 C359.991791,530.957275 397.919464,599.922302 462.212036,610.452393 C488.377197,614.737732 512.859131,609.315125 534.993835,594.283020 C536.985901,592.930176 538.769653,590.998291 541.395325,590.790649 C542.830750,592.057068 542.358704,593.648865 542.360229,595.064209 C542.383118,615.894470 542.245728,636.725830 542.454224,657.553894 C542.495239,661.645569 540.944946,663.478516 537.347595,664.804260 C457.310547,694.300720 365.884827,658.371399 330.527679,577.853210 C318.822357,551.196838 314.364532,523.336731 317.783875,494.457825 C326.474518,421.058838 381.311096,368.253448 444.614929,354.822266 C476.047852,348.153107 507.120667,349.994629 537.405273,361.541992 C541.135986,362.964569 542.456543,364.823730 542.420715,368.821503 C542.237122,389.316772 542.366028,409.814758 542.335571,430.311707 C542.333191,431.888306 542.886780,433.635895 541.039673,435.579559 C524.470764,423.311615 505.857056,415.935822 484.642334,414.398438z";
const LOGO_ARROW =
  "M595.160889,540.159180 C602.995361,532.661072 610.436890,525.255066 618.219727,518.227051 C621.594788,515.179443 621.862915,513.288818 618.369263,510.015167 C605.976135,498.402374 593.950073,486.398682 581.638672,474.697052 C578.746277,471.947968 577.631470,469.026062 577.653381,465.050171 C577.786804,440.902161 577.692810,416.752869 577.674988,392.604004 C577.673828,390.969238 577.674927,389.334503 577.674927,387.822937 C580.475952,386.927032 581.524963,388.753571 582.754211,389.949341 C611.163818,417.584045 639.573853,445.218567 667.919434,472.919006 C680.901062,485.605255 693.661133,498.519287 706.712463,511.132599 C709.948914,514.260376 709.647461,516.128052 706.514099,519.115662 C674.820679,549.334167 643.279907,579.712769 611.649353,609.997375 C601.908936,619.323242 592.027832,628.502197 582.202148,637.738831 C581.252808,638.631287 580.419067,639.758240 578.788452,639.713379 C577.032288,638.391235 577.739929,636.409241 577.736206,634.708374 C577.682861,610.393066 577.748169,586.077332 577.625610,561.762512 C577.608215,558.319458 578.534119,555.799866 581.153076,553.487549 C585.892944,549.302612 590.338135,544.783875 595.160889,540.159180z";

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface BrandOpts {
  title: string;
  author?: string | null;
  updatedAt: number;
  shareUrl: string;
}

// Everything is id-prefixed __cc_ and the styles are scoped to those ids, so
// the bar can't collide with or restyle the artifact's own markup. The bar is
// `position: sticky`: it takes layout space at the top (content starts below
// it) and stays visible on scroll — never an overlay.
function barHtml(o: BrandOpts): string {
  const when = new Date(o.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `
<style id="__cc_style">
  #__cc_bar { position: sticky; top: 0; z-index: 2147483647; display: flex; align-items: center; gap: 10px;
    box-sizing: border-box; width: 100%; padding: 7px 14px;
    font: 500 12px/1 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    background: #ffffff; color: #52524e; box-shadow: 0 1px 6px rgba(0,0,0,.08);
    text-align: left; }
  #__cc_bar .__cc_brand { color: #444444; text-decoration: none; display: inline-flex; align-items: center; }
  #__cc_bar .__cc_brand:hover { color: #1a1a18; }
  #__cc_bar .__cc_title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; opacity: .7; }
  #__cc_bar .__cc_when { opacity: .5; font-weight: 400; white-space: nowrap; }
  #__cc_bar button { all: unset; cursor: pointer; padding: 4px 8px; border-radius: 6px; font: inherit; white-space: nowrap; }
  #__cc_bar button:hover { background: rgba(0,0,0,.06); }
</style>
<div id="__cc_bar">
  <a class="__cc_brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer" title="Published with codecast"><svg width="22" height="22" viewBox="290 340 440 340" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="${LOGO_C}"/><path fill="#e86c5d" d="${LOGO_ARROW}"/></svg></a>
  <span class="__cc_title">${escAttr(o.title)}</span>
  <span class="__cc_when" id="__cc_when" data-ts="${o.updatedAt}">updated ${escAttr(when)}</span>
  <button id="__cc_copy" type="button" data-url="${escAttr(o.shareUrl)}">Copy link</button>
</div>
<script>(function(){
  var w=document.getElementById("__cc_when");
  if(w){var ts=+w.getAttribute("data-ts");var rel=function(){var s=Math.max(0,(Date.now()-ts)/1e3);
    w.textContent="updated "+(s<60?"just now":s<3600?Math.floor(s/60)+"m ago":s<86400?Math.floor(s/3600)+"h ago":s<2592e3?Math.floor(s/86400)+"d ago":new Date(ts).toLocaleDateString());};
    rel();setInterval(rel,6e4);}
  var b=document.getElementById("__cc_copy");
  if(b)b.addEventListener("click",function(){
    var u=b.getAttribute("data-url");
    var done=function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy link"},1500);};
    var fallback=function(){var t=document.createElement("textarea");t.value=u;t.style.position="fixed";t.style.opacity="0";
      document.body.appendChild(t);t.select();try{document.execCommand("copy");done();}catch(e){window.prompt("Copy link:",u);}t.remove();};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done,fallback);}else{fallback();}
  });
})();</script>`;
}

function ogMeta(o: BrandOpts): string {
  const author = o.author ? ` by ${escAttr(o.author)}` : "";
  return `
<meta property="og:title" content="${escAttr(o.title)}">
<meta property="og:description" content="An HTML artifact published${author} with codecast">
<meta property="og:url" content="${escAttr(o.shareUrl)}">
<meta property="og:site_name" content="codecast">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary">
<meta name="robots" content="noindex">`;
}

/**
 * Inject the codecast header bar (after <body>, else prepended) and og meta
 * (after <head>, when one exists) into an artifact's HTML. The artifact's own
 * markup — including its <title> — is never modified, only added to.
 */
export function brandArtifactHtml(html: string, opts: BrandOpts): string {
  let out = html;
  const headMatch = out.match(/<head[^>]*>/i);
  if (headMatch) {
    const at = out.indexOf(headMatch[0]) + headMatch[0].length;
    out = out.slice(0, at) + ogMeta(opts) + out.slice(at);
  }
  const bar = barHtml(opts);
  const bodyMatch = out.match(/<body[^>]*>/i);
  if (bodyMatch) {
    const at = out.indexOf(bodyMatch[0]) + bodyMatch[0].length;
    return out.slice(0, at) + bar + out.slice(at);
  }
  return bar + out;
}

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SLUG_LENGTH = 12; // ~71 bits of entropy — the slug IS the access gate.

export function newSlug(): string {
  const bytes = new Uint8Array(SLUG_LENGTH);
  crypto.getRandomValues(bytes);
  let slug = "";
  for (const b of bytes) slug += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return slug;
}

function artifactUrl(slug: string): string {
  return `${process.env.SITE_URL || "https://codecast.sh"}/a/${slug}`;
}

function toCliRow(a: Doc<"artifacts">) {
  return {
    slug: a.slug,
    title: a.title,
    source_path: a.source_path,
    size: a.size,
    version: a.version,
    created_at: a.created_at,
    updated_at: a.updated_at,
    url: artifactUrl(a.slug),
  };
}

// Pre-check for the publish HTTP action: it must resolve the user BEFORE
// storing the blob, so an unauthorized call never leaves an orphaned storage
// object behind.
export const verify = internalQuery({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    return result ? { user_id: result.userId } : null;
  },
});

export const bySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!artifact) return null;
    const user = await ctx.db.get(artifact.user_id);
    return { ...artifact, author_name: user?.name ?? null };
  },
});

// Called by the publish HTTP action after it has stored the blob. Updates the
// existing artifact for this (user, source_path) in place — deleting the
// superseded blob — or creates a new row.
export const upsertFromPublish = internalMutation({
  args: {
    user_id: v.id("users"),
    storage_id: v.id("_storage"),
    title: v.string(),
    size: v.number(),
    source_path: v.optional(v.string()),
    force_new: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing =
      !args.force_new && args.source_path
        ? await ctx.db
            .query("artifacts")
            .withIndex("by_user_path", (q) =>
              q.eq("user_id", args.user_id).eq("source_path", args.source_path),
            )
            .first()
        : null;

    const now = Date.now();

    if (existing) {
      const version = existing.version + 1;
      await ctx.storage.delete(existing.storage_id).catch(() => {});
      await ctx.db.patch(existing._id, {
        storage_id: args.storage_id,
        title: args.title,
        size: args.size,
        version,
        updated_at: now,
      });
      return { slug: existing.slug, url: artifactUrl(existing.slug), version, updated: true };
    }

    let slug = newSlug();
    // Collision is ~impossible at 71 bits, but a slug is a permanent public
    // URL — spend one read to keep it impossible.
    while (await ctx.db.query("artifacts").withIndex("by_slug", (q) => q.eq("slug", slug)).first()) {
      slug = newSlug();
    }

    await ctx.db.insert("artifacts", {
      slug,
      user_id: args.user_id,
      title: args.title,
      source_path: args.source_path,
      storage_id: args.storage_id,
      size: args.size,
      version: 1,
      created_at: now,
      updated_at: now,
    });
    return { slug, url: artifactUrl(slug), version: 1, updated: false };
  },
});

export const listFromCLI = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_user", (q) => q.eq("user_id", auth.userId))
      .collect();
    rows.sort((a, b) => b.updated_at - a.updated_at);
    return { artifacts: rows.map(toCliRow) };
  },
});

// `target` is a slug, an exact source path, or a path suffix (basename
// convenience: `cast publish rm report.html`). Suffix matches only win when
// unambiguous — otherwise the caller gets the candidates to pick from.
export const deleteFromCLI = mutation({
  args: { api_token: v.string(), target: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };

    const bySlugMatch = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.target))
      .first();

    let match = bySlugMatch && bySlugMatch.user_id === auth.userId ? bySlugMatch : null;

    if (!match) {
      const mine = await ctx.db
        .query("artifacts")
        .withIndex("by_user", (q) => q.eq("user_id", auth.userId))
        .collect();
      const suffix = args.target.startsWith("/") ? args.target : `/${args.target}`;
      const candidates = mine.filter(
        (a) => a.source_path === args.target || a.source_path?.endsWith(suffix),
      );
      if (candidates.length > 1) {
        // Folded into the error string because the CLI's cliPost helper prints
        // `error` and exits — structured extras would never reach the user.
        const listing = candidates.map((a) => `  ${a.slug}  ${a.title}`).join("\n");
        return {
          error: `"${args.target}" matches ${candidates.length} artifacts — use a slug:\n${listing}`,
        };
      }
      match = candidates[0] ?? null;
    }

    if (!match) return { error: `No artifact matches "${args.target}"` };

    await ctx.storage.delete(match.storage_id).catch(() => {});
    await ctx.db.delete(match._id);
    return { deleted: toCliRow(match) };
  },
});

// Viewer metadata for the codecast.sh/a/<slug> wrapper page and link unfurls.
// Content itself is served by the HTTP action; this exposes no more than the
// slug already grants.
export const getShared = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!artifact) return null;
    const user = await ctx.db.get(artifact.user_id);
    return {
      slug: artifact.slug,
      title: artifact.title,
      size: artifact.size,
      version: artifact.version,
      created_at: artifact.created_at,
      updated_at: artifact.updated_at,
      user: user ? { name: user.name, image: user.image } : null,
    };
  },
});

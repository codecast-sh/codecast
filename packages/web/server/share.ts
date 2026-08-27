import type { Context, Hono, Next } from "hono";
import { stream } from "hono/streaming";
import { readFile } from "fs/promises";
import { join } from "path";
import { api } from "../../convex/convex/_generated/api.js";
import { convex } from "./bot-meta";

/**
 * Share pages, made fast.
 *
 * A share link is an anonymous cold load: the visitor pays for the SPA shell,
 * the app bundle, a Convex WebSocket handshake, and only then the query that
 * holds the shared content. This module removes the two waits the server can
 * remove without a client rebuild:
 *
 * 1. The DATA wait — the server runs the same public share query the client
 *    would run (it already holds a ConvexHttpClient for bot unfurls) and
 *    inlines the result into the HTML as window.__SHARE_PRELOAD__. The client
 *    renders from it immediately; its own live query takes over when the
 *    socket is up.
 *
 * 2. A MODULE round trip — the built entry (index-*.js) is a 4KB stub that
 *    dynamically imports the real app, so the big chunks normally start
 *    downloading only after the stub arrives. Injected modulepreload links
 *    start them in parallel with the stub. Only share routes get this: the
 *    stub is deliberately lazy so the desktop handoff can skip the app, and
 *    share links never open in the desktop shell.
 *
 * /share/<token> (whole-conversation links) needs neither: its page only
 * resolved the token to a conversation id and client-redirected. The server
 * does that lookup itself and answers 302 — the browser re-attaches any
 * #msg- fragment to the redirect target per spec, so deep links survive.
 *
 * Responses carry s-maxage so a CDN in front (Cloudflare proxy on the zone)
 * can serve repeat visitors from the edge; browsers themselves always
 * revalidate (max-age=0), keeping republish staleness bounded by the edge TTL.
 */

const DIST_DIR = join(import.meta.dirname, "../dist");

// Share HTML is personal-ish only in the sense of being token-gated; the token
// is in the URL, so per-URL edge caching leaks nothing beyond what the URL
// already grants.
const SHARE_HTML_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";
const REDIRECT_CACHE = "public, max-age=0, s-maxage=300";

const TOKEN_RE = /^[A-Za-z0-9_-]{6,80}$/;

// --- Shell HTML + preload links, computed once per process --------------------

interface Shell {
  html: string;
  /** Everything before </body> — sent first so asset downloads start immediately. */
  head: string;
  /** </body> onward — sent after the payload script. */
  tail: string;
  /** modulepreload links for the app chunks. */
  injected: string;
}

let shellPromise: Promise<Shell | null> | null = null;

async function loadShell(): Promise<Shell | null> {
  try {
    const html = await readFile(join(DIST_DIR, "index.html"), "utf-8");
    // The entry stub's static text carries the asset names of every chunk it
    // will preload for the dynamic app import — surface them as modulepreload
    // so the downloads overlap the stub's own round trip.
    let links = "";
    const entry = html.match(/src="(\/assets\/index-[\w-]+\.js)"/)?.[1];
    if (entry) {
      try {
        const stub = await readFile(join(DIST_DIR, entry.slice(1)), "utf-8");
        const chunks = [...new Set(stub.match(/assets\/[\w.-]+\.js/g) ?? [])]
          .filter((a) => !a.includes("legacy"))
          .slice(0, 20);
        links = chunks.map((a) => `<link rel="modulepreload" crossorigin href="/${a}">`).join("");
      } catch {}
    }
    const bodyEnd = html.lastIndexOf("</body>");
    const head = bodyEnd === -1 ? html : html.slice(0, bodyEnd);
    const tail = bodyEnd === -1 ? "" : html.slice(bodyEnd);
    return { html, head, tail, injected: links };
  } catch {
    return null;
  }
}

export function getShell(): Promise<Shell | null> {
  if (!shellPromise) shellPromise = loadShell();
  return shellPromise;
}

/** The plain app shell from the in-memory cache (for the catch-all route). */
export async function getShellHtml(): Promise<string | null> {
  const shell = await getShell();
  return shell?.html ?? null;
}

// --- Tiny TTL cache over the share queries ------------------------------------
// Protects Convex from repeat loads of a hot link and keeps server TTFB flat.
// A null QUERY RESULT is cached and inlined (the client shows its not-found
// state instantly); a FAILED query is not cached and inlines nothing.

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached(key: string, fetch: () => Promise<unknown>): Promise<{ value: unknown } | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { value: hit.value };
  try {
    const value = await fetch();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > MAX_ENTRIES) {
      for (const k of cache.keys()) {
        if (cache.size <= MAX_ENTRIES) break;
        cache.delete(k);
      }
    }
    return { value };
  } catch {
    return null; // query failed — serve the shell untouched, client retries live
  }
}

// --- HTML assembly ------------------------------------------------------------

/** JSON safe to embed in an inline <script>: no `</script>` breakout, no raw
 * line separators (valid JSON, invalid JS string literals pre-ES2019). */
function scriptSafeJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return null;
    return json
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  } catch {
    return null;
  }
}

// Above this the inline payload starts hurting first paint more than the saved
// round trip helps; the client just falls back to the live query.
const MAX_INLINE_JSON = 1_500_000;

function injectHead(html: string, fragment: string): string {
  return html.replace("</head>", `${fragment}</head>`);
}

// --- Routes -------------------------------------------------------------------

type ShareKind = "message" | "doc" | "plan";

const SHARE_QUERIES: Record<ShareKind, (token: string) => Promise<unknown>> = {
  message: (t) => convex.query(api.messages.getSharedMessage, { share_token: t }),
  doc: (t) => convex.query((api as any).docs.getShared, { share_token: t }),
  plan: (t) => convex.query((api as any).plans.getShared, { share_token: t }),
};

// Streamed in two parts: the head goes out before the share query is even
// sent, so the browser starts the bundle downloads while Convex is answering
// (a cold HTTP query costs 0.5-2s — fully hidden behind the ~3s of asset
// transfer). The payload script lands just before </body>; module scripts
// are deferred until parsing completes, so it always runs first.
function shareHandler(kind: ShareKind) {
  return async (c: Context, next: Next) => {
    const token = c.req.param("token");
    const shell = await getShell();
    if (!shell || !TOKEN_RE.test(token)) return next();

    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", SHARE_HTML_CACHE);
    return stream(c, async (out) => {
      await out.write(injectHead(shell.head, shell.injected));
      const result = await cached(`${kind}:${token}`, () => SHARE_QUERIES[kind](token));
      if (result) {
        const json = scriptSafeJson({ kind, token, data: result.value });
        if (json && json.length <= MAX_INLINE_JSON) {
          await out.write(`<script>window.__SHARE_PRELOAD__=${json}</script>`);
        }
      }
      await out.write(shell.tail);
    });
  };
}

export function registerShareRoutes(app: Hono) {
  app.get("/share/message/:token", shareHandler("message"));
  app.get("/share/doc/:token", shareHandler("doc"));
  app.get("/share/plan/:token", shareHandler("plan"));

  // Whole-conversation share links: resolve the token server-side and skip the
  // intermediate app boot entirely.
  app.get("/share/:token", async (c, next) => {
    const token = c.req.param("token");
    if (!TOKEN_RE.test(token)) return next();
    const result = await cached(`conv:${token}`, () =>
      convex.query(api.conversations.getSharedConversationMeta, { share_token: token })
    );
    const id = (result?.value as { conversation_id?: string } | null)?.conversation_id;
    // No id: unknown token (client renders its invalid-link page) or a convex
    // deploy that predates the field — either way the SPA path still works.
    if (!id) {
      const shell = await getShell();
      if (!shell) return next();
      c.header("Cache-Control", SHARE_HTML_CACHE);
      return c.html(injectHead(shell.html, shell.injected));
    }
    c.header("Cache-Control", REDIRECT_CACHE);
    return c.redirect(`/conversation/${id}?share=${encodeURIComponent(token)}`, 302);
  });
}

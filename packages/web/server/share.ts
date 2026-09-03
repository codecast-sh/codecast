import type { Context, Hono, Next } from "hono";
import { stream } from "hono/streaming";
import { readFile } from "fs/promises";
import { join } from "path";
import { fetchShared } from "./shareData";

/**
 * Share pages, made fast.
 *
 * A share link is an anonymous cold load: the visitor pays for the SPA shell,
 * the app bundle, a Convex WebSocket handshake, and only then the query that
 * holds the shared content. The server removes every wait it can:
 *
 * 1. CONTENT at first byte — it runs the same public share query the client
 *    would run (it already holds a ConvexHttpClient for bot unfurls) and
 *    renders the page into #root with the SSR bundle (dist-ssr/share-ssr.mjs,
 *    built by vite.prerender.config.ts). The shell's #root:not(:empty) rule
 *    hides the boot loader on its own. The visitor reads the message before a
 *    byte of JavaScript has arrived.
 *
 * 2. No DATA wait — the same payload (and the clock it was rendered with) is
 *    inlined as window.__SHARE_PRELOAD__, so the client hydrates the markup
 *    instead of re-fetching; its live query takes over when the socket is up.
 *    Without the SSR bundle this alone still paints as soon as JS runs.
 *
 * 3. No serial round trip — the built entry is a stub that dynamically imports
 *    the standalone share entry (src/shareBoot.tsx), so its chunks would start
 *    downloading only after the stub arrives. The head carries modulepreload
 *    hints for that entry's static import graph (read from Vite's build
 *    manifest) and streams out before the share query is even sent, so the
 *    downloads overlap the Convex latency.
 *
 * /share/<token> (whole-conversation links) needs none of it: its page only
 * resolved the token to a conversation id and client-redirected. The server
 * does that lookup itself and answers 302 — the browser re-attaches any
 * #msg- fragment to the redirect target per spec, so deep links survive.
 *
 * Responses carry s-maxage so a CDN in front (Cloudflare proxy on the zone)
 * can serve repeat visitors from the edge; browsers themselves always
 * revalidate (max-age=0), keeping republish staleness bounded by the edge TTL.
 */

const DIST_DIR = join(import.meta.dirname, "../dist");
const SSR_DIR = join(import.meta.dirname, "../dist-ssr");

// Share HTML is personal-ish only in the sense of being token-gated; the token
// is in the URL, so per-URL edge caching leaks nothing beyond what the URL
// already grants.
const SHARE_HTML_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";
const REDIRECT_CACHE = "public, max-age=0, s-maxage=300";

const TOKEN_RE = /^[A-Za-z0-9_-]{6,80}$/;

// --- Shell HTML, split once per process ----------------------------------------

interface Shell {
  html: string;
  /** Up to and including the opening <div id="root">, with the share entry's
   * modulepreload hints in the head: streamed first. */
  pre: string;
  /** From the root's closing tag to </body>: after the rendered markup. */
  mid: string;
  /** </body> onward: after the payload script. */
  tail: string;
}

const SHARE_ENTRY = "src/shareBoot.tsx";

/** modulepreload hints for the share entry and everything it statically
 * imports, from dist/.vite/manifest.json (build.manifest in vite.config.ts).
 * Empty when the manifest is missing — the page still works, one round trip
 * slower. */
async function sharePreloadLinks(): Promise<string> {
  try {
    const raw = await readFile(join(DIST_DIR, ".vite", "manifest.json"), "utf-8");
    const manifest = JSON.parse(raw) as Record<string, { file: string; imports?: string[] }>;
    if (!manifest[SHARE_ENTRY]) return "";
    const files: string[] = [];
    const seen = new Set<string>();
    const walk = (key: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      const entry = manifest[key];
      if (!entry) return;
      files.push(entry.file);
      for (const next of entry.imports ?? []) walk(next);
    };
    walk(SHARE_ENTRY);
    return files.map((f) => `<link rel="modulepreload" crossorigin href="/${f}">`).join("");
  } catch {
    return "";
  }
}

let shellPromise: Promise<Shell | null> | null = null;

async function loadShell(): Promise<Shell | null> {
  try {
    const html = await readFile(join(DIST_DIR, "index.html"), "utf-8");
    const rootTag = '<div id="root">';
    const rootAt = html.indexOf(rootTag);
    const bodyEnd = html.lastIndexOf("</body>");
    if (rootAt === -1 || bodyEnd === -1) return { html, pre: html, mid: "", tail: "" };
    const preEnd = rootAt + rootTag.length;
    const pre = html.slice(0, preEnd).replace("</head>", `${await sharePreloadLinks()}</head>`);
    return { html, pre, mid: html.slice(preEnd, bodyEnd), tail: html.slice(bodyEnd) };
  } catch {
    return null;
  }
}

export function getShell(): Promise<Shell | null> {
  if (!shellPromise) shellPromise = loadShell();
  return shellPromise;
}

// --- Server renderer (optional) ----------------------------------------------
// The SSR bundle is a build artifact; a server without it (a partial build, a
// dev checkout) still serves the payload-only shell.

type RenderShare = (kind: string, path: string, data: unknown, now: number) => string | null;
let rendererPromise: Promise<RenderShare | null> | null = null;

function getRenderer(): Promise<RenderShare | null> {
  if (!rendererPromise) {
    rendererPromise = import(join(SSR_DIR, "share-ssr.mjs"))
      .then((m) => (typeof m.renderShare === "function" ? (m.renderShare as RenderShare) : null))
      .catch((err: unknown) => {
        // Loud on purpose. The fallback is invisible to visitors (the page
        // still works, just later), which is how a broken SSR build once went
        // a week unnoticed. /api/health reports the same state.
        console.error(
          "[share] SSR bundle missing or broken (dist-ssr/share-ssr.mjs): share pages fall back to the payload-only shell.",
          err instanceof Error ? err.message : err,
        );
        return null;
      });
  }
  return rendererPromise;
}

/** Whether share pages are being server-rendered on this process (for /api/health). */
export async function shareSsrReady(): Promise<boolean> {
  return (await getRenderer()) !== null;
}

/** The plain app shell from the in-memory cache (for the catch-all route). */
export async function getShellHtml(): Promise<string | null> {
  const shell = await getShell();
  return shell?.html ?? null;
}

// --- HTML assembly ------------------------------------------------------------

/** JSON safe to embed in an inline <script>: no `</script>` breakout, no raw
 * line separators (valid JSON, invalid JS string literals pre-ES2019). */
export function scriptSafeJson(value: unknown): string | null {
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

// --- Routes -------------------------------------------------------------------

type SsrShareKind = "message" | "doc" | "plan";

// Streamed in two parts: everything up to the root div goes out before the
// share query is even sent, so the browser starts the chunk downloads while
// Convex is answering (a cold HTTP query costs 0.5-2s). Then the rendered
// page, the rest of the shell, and the payload script just before </body> —
// module scripts are deferred until parsing completes, so it always runs
// before the hydration pass reads it.
function shareHandler(kind: SsrShareKind) {
  return async (c: Context, next: Next) => {
    const token = c.req.param("token") ?? "";
    const shell = await getShell();
    if (!shell || !TOKEN_RE.test(token)) return next();
    const path = new URL(c.req.url).pathname;

    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", SHARE_HTML_CACHE);
    return stream(c, async (out) => {
      await out.write(shell.pre);
      const [result, render] = await Promise.all([
        fetchShared(kind, token),
        getRenderer(),
      ]);
      const now = Date.now();
      let markup = "";
      let json: string | null = null;
      if (result) {
        json = scriptSafeJson({ kind, token, data: result.value, now });
        if (json && json.length > MAX_INLINE_JSON) json = null;
        // Markup without its payload would hydrate against nothing and be
        // thrown away; render only when the client can match it.
        if (json && render) {
          try {
            markup = render(kind, path, result.value, now) ?? "";
          } catch (err) {
            console.error(`[share] render failed for ${kind}:${token}`, err);
            markup = "";
          }
        }
      }
      await out.write(markup + shell.mid);
      if (json) await out.write(`<script>window.__SHARE_PRELOAD__=${json}</script>`);
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
    const token = c.req.param("token") ?? "";
    if (!TOKEN_RE.test(token)) return next();
    const result = await fetchShared("conversation", token);
    const id = (result?.value as { conversation_id?: string } | null)?.conversation_id;
    // No id: unknown token (client renders its invalid-link page) or a convex
    // deploy that predates the field — either way the SPA path still works.
    if (!id) {
      const shell = await getShell();
      if (!shell) return next();
      c.header("Cache-Control", SHARE_HTML_CACHE);
      return c.html(shell.html);
    }
    c.header("Cache-Control", REDIRECT_CACHE);
    return c.redirect(`/conversation/${id}?share=${encodeURIComponent(token)}`, 302);
  });
}

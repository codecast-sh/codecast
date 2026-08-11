/**
 * Build-time prerender of the marketing routes + sitemap generation.
 *
 * Runs at the end of `npm run build`:
 *   1. SSR-builds src/prerender-entry.tsx (vite.prerender.config.ts → dist-ssr/).
 *   2. Renders every route in lib/seoRoutes.ts to full HTML documents under
 *      dist/prerender/<path>/index.html — the built index.html shell with the
 *      route's rendered markup injected into #root and its real title,
 *      description, canonical, and og tags swapped into <head>.
 *   3. Writes dist/prerender/manifest.json (what server/bot-meta.ts serves
 *      snapshots from) and dist/sitemap.xml.
 *
 * FAIL-OPEN: SEO must never block a deploy. Any failure logs loudly and exits
 * 0 — the server falls back to the SPA shell for routes with no snapshot.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(WEB_ROOT, "dist");
const OUT = join(DIST, "prerender");

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * JSON-LD for the crawler snapshots: SoftwareApplication on the homepage,
 * Article on blog posts and guides. Kept to fields we can fill truthfully from
 * the SEO manifest — no invented ratings or review counts.
 */
function jsonLd(entry, siteUrl) {
  const url = entry.path === "/" ? siteUrl : `${siteUrl}${entry.path}`;
  let data;
  if (entry.path === "/") {
    data = {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Codecast",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows, iOS, Web",
      description: entry.description,
      url: siteUrl,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@type": "Organization", name: "codecast", url: siteUrl },
    };
  } else if (entry.path.startsWith("/blog/") || entry.path.startsWith("/documentation/")) {
    data = {
      "@context": "https://schema.org",
      "@type": entry.path.startsWith("/blog/") ? "Article" : "TechArticle",
      headline: entry.title,
      description: entry.description,
      url,
      publisher: { "@type": "Organization", name: "codecast", url: siteUrl },
    };
  } else {
    return null;
  }
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

function buildHead(entry, siteUrl) {
  const url = entry.path === "/" ? siteUrl : `${siteUrl}${entry.path}`;
  const ld = jsonLd(entry, siteUrl);
  return [
    `<title>${esc(entry.title)}</title>`,
    `<meta name="description" content="${esc(entry.description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:title" content="${esc(entry.title)}" />`,
    `<meta property="og:description" content="${esc(entry.description)}" />`,
    `<meta property="og:site_name" content="codecast" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${siteUrl}/logo-final.png" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${esc(entry.title)}" />`,
    `<meta name="twitter:description" content="${esc(entry.description)}" />`,
    `<meta name="twitter:image" content="${siteUrl}/logo-final.png" />`,
    ...(ld ? [ld] : []),
  ].join("\n    ");
}

/** Strip the shell's own title/description/og/twitter tags so the injected set is the only one. */
function stripShellMeta(shell) {
  return shell
    .replace(/<title>[\s\S]*?<\/title>\s*/, "")
    .replace(/<meta name="description"[^>]*\/>\s*/g, "")
    .replace(/<meta property="og:[^"]*"[^>]*\/>\s*/g, "")
    .replace(/<meta name="twitter:[^"]*"[^>]*\/>\s*/g, "");
}

async function main() {
  // 1. SSR build
  execFileSync(
    process.execPath,
    [join(WEB_ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "-c", "vite.prerender.config.ts"],
    { cwd: WEB_ROOT, stdio: "inherit" },
  );

  const entryMod = await import(pathToFileURL(join(WEB_ROOT, "dist-ssr", "prerender-entry.mjs")).href);
  const { render, SEO_ROUTES, SITE_URL } = entryMod;

  const shellRaw = readFileSync(join(DIST, "index.html"), "utf-8");
  const ROOT_DIV = '<div id="root"></div>';
  if (!shellRaw.includes(ROOT_DIV)) throw new Error("dist/index.html has no empty #root div to inject into");
  const shell = stripShellMeta(shellRaw);
  if (!shell.includes("<head>")) throw new Error("dist/index.html has no <head>");

  rmSync(OUT, { recursive: true, force: true });
  const manifest = [];
  let failed = 0;
  for (const entry of SEO_ROUTES) {
    try {
      const html = render(entry.path);
      if (!html || html.length < 500) throw new Error(`suspiciously small render (${html.length} bytes)`);
      const doc = shell
        .replace("<head>", `<head>\n    ${buildHead(entry, SITE_URL)}`)
        .replace(ROOT_DIV, `<div id="root">${html}</div>`);
      const dir = entry.path === "/" ? OUT : join(OUT, ...entry.path.split("/").filter(Boolean));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), doc);
      manifest.push(entry.path);
    } catch (err) {
      failed++;
      console.error(`prerender FAILED for ${entry.path} (crawlers get the SPA shell for it):`, err?.message ?? err);
    }
  }
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

  // 3. sitemap.xml — every route that actually has content to crawl.
  const today = new Date().toISOString().slice(0, 10);
  const urls = SEO_ROUTES.map((e) => {
    const loc = e.path === "/" ? `${SITE_URL}/` : `${SITE_URL}${e.path}`;
    return `  <url><loc>${esc(loc)}</loc><lastmod>${today}</lastmod></url>`;
  }).join("\n");
  writeFileSync(
    join(DIST, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );

  // 4. llms.txt — a plain-text site map for AI crawlers (llmstxt.org format).
  // Derived from the same manifest, so it stays current for free.
  const home = SEO_ROUTES.find((e) => e.path === "/");
  const section = (title, filter) => {
    const rows = SEO_ROUTES.filter(filter)
      .map((e) => `- [${e.title}](${SITE_URL}${e.path === "/" ? "" : e.path}): ${e.description}`)
      .join("\n");
    return rows ? `\n## ${title}\n\n${rows}\n` : "";
  };
  writeFileSync(
    join(DIST, "llms.txt"),
    `# Codecast\n\n> ${home.description}\n` +
      section("Product", (e) => !e.path.startsWith("/blog") && !e.path.startsWith("/documentation") && !["/privacy", "/terms"].includes(e.path)) +
      section("Documentation", (e) => e.path.startsWith("/documentation")) +
      section("Blog", (e) => e.path.startsWith("/blog")),
  );

  console.log(`prerendered ${manifest.length}/${SEO_ROUTES.length} routes → dist/prerender, sitemap.xml + llms.txt written`);
  if (failed > 0) console.error(`WARNING: ${failed} route(s) failed to prerender — fix before the next deploy`);
}

main().catch((err) => {
  console.error("prerender step FAILED entirely (site still works; crawlers get the SPA shell):", err);
  process.exitCode = 0;
});

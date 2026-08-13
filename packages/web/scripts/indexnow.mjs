/**
 * IndexNow ping — tells Bing (and every IndexNow-participating engine) which
 * URLs changed, immediately on deploy. Bing matters beyond bing.com: ChatGPT's
 * web search and Microsoft Copilot both retrieve through Bing's index, so fast
 * Bing indexing is fast AI-answer eligibility.
 *
 * Protocol: we host public/<key>.txt containing the key; the ping POSTs the
 * changed URL list with that key. https://www.indexnow.org/documentation
 *
 * Runs at the end of `npm run build`, but only when RAILWAY_ENVIRONMENT is set
 * (i.e. a real deploy build) — local builds must not ping. FAIL-OPEN like the
 * prerender step: a failed ping logs and exits 0.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "b8d9369f3124415e2171c885fc4dc78d";
const HOST = "codecast.sh";

async function main() {
  if (!process.env.RAILWAY_ENVIRONMENT && !process.env.INDEXNOW_FORCE) {
    console.log("indexnow: not a deploy build (RAILWAY_ENVIRONMENT unset), skipping ping");
    return;
  }

  const sitemap = readFileSync(join(WEB_ROOT, "dist", "sitemap.xml"), "utf-8");
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (urls.length === 0) throw new Error("no URLs found in dist/sitemap.xml");

  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: HOST,
      key: KEY,
      keyLocation: `https://${HOST}/${KEY}.txt`,
      urlList: urls,
    }),
  });
  // 200 = accepted, 202 = accepted-pending-key-validation; both are success.
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`indexnow ping returned ${res.status}: ${await res.text()}`);
  }
  console.log(`indexnow: submitted ${urls.length} URLs (status ${res.status})`);
}

main().catch((err) => {
  console.error("indexnow ping FAILED (non-blocking):", err?.message ?? err);
  process.exitCode = 0;
});

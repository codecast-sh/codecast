#!/usr/bin/env node
/**
 * Keep the live build's hashed chunks for one more deploy.
 *
 * Railway builds from a fresh clone, so dist/assets holds only the new build.
 * Any client still running the previous build (an open tab, or a service worker
 * that answers navigations from its precache until its replacement finishes
 * installing) then asks for chunks the server no longer has, and the page dies
 * with "Failed to fetch dynamically imported module" (ct-92522). Before the new
 * build ships, this walks the live build's chunk graph from its index.html and
 * copies every hashed file the new build lacks into dist/assets. Only the live
 * build is reachable from the live index.html, so carried files last exactly
 * one deploy cycle.
 *
 * Runs at the end of `bun run build`, only for a deploy build (RAILWAY_ENVIRONMENT
 * set) or when CARRY_ASSETS_ORIGIN is given. FAIL-OPEN like indexnow: anything
 * that goes wrong logs and exits 0.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HASHED = /(?:\.\/|\/assets\/|["'`]assets\/)([\w.-]+-[\w-]{8}\.(?:js|css|woff2?|svg|png|webp|wasm))/g;

export function assetRefs(text) {
  return [...new Set([...text.matchAll(HASHED)].map((m) => m[1]))];
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function carryAssets({ origin, assetsDir, fetchImpl = fetch, concurrency = 32, deadline = Infinity }) {
  const html = await fetchImpl(`${origin}/`).then((r) => (r.ok ? r.text() : ""));
  const queue = assetRefs(html);
  const seen = new Set(queue);
  const carried = [];
  const missing = [];
  await mkdir(assetsDir, { recursive: true });
  const fetchOne = async (name) => {
    const res = await fetchImpl(`${origin}/assets/${name}`).catch(() => null);
    if (!res?.ok) {
      missing.push(name);
      return;
    }
    const body = Buffer.from(await res.arrayBuffer());
    const dest = join(assetsDir, name);
    if (!(await exists(dest))) {
      await writeFile(dest, body);
      carried.push(name);
    }
    if (!/\.(?:js|css)$/.test(name)) return;
    for (const ref of assetRefs(body.toString("utf8"))) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      queue.push(ref);
    }
  };
  while (queue.length && Date.now() < deadline) {
    await Promise.all(queue.splice(0, concurrency).map(fetchOne));
  }
  return { seen: seen.size, carried, missing, complete: queue.length === 0 };
}

async function main() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const origin = process.env.CARRY_ASSETS_ORIGIN || (domain ? `https://${domain}` : "https://codecast.sh");
  if (!process.env.RAILWAY_ENVIRONMENT && !process.env.CARRY_ASSETS_ORIGIN) {
    console.log("carry-assets: not a deploy build (RAILWAY_ENVIRONMENT unset), skipping");
    return;
  }
  const assetsDir = new URL("../dist/assets/", import.meta.url).pathname;
  const started = Date.now();
  const r = await carryAssets({ origin, assetsDir, deadline: started + 180_000 });
  console.log(
    `carry-assets: ${origin} live build has ${r.seen} files; carried ${r.carried.length} the new build lacks` +
      `${r.missing.length ? `, ${r.missing.length} unreachable` : ""}${r.complete ? "" : ", STOPPED at the time limit"}` +
      ` (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => console.log(`carry-assets: skipped after error: ${err?.message ?? err}`));
}

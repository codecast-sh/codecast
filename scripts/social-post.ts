#!/usr/bin/env bun
/**
 * Post one update to codecast's social accounts.
 *
 *   bun scripts/social-post.ts --text "…" [--link https://…] [--only bluesky,x,linkedin] [--dry]
 *
 * Transports:
 *   bluesky   AT Protocol with an app password: ~/.config/codecast/social/bluesky.json
 *             { "handle": "codecast.sh", "appPassword": "xxxx-xxxx-xxxx-xxxx" }
 *   x         Publora (the growth pack's transport) when ~/.config/publora/key exists and
 *             .codecast/packs/growth.toml names a twitter platform id; else reported as skipped.
 *   linkedin  Publora, same rule, for a linkedin platform id.
 *
 * Every send is appended to ~/.config/codecast/social/ledger.jsonl with its key, so a rerun of
 * the same text and link within 24h is refused instead of duplicated.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, arr) => {
  if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined ? "true" : arr[i + 1]]);
  return acc;
}, []));
const text = String(args.text ?? "");
const link = args.link ? String(args.link) : undefined;
const dry = args.dry === "true";
const only = args.only ? String(args.only).split(",") : ["bluesky", "x", "linkedin"];
if (!text.trim()) { console.error("--text is required"); process.exit(2); }

const DIR = join(homedir(), ".config", "codecast", "social");
mkdirSync(DIR, { recursive: true });
const LEDGER = join(DIR, "ledger.jsonl");
const key = createHash("sha256").update(`${text}\n${link ?? ""}`).digest("hex").slice(0, 24);
const sentRecently = (platform: string) => existsSync(LEDGER) && readFileSync(LEDGER, "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l) as { key: string; platform: string; at: string })
  .some((r) => r.key === key && r.platform === platform && Date.now() - Date.parse(r.at) < 24 * 3600e3);
const record = (platform: string, result: unknown) => appendFileSync(LEDGER, JSON.stringify({ key, platform, at: new Date().toISOString(), text, link, result }) + "\n");

const body = link && !text.includes(link) ? `${text}\n${link}` : text;

async function bluesky(): Promise<string> {
  const credPath = join(DIR, "bluesky.json");
  if (!existsSync(credPath)) return "skipped: no ~/.config/codecast/social/bluesky.json";
  const { handle, appPassword } = JSON.parse(readFileSync(credPath, "utf8"));
  const graphemes = [...new Intl.Segmenter().segment(body)].length;
  if (graphemes > 300) return `refused: ${graphemes} graphemes, Bluesky allows 300`;
  const facets: unknown[] = [];
  const enc = new TextEncoder();
  for (const m of body.matchAll(/https?:\/\/[^\s)]+/g)) {
    const byteStart = enc.encode(body.slice(0, m.index)).length;
    facets.push({ index: { byteStart, byteEnd: byteStart + enc.encode(m[0]).length }, features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }] });
  }
  if (dry) return `dry: would post ${graphemes} graphemes as ${handle}`;
  const session = await (await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: handle, password: appPassword }),
  })).json();
  if (!session.accessJwt) return `failed: login ${JSON.stringify(session).slice(0, 120)}`;
  const res = await (await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessJwt}` },
    body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text: body, facets, createdAt: new Date().toISOString(), langs: ["en"] } }),
  })).json();
  if (!res.uri) return `failed: ${JSON.stringify(res).slice(0, 160)}`;
  const rkey = res.uri.split("/").pop();
  return `posted https://bsky.app/profile/${handle}/post/${rkey}`;
}

async function publora(platformKind: "twitter" | "linkedin"): Promise<string> {
  const keyFile = join(homedir(), ".config", "publora", "key");
  if (!existsSync(keyFile)) return "skipped: Publora not connected (no ~/.config/publora/key)";
  const toml = readFileSync(join(process.cwd(), ".codecast/packs/growth.toml"), "utf8");
  const ids = (toml.match(/publora_platform_ids\s*=\s*\[([^\]]*)\]/)?.[1] ?? "").split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
  const id = ids.find((i) => i.startsWith(platformKind));
  if (!id) return `skipped: no ${platformKind} id in growth.toml publora_platform_ids`;
  if (platformKind === "twitter" && [...body].length > 280) return `refused: ${[...body].length} chars, X allows 280`;
  if (dry) return `dry: would post via Publora to ${id}`;
  const res = await (await fetch("https://api.publora.com/api/v1/posts", {
    method: "POST", headers: { "Content-Type": "application/json", "x-publora-key": readFileSync(keyFile, "utf8").trim(), "Idempotency-Key": `${key}-${platformKind}` },
    body: JSON.stringify({ content: body, platforms: [id], scheduledTime: new Date(Date.now() + 2 * 60e3).toISOString() }),
  })).json();
  return res.id || res.postId ? `scheduled ${res.id ?? res.postId}` : `failed: ${JSON.stringify(res).slice(0, 160)}`;
}

const senders: Record<string, () => Promise<string>> = { bluesky, x: () => publora("twitter"), linkedin: () => publora("linkedin") };
for (const platform of only) {
  if (!senders[platform]) { console.log(`${platform}: unknown platform`); continue; }
  if (!dry && sentRecently(platform)) { console.log(`${platform}: already sent this text in the last 24h (key ${key})`); continue; }
  const result = await senders[platform]();
  if (!dry && !/^skipped|^dry|^refused/.test(result)) record(platform, result);
  console.log(`${platform}: ${result}`);
}

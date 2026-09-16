#!/usr/bin/env bun
// Mirror the site's release notes and blog posts into the public #announcements
// room (codecast.sh/community) as the Codecast anchor.
//
// Idempotent: the room itself is the ledger. A line is identified by the public
// URL it carries (changelog anchor or blog post URL); anything the room already
// holds is skipped. Two modes:
//   --seed   backdate: every missing item is written with the date it shipped
//            (an internal mutation, operator only; no notification, no wake)
//   default  live: every missing item is posted now, as the anchor, the way a
//            trigger run posts what it shipped
//   --check  exit 0 when something is missing (a trigger precheck), 1 when not
//
// Data: app/(marketing)/changelog/changelogData.ts and app/(marketing)/blog/posts.ts.
import { RELEASES } from "../packages/web/app/(marketing)/changelog/changelogData";
import { POSTS } from "../packages/web/app/(marketing)/blog/posts";

const SITE = "https://codecast.sh";
const ANNOUNCEMENTS = process.env.COMMUNITY_ANNOUNCEMENTS_CHANNEL ?? "hx7h00k0d38g314mxedbjnz0ex8edh18";
const ANCHOR = process.env.COMMUNITY_ANCHOR ?? "x17d3jsztehx3wr3m1srk9hckh8ccvjq";
const CONVEX_DIR = new URL("../packages/convex/", import.meta.url).pathname;

type Item = { key: string; content: string; at: number };

function lastDayOfMonth(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  return Date.UTC(y, m, 0, 17, 0, 0); // day 0 of the next month = last day of this one, 17:00 UTC
}

function items(): Item[] {
  const out: Item[] = [];
  for (const r of RELEASES) {
    const url = `${SITE}/changelog#${r.id}`;
    const lines = r.sections.map((s) => `• ${s.title}`).join("\n");
    out.push({
      key: url,
      at: lastDayOfMonth(r.sortDate),
      content: `**${r.month}: ${r.headline}** (${r.version}${r.desktop ? `, ${r.desktop}` : ""})\n${r.summary}\n\n${lines}\n\nFull notes: ${url}`,
    });
  }
  for (const p of POSTS as Array<{ slug: string; title: string; dek?: string; date: string }>) {
    const url = `${SITE}/blog/${p.slug}`;
    const blurb = p.dek ?? "";
    out.push({ key: url, at: Date.parse(`${p.date}T16:00:00Z`), content: `**New on the blog: ${p.title}**\n${blurb}\n${url}`.trim() });
  }
  return out.sort((a, b) => a.at - b.at);
}

async function convexRun(fn: string, args: unknown): Promise<any> {
  const proc = Bun.spawn(["npx", "convex", "run", fn, JSON.stringify(args)], {
    cwd: CONVEX_DIR,
    env: { ...process.env, CONVEX_DEPLOYMENT: undefined as any },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`${fn}: ${err.trim() || out.trim()}`);
  return JSON.parse(out);
}

async function existingKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const r = await convexRun("chat:listMessages", { channel_id: ANNOUNCEMENTS, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const m of r.messages ?? []) {
      for (const url of String(m.content).match(/https?:\/\/\S+/g) ?? []) keys.add(url.replace(/[),.]+$/, ""));
    }
    if (!r.has_more || !r.next_cursor) break;
    cursor = r.next_cursor;
  }
  return keys;
}

async function say(content: string): Promise<void> {
  const proc = Bun.spawn(["cast", "anchor", "say", "--team", "Codecast", "--chat", ANNOUNCEMENTS, content], { stdout: "pipe", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`cast anchor say: ${err.trim()}`);
}

const mode = process.argv.includes("--seed") ? "seed" : process.argv.includes("--check") ? "check" : "live";
const have = await existingKeys();
const missing = items().filter((i) => !have.has(i.key));
if (mode === "check") {
  console.log(`${missing.length} missing`);
  process.exit(missing.length > 0 ? 0 : 1);
}
for (const item of missing) {
  if (mode === "seed") {
    await convexRun("chat:seedCommunityPost", { channel_id: ANNOUNCEMENTS, anchor_id: ANCHOR, content: item.content, created_at: item.at });
    console.log(`seeded ${new Date(item.at).toISOString().slice(0, 10)}  ${item.key}`);
  } else {
    await say(item.content);
    console.log(`posted ${item.key}`);
  }
}
if (missing.length === 0) console.log("nothing to post");

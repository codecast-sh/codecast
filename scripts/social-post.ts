#!/usr/bin/env bun
/**
 * Post one update to codecast's social accounts.
 *
 *   bun scripts/social-post.ts --text "…" [--link https://…] [--only bluesky,x,linkedin] [--dry]
 *
 * Transports:
 *   bluesky   AT Protocol with an app password: ~/.config/codecast/social/bluesky.json
 *             { "handle": "codecast.sh", "appPassword": "xxxx-xxxx-xxxx-xxxx" }
 *   x         cast browser, as @codecastsh: the handle must be in Chrome's X account switcher
 *             (the human adds it once); the script switches to it, posts, and switches back.
 *   linkedin  cast browser, the Codecast Page composer on the page's admin surface, which posts
 *             as the Page from the human's LinkedIn login.
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

/**
 * Browser transports drive the human's Chrome through `cast browser`, as the brand: the LinkedIn
 * Page composer on the page's admin surface, and X signed in as the brand account (added to Chrome's
 * account switcher by the human once). Each verb runs with a timeout so a stalled bridge reports
 * instead of hanging the run.
 */
function cast(args: string[], timeoutMs = 90e3): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["cast", "browser", ...args], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const out = `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`.trim();
  // The exit code also goes nonzero on the page's own console errors, so judge by the step report.
  return { ok: !r.signalCode && !/\b\d+ failed\b|^✗|tab_gone|no open page/m.test(out), out };
}
function evalJs<T>(js: string): T | undefined {
  const r = cast(["eval", js]);
  // The result line is a JSON string; page console errors may add a failure report around it.
  try { return JSON.parse(JSON.parse(r.out.split("\n").find((l) => l.startsWith('"')) ?? "null")) as T; } catch { return undefined; }
}
/** Insert the text into a focused contenteditable the way a paste would, so the editor's model sees it. */
/** Focus the editor by description and type the text as real keystrokes (paste events do not reach these editors). */
function typeInto(editorDescription: string, lenJs: string): { len?: number; err?: string } | undefined {
  const focused = cast(["do", `find "${editorDescription}"`, "click"], 120e3);
  if (!focused.ok) return { err: `editor not found: ${focused.out.slice(0, 120)}` };
  const typed = cast(["type", body], 400e3);
  if (!typed.ok) return { err: `typing failed: ${typed.out.slice(0, 120)}` };
  return evalJs<{ len: number }>(`JSON.stringify({len:((${lenJs})||"").trim().length})`);
}
const wantLen = body.trim().length;
function withTab<T>(url: string, fn: () => T): T {
  // `open` exits nonzero on the page's own console errors; the transport's first wait decides.
  const open = cast(["open", url], 120e3);
  if (!open.ok && /no open page|extension (asleep|missing|disconnected)|not connected|tab_gone/i.test(open.out)) throw new Error(`browser: could not open ${url}: ${open.out.slice(0, 160)}`);
  try { return fn(); } finally { cast(["stop"], 30e3); }
}

async function linkedin(): Promise<string> {
  const pageId = "146734867";
  if (dry) return `dry: would post as the Codecast Page (${pageId}) through cast browser`;
  try {
    return withTab(`https://www.linkedin.com/company/${pageId}/admin/page-posts/published/`, () => {
      cast(["do", 'wait --text "Start a post"'], 120e3);
      const signedIn = evalJs<{ admin: boolean }>('JSON.stringify({admin: /\\/admin\\//.test(location.pathname) && document.body.innerText.includes("Start a post")})');
      if (!signedIn?.admin) return "skipped: Chrome is not signed in to LinkedIn as a Page admin";
      const openComposer = () => cast(["do", 'find "Start a post button"', "click", 'wait --text "Post to"'], 150e3);
      let opened = openComposer();
      if (!opened.ok) opened = openComposer();
      if (!opened.ok) return `failed: composer did not open: ${opened.out.slice(0, 160)}`;
      const who = evalJs<{ as: string }>('JSON.stringify({as: [...document.querySelectorAll("button")].map(b=>b.innerText.trim().replace(/\\s+/g," ")).find(t=>/Post to/.test(t))||""})');
      if (!/Codecast/.test(who?.as ?? "")) return `refused: composer would post as "${who?.as ?? "?"}", not the Codecast Page`;
      // Quill mirrors DOM mutations into its model, so a direct write is instant; keystrokes take minutes on a loaded machine.
      const ins = evalJs<{ len?: number; err?: string }>(`(()=>{const ed=[...document.querySelectorAll(".ql-editor")].find(e=>!e.closest(".comments-comment-texteditor")); if(!ed) return JSON.stringify({err:"no editor"});
        const p=document.createElement("p"); p.textContent=${JSON.stringify(body)}; ed.replaceChildren(p); ed.classList.remove("ql-blank");
        ed.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"})); return JSON.stringify({len:(ed.innerText||"").trim().length});})()`);
      if (ins?.err) return `failed: ${ins.err}`;
      if (ins?.len !== wantLen) return `failed: editor holds ${ins?.len} chars, wanted ${wantLen}`;
      const armed = evalJs<{ enabled: boolean }>('JSON.stringify({enabled: [...document.querySelectorAll("button")].some(b=>b.innerText.trim()==="Post" && !b.disabled)})');
      if (!armed?.enabled) return "failed: Post button stayed disabled after inserting the text";
      const posted = cast(["do", 'find "the enabled Post button that publishes the composer"', "click", "wait 5000"], 120e3);
      if (!posted.ok) return `failed: Post click: ${posted.out.slice(0, 160)}`;
      const seen = evalJs<{ found: boolean }>(`JSON.stringify({found: ![...document.querySelectorAll("button")].some(b=>b.innerText.trim()==="Post") && document.body.innerText.includes(${JSON.stringify(body.slice(0, 60))})})`);
      return seen?.found ? `posted as the Codecast Page (linkedin.com/company/codecast-sh)` : "failed: post not visible on the page after Post";
    });
  } catch (e) { return `failed: ${(e as Error).message}`; }
}

async function x(): Promise<string> {
  const brand = "codecastsh";
  if ([...body].length > 280) return `refused: ${[...body].length} chars, X allows 280`;
  if (dry) return `dry: would post as @${brand} through cast browser`;
  const switcher = '[data-testid=SideNav_AccountSwitcher_Button]';
  const activeJs = `JSON.stringify({active:(document.querySelector(${JSON.stringify(switcher)})?.innerText.match(/@(\\w+)/)||[])[1]||""})`;
  try {
    return withTab("https://x.com/home", () => {
      const before = evalJs<{ active: string }>(activeJs)?.active ?? "";
      if (!before) return "skipped: Chrome is not signed in to X";
      const switchTo = (handle: string) => {
        if ((evalJs<{ active: string }>(activeJs)?.active ?? "") === handle) return true;
        cast(["do", 'find "account menu button at the bottom of the left sidebar"', "click", "wait 1500"], 120e3);
        const r = cast(["do", `find "menu item for the account @${handle}"`, "click", "wait 4000"], 120e3);
        return r.ok && (evalJs<{ active: string }>(activeJs)?.active ?? "") === handle;
      };
      if (!switchTo(brand)) return `skipped: @${brand} is not in Chrome's X account switcher (signed in as @${before}); add it once via "Add an existing account"`;
      try {
        cast(["open", "https://x.com/compose/post"], 120e3);
        cast(["do", 'wait --text "What"'], 60e3);
        const ins = typeInto("post text box in the compose dialog", 'document.querySelector("[data-testid=tweetTextarea_0]")?.innerText');
        if (ins?.err) return `failed: ${ins.err}`;
        if (ins?.len !== wantLen) return `failed: composer holds ${ins?.len} chars, wanted ${wantLen}`;
        const posted = cast(["do", 'find "Post button that publishes the draft"', "click", "wait 4000"], 120e3);
        if (!posted.ok) return `failed: Post click: ${posted.out.slice(0, 160)}`;
        const seen = evalJs<{ sent: boolean }>('JSON.stringify({sent: !document.querySelector("[data-testid=tweetTextarea_0]") || document.body.innerText.includes("Your post was sent")})');
        return seen?.sent ? `posted as @${brand} (https://x.com/${brand})` : "failed: composer still open after Post";
      } finally { if (before !== brand) switchTo(before); }
    });
  } catch (e) { return `failed: ${(e as Error).message}`; }
}

const senders: Record<string, () => Promise<string>> = { bluesky, x, linkedin };
for (const platform of only) {
  if (!senders[platform]) { console.log(`${platform}: unknown platform`); continue; }
  if (!dry && sentRecently(platform)) { console.log(`${platform}: already sent this text in the last 24h (key ${key})`); continue; }
  const result = await senders[platform]();
  if (!dry && !/^skipped|^dry|^refused|^failed/.test(result)) record(platform, result);
  console.log(`${platform}: ${result}`);
}

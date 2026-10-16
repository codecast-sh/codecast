#!/usr/bin/env bun
/**
 * Post one update to codecast's social accounts.
 *
 *   bun scripts/social-post.ts --text "…" [--link https://…] [--only bluesky,x,linkedin,threads] [--dry]
 *
 * Transports:
 *   bluesky   AT Protocol with an app password: ~/.config/codecast/social/bluesky.json
 *             { "handle": "codecast.sh", "appPassword": "xxxx-xxxx-xxxx-xxxx" }
 *   x         cast browser, as @codecastsh: the handle must be in Chrome's X account switcher
 *             (the human adds it once); the script switches to it, posts, and switches back.
 *   linkedin  cast browser, the Codecast Page composer on the page's admin surface, which posts
 *             as the Page from the human's LinkedIn login.
 *   threads   cast browser, threads.com signed in as @codecast.sh (the brand Instagram account);
 *             refused when Chrome's Threads login is anyone else.
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
const only = args.only ? String(args.only).split(",") : ["bluesky", "x", "linkedin", "threads"];
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
// Length checks ignore whitespace: editors render a blank line as one or two newlines.
const wantLen = body.replace(/\s+/g, "").length;
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
        ed.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"})); return JSON.stringify({len:(ed.innerText||"").replace(/\\s+/g,"").length});})()`);
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
  // X counts every URL as 23 characters (t.co), whatever its real length.
  const xLen = [...body.replace(/https?:\/\/\S+/g, "x".repeat(23))].length;
  if (xLen > 280) return `refused: ${xLen} chars, X allows 280`;
  if (dry) return `dry: would post as @${brand} through cast browser`;
  const switcher = '[data-testid=SideNav_AccountSwitcher_Button]';
  const activeJs = `JSON.stringify({active:(document.querySelector(${JSON.stringify(switcher)})?.innerText.match(/@(\\w+)/)||[])[1]||""})`;
  try {
    return withTab("https://x.com/home", () => {
      cast(["do", 'wait --text "What"'], 60e3);
      let before = "";
      for (let i = 0; i < 6 && !before; i++) { // the sidebar's account button renders after the timeline
        before = evalJs<{ active: string }>(activeJs)?.active ?? "";
        if (!before) cast(["do", "wait 2000"], 30e3);
      }
      if (!before) return "skipped: Chrome is not signed in to X";
      const switchTo = (handle: string) => {
        if ((evalJs<{ active: string }>(activeJs)?.active ?? "") === handle) return true;
        cast(["do", 'find "account menu button at the bottom of the left sidebar"', "click", "wait 1500"], 120e3);
        const r = cast(["do", `find "menu item for the account @${handle}"`, "click", "wait 4000"], 120e3);
        return r.ok && (evalJs<{ active: string }>(activeJs)?.active ?? "") === handle;
      };
      if (!switchTo(brand)) return `skipped: @${brand} is not in Chrome's X account switcher (signed in as @${before}); add it once via "Add an existing account"`;
      try {
        // The home timeline's inline composer. /compose/post opens a modal over it whose editor the
        // snapshot cannot see, and keystrokes through the extension echo into it thousands of times,
        // so the text goes in as a synthetic paste (Draft.js reads clipboardData) and Post is clicked by script.
        const composerJs = '[...document.querySelectorAll("[data-testid=tweetTextarea_0]")].filter(e=>e.getBoundingClientRect().height>0).at(-1)';
        const pasted = evalJs<{ ok?: boolean; err?: string }>(`(()=>{const t=${composerJs};
          if(!t) return JSON.stringify({err:"no composer"}); t.focus(); const dt=new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(body)});
          t.dispatchEvent(new ClipboardEvent("paste",{clipboardData:dt,bubbles:true,cancelable:true})); return JSON.stringify({ok:true});})()`);
        if (pasted?.err) return `failed: ${pasted.err}`;
        cast(["do", "wait 2000"], 30e3); // Draft.js applies the paste on its next render
        const ins = evalJs<{ len: number }>(`JSON.stringify({len:((${composerJs})?.innerText||"").replace(/\\s+/g,"").length})`);
        if (ins?.len !== wantLen) return `failed: composer holds ${ins?.len} chars, wanted ${wantLen}`;
        const clicked = evalJs<{ ok: boolean }>('(()=>{const b=document.querySelector("[data-testid=tweetButtonInline]"); if(!b||b.disabled) return JSON.stringify({ok:false}); b.click(); return JSON.stringify({ok:true});})()');
        if (!clicked?.ok) return "failed: Post button missing or disabled";
        cast(["do", "wait 5000"], 30e3);
        const seen = evalJs<{ sent: boolean }>('JSON.stringify({sent: (document.querySelector("[data-testid=tweetTextarea_0]")?.innerText||"").replace(/\\s+/g,"").length===0})');
        if (!seen?.sent) return "failed: composer still holds the text after Post";
        cast(["open", `https://x.com/${brand}`], 120e3);
        cast(["do", `wait --text ${JSON.stringify(text.slice(0, 40))}`], 60e3);
        const url = evalJs<{ href?: string }>(`(()=>{const a=[...document.querySelectorAll("article")].find(x=>x.innerText.includes(${JSON.stringify(text.slice(0, 60))})); return JSON.stringify({href:a?.querySelector("a[href*=status]")?.getAttribute("href")});})()`);
        return url?.href ? `posted as @${brand} (https://x.com${url.href})` : `failed: post not visible on x.com/${brand}`;
      } finally { if (before !== brand) switchTo(before); }
    });
  } catch (e) { return `failed: ${(e as Error).message}`; }
}

async function threads(): Promise<string> {
  const brand = "codecast.sh";
  if ([...body].length > 500) return `refused: ${[...body].length} chars, Threads allows 500`;
  if (dry) return `dry: would post as @${brand} through cast browser`;
  // Threads web has no profile switcher, so Chrome's one Threads login must be the brand.
  const whoJs = 'JSON.stringify({who:(document.querySelector("a[href^=\"/@\"][aria-label*=Profile], a[aria-label=Profile]")?.getAttribute("href")||"").replace(/^\/@/,"")})';
  try {
    return withTab("https://www.threads.com/", () => {
      cast(["do", 'wait --text "New thread"'], 60e3);
      let who = "";
      for (let i = 0; i < 6 && !who; i++) {
        who = evalJs<{ who: string }>(whoJs)?.who ?? "";
        if (!who) cast(["do", "wait 2000"], 30e3);
      }
      if (!who) return "skipped: Chrome is not signed in to Threads";
      if (who !== brand) return `refused: Threads is signed in as @${who}, not @${brand}`;
      // The composer is a Lexical editor: a synthetic paste carries the text, then Post is clicked by script.
      const opened = cast(["do", 'find "New thread button in the left sidebar"', "click", 'wait --text "Post"'], 120e3);
      if (!opened.ok) return `failed: composer did not open: ${opened.out.slice(0, 160)}`;
      const editorJs = '[...document.querySelectorAll("[role=dialog] [contenteditable=true], [contenteditable=true][role=textbox]")].filter(e=>e.getBoundingClientRect().height>0).at(-1)';
      const pasted = evalJs<{ ok?: boolean; err?: string }>(`(()=>{const t=${editorJs}; if(!t) return JSON.stringify({err:"no editor"}); t.focus();
        const dt=new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(body)});
        t.dispatchEvent(new ClipboardEvent("paste",{clipboardData:dt,bubbles:true,cancelable:true})); return JSON.stringify({ok:true});})()`);
      if (pasted?.err) return `failed: ${pasted.err}`;
      cast(["do", "wait 2000"], 30e3);
      const ins = evalJs<{ len: number }>(`JSON.stringify({len:((${editorJs})?.innerText||"").replace(/\s+/g,"").length})`);
      if (ins?.len !== wantLen) return `failed: composer holds ${ins?.len} chars, wanted ${wantLen}`;
      const clicked = evalJs<{ ok: boolean }>('(()=>{const b=[...document.querySelectorAll("[role=dialog] div[role=button], [role=dialog] button")].filter(e=>e.innerText.trim()==="Post"&&e.getBoundingClientRect().height>0).at(-1); if(!b||b.getAttribute("aria-disabled")==="true") return JSON.stringify({ok:false}); ["pointerdown","mousedown","pointerup","mouseup","click"].forEach(t=>b.dispatchEvent(new MouseEvent(t,{bubbles:true}))); return JSON.stringify({ok:true});})()');
      if (!clicked?.ok) return "failed: Post button missing or disabled";
      cast(["do", "wait 5000"], 30e3);
      cast(["open", `https://www.threads.com/@${brand}`], 120e3);
      cast(["do", `wait --text ${JSON.stringify(text.slice(0, 40))}`], 60e3);
      const url = evalJs<{ href?: string }>(`(()=>{const a=[...document.querySelectorAll("a[href*=\"/post/\"]")].find(a=>a.closest("div")?.parentElement?.innerText.includes(${JSON.stringify(text.slice(0, 60))})); return JSON.stringify({href:a?.getAttribute("href")});})()`);
      return url?.href ? `posted as @${brand} (https://www.threads.com${url.href})` : `failed: post not visible on threads.com/@${brand}`;
    });
  } catch (e) { return `failed: ${(e as Error).message}`; }
}
const senders: Record<string, () => Promise<string>> = { bluesky, x, linkedin, threads };
for (const platform of only) {
  if (!senders[platform]) { console.log(`${platform}: unknown platform`); continue; }
  if (!dry && sentRecently(platform)) { console.log(`${platform}: already sent this text in the last 24h (key ${key})`); continue; }
  const result = await senders[platform]();
  if (!dry && !/^skipped|^dry|^refused|^failed/.test(result)) record(platform, result);
  console.log(`${platform}: ${result}`);
}

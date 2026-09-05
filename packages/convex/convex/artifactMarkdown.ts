// Markdown → the published reading page. Owns the marked configuration
// (heading anchors, server-side syntax highlighting, scrollable tables) and
// the ONE stylesheet every rendered-markdown surface wears: the stored artifact
// document (mdDocumentHtml) and the editor's live preview (artifactPages)
// both drop `.md` on their root and import MD_THEME_CSS, so the two can never
// drift apart.
//
// The document is stored as rendered HTML at publish time and served under a
// sandbox CSP with an opaque origin, so everything here is inline: no
// framework, no external script. Fonts come from the same Google Fonts source
// the injected bar already uses.

import { Marked, type Tokens } from "marked";
import hljs from "highlight.js/lib/common";
import { escHtml, escAttr } from "./htmlEscape";

// GitHub-style heading slugs: lowercase, strip punctuation, spaces to hyphens,
// numeric suffix on repeats. One `seen` map per render keeps ids unique
// within a document without leaking state between concurrent renders.
export function slugify(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/&[a-z]+;|&#\d+;/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function highlight(code: string, lang: string | undefined): { html: string; lang: string | null } {
  const name = (lang ?? "").trim().split(/\s+/)[0];
  if (name && hljs.getLanguage(name)) {
    return { html: hljs.highlight(code, { language: name, ignoreIllegals: true }).value, lang: name };
  }
  return { html: escHtml(code), lang: name || null };
}

function createMarked(): Marked {
  const seen = new Map<string, number>();
  return new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const id = slugify(inner, seen);
        return `<h${depth} id="${escAttr(id)}">${inner}<a class="anchor" href="#${escAttr(id)}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const { html, lang: name } = highlight(text, lang);
        const cls = name ? ` class="language-${escAttr(name)}"` : "";
        const label = name ? ` data-lang="${escAttr(name)}"` : "";
        return `<pre${label}><code${cls}>${html}\n</code></pre>\n`;
      },
      table(token: Tokens.Table) {
        const head = `<tr>${token.header.map((c) => cell.call(this, c, "th")).join("")}</tr>`;
        const body = token.rows.map((r) => `<tr>${r.map((c) => cell.call(this, c, "td")).join("")}</tr>`).join("");
        return `<div class="tbl"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>\n`;
      },
    },
  });
}

function cell(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, c: Tokens.TableCell, tag: "th" | "td"): string {
  const align = c.align ? ` style="text-align:${c.align}"` : "";
  return `<${tag}${align}>${this.parser.parseInline(c.tokens)}</${tag}>`;
}

/** Rendered body HTML (no document shell). */
export async function renderMarkdownBody(md: string): Promise<string> {
  return createMarked().parse(md, { async: true });
}

/** Loaded by BOTH the published document and the editor preview. Newsreader
 * for reading text, JetBrains Mono for anything that is code or a label. The
 * @import has to be the first rule of whichever <style> holds this. */
export const MD_THEME_CSS = `
@import url("https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400..700;1,6..72,400..700&family=JetBrains+Mono:wght@400;500;600&display=swap");
:root {
  --md-bg: #fbfaf8; --md-ink: #1e1d1a; --md-mut: #605d56; --md-dim: rgba(30,29,26,.5);
  --md-line: rgba(30,29,26,.11); --md-card: #ffffff; --md-soft: rgba(30,29,26,.055);
  --md-coral: #e86c5d; --md-link: #1d5ea6; --md-mark: rgba(255,214,102,.5);
  --md-k: #a63d8f; --md-s: #2e7d4f; --md-c: #8a8680; --md-n: #b05a1a; --md-f: #1d5ea6; --md-t: #0f7a8a; --md-a: #7a5a10;
}
@media (prefers-color-scheme: dark) {
  :root {
    --md-bg: #151412; --md-ink: #e9e6df; --md-mut: #a39f96; --md-dim: rgba(233,230,223,.45);
    --md-line: rgba(233,230,223,.11); --md-card: #1c1b18; --md-soft: rgba(233,230,223,.075);
    --md-link: #85acdf; --md-mark: rgba(255,214,102,.28);
    --md-k: #d58fc4; --md-s: #8fcf9f; --md-c: #7f7b73; --md-n: #e8a26a; --md-f: #8fb8ee; --md-t: #6fc7d6; --md-a: #d9b95a;
  }
}
.md {
  font: 400 clamp(16.5px, 1rem + .22vw, 18px)/1.62 Newsreader, Charter, "Iowan Old Style", Georgia, serif;
  font-optical-sizing: auto; color: var(--md-ink);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  font-feature-settings: "kern", "liga", "calt";
  overflow-wrap: break-word; hanging-punctuation: first;
}
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md ::selection { background: rgba(232,108,93,.28); }
.md p { margin: 0 0 1.15em; text-wrap: pretty; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
  position: relative; font-weight: 500; line-height: 1.18; color: var(--md-ink);
  letter-spacing: -.012em; text-wrap: balance; scroll-margin-top: 64px;
}
.md h1 { font-size: 2.35em; font-weight: 500; margin: 0 0 .55em; letter-spacing: -.02em; line-height: 1.08; }
.md h2 { font-size: 1.62em; margin: 1.75em 0 .5em; padding-top: .6em; border-top: 1px solid var(--md-line); }
.md h1 + h2 { border-top: 0; padding-top: 0; margin-top: 1.2em; }
.md h3 { font-size: 1.28em; margin: 1.6em 0 .45em; }
.md h4 { font-size: 1.08em; font-weight: 600; margin: 1.5em 0 .4em; }
.md h5, .md h6 { font: 600 .8em/1.4 "JetBrains Mono", ui-monospace, Menlo, monospace; color: var(--md-mut); margin: 1.6em 0 .5em; letter-spacing: 0; }
.md .anchor { position: absolute; left: -1.1em; width: 1em; text-align: center; color: var(--md-dim);
  font: 400 .72em/1 "JetBrains Mono", ui-monospace, Menlo, monospace; text-decoration: none;
  opacity: 0; transition: opacity .15s ease; top: 50%; transform: translateY(-50%); }
.md h1 .anchor { top: .55em; transform: none; }
.md h2 .anchor { top: auto; bottom: .28em; transform: none; }
.md :is(h1,h2,h3,h4,h5,h6):hover .anchor, .md .anchor:focus-visible { opacity: 1; }
.md .anchor:hover { color: var(--md-coral); }
.md a { color: var(--md-link); text-decoration: underline; text-decoration-thickness: 1px;
  text-decoration-color: color-mix(in srgb, var(--md-link) 35%, transparent); text-underline-offset: .18em;
  transition: text-decoration-color .15s ease, color .15s ease; }
.md a:hover { text-decoration-color: currentColor; }
.md strong { font-weight: 600; }
.md em { font-style: italic; }
.md mark { background: var(--md-mark); color: inherit; padding: 0 .15em; border-radius: 2px; }
.md del { color: var(--md-mut); }
.md small { font-size: .85em; color: var(--md-mut); }
.md sup, .md sub { font-size: .7em; line-height: 0; }
.md code, .md kbd, .md samp { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .84em; }
.md :not(pre) > code { background: var(--md-soft); padding: .1em .3em; border-radius: 4px; color: var(--md-ink); }
.md a > code { color: inherit; }
.md kbd { display: inline-block; font-size: .75em; line-height: 1; padding: .3em .5em .25em; border: 1px solid var(--md-line);
  border-bottom-width: 2px; border-radius: 5px; background: var(--md-card); color: var(--md-mut); vertical-align: .1em; }
.md pre { position: relative; margin: 1.35em 0; padding: 1em 1.15em; background: var(--md-card); border: 1px solid var(--md-line);
  border-radius: 10px; overflow-x: auto; font-size: .8em; line-height: 1.6; -webkit-overflow-scrolling: touch; tab-size: 2; }
.md pre code { display: block; font-size: 1em; background: none; padding: 0; white-space: pre; color: var(--md-ink); }
.md pre[data-lang] { padding-top: 2.1em; }
.md pre[data-lang]::before { content: attr(data-lang); position: absolute; top: 9px; right: 13px; color: var(--md-dim);
  font: 500 .78em/1 "JetBrains Mono", ui-monospace, Menlo, monospace; pointer-events: none;
  transition: opacity .15s ease; }
.md pre:hover::before, .md pre:focus-within::before { opacity: 0; }
.md pre .copy { all: unset; position: absolute; top: 6px; right: 8px; cursor: pointer; color: var(--md-mut);
  font: 500 .78em/1 "JetBrains Mono", ui-monospace, Menlo, monospace; padding: 5px 8px; border-radius: 6px;
  background: var(--md-card); border: 1px solid var(--md-line); opacity: 0; transition: opacity .15s ease, color .15s ease; }
.md pre:hover .copy, .md pre .copy:focus-visible, .md pre .copy.done { opacity: 1; }
.md pre .copy:hover { color: var(--md-ink); }
.md pre .copy.done { color: var(--md-coral); border-color: color-mix(in srgb, var(--md-coral) 45%, transparent); }
@media (hover: none) { .md pre .copy { opacity: 1; } .md pre[data-lang]::before { display: none; } }
.md blockquote { margin: 1.35em 0; padding: .1em 0 .1em 1.2em; border-left: 3px solid var(--md-coral); color: var(--md-mut); }
.md blockquote p { margin-bottom: .7em; }
.md blockquote > :last-child { margin-bottom: 0; }
.md ul, .md ol { margin: 0 0 1.15em; padding-left: 1.5em; }
.md li { margin: .3em 0; padding-left: .2em; }
.md li > p { margin-bottom: .5em; }
.md li > ul, .md li > ol { margin: .3em 0 .3em; }
.md ul > li::marker { color: var(--md-coral); }
.md ol > li::marker { color: var(--md-mut); font: 500 .82em "JetBrains Mono", ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
.md li:has(> input[type=checkbox]) { list-style: none; margin-left: -1.5em; padding-left: 0; display: flex; gap: .55em; align-items: baseline; }
.md input[type=checkbox] { appearance: none; -webkit-appearance: none; width: .95em; height: .95em; margin: 0; flex: none;
  position: relative; top: .12em; border: 1.5px solid var(--md-dim); border-radius: 4px; background: var(--md-card); opacity: 1; }
.md input[type=checkbox]:checked { border-color: var(--md-coral); background: var(--md-coral); }
.md input[type=checkbox]:checked::after { content: ""; position: absolute; left: .26em; top: .08em; width: .28em; height: .5em;
  border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.md li:has(> input[type=checkbox]:checked) { color: var(--md-mut); }
.md hr { border: 0; height: 1px; width: 56px; margin: 2.6em auto; background: var(--md-coral); opacity: .7; }
.md img, .md video { display: block; max-width: 100%; height: auto; margin: 1.4em auto; border-radius: 8px; }
.md p > img:only-child { margin: .2em auto; }
.md figure { margin: 1.5em 0; }
.md figcaption { text-align: center; color: var(--md-mut); font: 400 .78em/1.5 "JetBrains Mono", ui-monospace, Menlo, monospace; margin-top: .7em; }
.md .tbl { margin: 1.35em 0; overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 8px; }
.md table { border-collapse: collapse; width: 100%; font-size: .92em; line-height: 1.45; font-variant-numeric: tabular-nums lining-nums; }
.md th, .md td { text-align: left; padding: .5em .75em; border-bottom: 1px solid var(--md-line); vertical-align: top; }
.md th { font: 600 .76em/1.4 "JetBrains Mono", ui-monospace, Menlo, monospace; color: var(--md-mut); padding-bottom: .6em;
  border-bottom: 1.5px solid color-mix(in srgb, var(--md-ink) 25%, transparent); white-space: nowrap; }
.md tbody tr:last-child td { border-bottom: 0; }
.md tbody tr:hover td { background: color-mix(in srgb, var(--md-soft) 60%, transparent); }
.md details { margin: 1.15em 0; padding: .6em 1em; border: 1px solid var(--md-line); border-radius: 8px; background: var(--md-card); }
.md summary { cursor: pointer; font-weight: 500; color: var(--md-ink); }
.md summary::marker { color: var(--md-coral); }
.md details[open] > summary { margin-bottom: .6em; }
.md .hljs-comment, .md .hljs-quote { color: var(--md-c); font-style: italic; }
.md .hljs-keyword, .md .hljs-selector-tag, .md .hljs-doctag, .md .hljs-formula { color: var(--md-k); }
.md .hljs-string, .md .hljs-regexp, .md .hljs-addition, .md .hljs-meta .hljs-string { color: var(--md-s); }
.md .hljs-number, .md .hljs-literal, .md .hljs-symbol, .md .hljs-bullet, .md .hljs-link { color: var(--md-n); }
.md .hljs-title, .md .hljs-title.function_, .md .hljs-section, .md .hljs-name, .md .hljs-selector-id, .md .hljs-selector-class { color: var(--md-f); }
.md .hljs-type, .md .hljs-title.class_, .md .hljs-built_in, .md .hljs-class .hljs-title { color: var(--md-t); }
.md .hljs-attr, .md .hljs-attribute, .md .hljs-variable, .md .hljs-template-variable, .md .hljs-selector-attr, .md .hljs-selector-pseudo, .md .hljs-meta { color: var(--md-a); }
.md .hljs-deletion { color: #c0392b; }
.md .hljs-emphasis { font-style: italic; }
.md .hljs-strong { font-weight: 600; }
.md .hljs-tag { color: var(--md-mut); }
.md .hljs-tag .hljs-name { color: var(--md-f); }
`;

/** Progressive enhancement: a copy button on every code block. The stored
 * HTML stays semantic; a reader with scripts off just gets the code. */
const MD_SCRIPT = `<script>(function(){
  var pres=document.querySelectorAll(".md pre");
  Array.prototype.forEach.call(pres,function(pre){
    var code=pre.querySelector("code"); if(!code) return;
    var b=document.createElement("button"); b.type="button"; b.className="copy"; b.textContent="Copy";
    b.setAttribute("aria-label","Copy code");
    var t=null;
    b.addEventListener("click",function(){
      var text=code.textContent.replace(/\\n$/,"");
      var done=function(){ b.textContent="Copied"; b.classList.add("done");
        if(t) clearTimeout(t); t=setTimeout(function(){ b.textContent="Copy"; b.classList.remove("done"); },1400); };
      var fallback=function(){
        var ta=document.createElement("textarea"); ta.value=text; ta.setAttribute("readonly","");
        ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta); ta.select();
        try{ document.execCommand("copy"); done(); }catch(e){} document.body.removeChild(ta); };
      if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(done,fallback); }
      else fallback();
    });
    pre.appendChild(b);
  });
})();</script>`;

/** The stored artifact document for a markdown publish. It goes through
 * brandArtifactHtml at serve time like any HTML: the bar reserves its own
 * 40px at the top of <html> and reads the page's background luminance to pick
 * its palette, so the theme only has to follow the OS colour scheme. */
export function mdDocumentHtml(o: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escHtml(o.title)}</title>
<style>${MD_THEME_CSS}
  * { box-sizing: border-box; }
  html { background: var(--md-bg); }
  body { margin: 0; background: var(--md-bg); color: var(--md-ink); min-height: 100vh; }
  main { max-width: 41.5rem; margin: 0 auto;
    padding: clamp(28px, 6vh, 64px) calc(22px + env(safe-area-inset-right)) calc(96px + env(safe-area-inset-bottom)) calc(22px + env(safe-area-inset-left));
    animation: md-rise .6s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes md-rise { from { opacity: 0; transform: translateY(8px); } }
  @media (prefers-reduced-motion: reduce) { main { animation: none; } }
  @media (max-width: 640px) { .md .anchor { display: none; } .md h1 { font-size: 2em; } }
  @media print {
    :root { --md-bg: #fff; --md-ink: #000; --md-card: #fff; }
    main { max-width: none; padding: 0; animation: none; }
    .md .anchor, .md .copy, .md pre::before { display: none !important; }
    .md pre, .md blockquote, .md .tbl, .md img { break-inside: avoid; }
    .md a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
<main class="md">
${o.bodyHtml}
</main>
${MD_SCRIPT}
</body>
</html>`;
}

/** Full render: markdown source → stored document. */
export async function renderMarkdownDocument(md: string, title: string): Promise<string> {
  return mdDocumentHtml({ title, bodyHtml: await renderMarkdownBody(md) });
}

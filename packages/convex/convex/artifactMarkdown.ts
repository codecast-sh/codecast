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


// The codecast Solarized palette (web app globals.css), tuned for long reading:
// body text one step softer than headings, code panels on the inset surface,
// and the web app's syntax colours. Written once per scheme and emitted twice
// for dark, because dark applies either by choice (data-theme) or by the OS
// when the reader has made no choice.
const MD_LIGHT = `
  color-scheme: light;
  --md-bg: #fbf5e2; --md-head: #002b36; --md-ink: #073642; --md-mut: #586e75; --md-dim: #93a1a1;
  --md-line: rgba(88,110,117,.2); --md-card: #f3edda; --md-raise: #fffdf6; --md-soft: rgba(147,161,161,.2);
  --md-coral: #e86c5d; --md-link: #b45309; --md-mark: rgba(181,137,0,.22); --md-quote: #2aa198;
  --md-k: #859900; --md-s: #2aa198; --md-n: #d33682; --md-f: #268bd2; --md-c: #93a1a1;
  --md-t: #b58900; --md-v: #cb4b16; --md-b: #dc322f;`;
const MD_DARK = `
  color-scheme: dark;
  --md-bg: #002b36; --md-head: #fdf6e3; --md-ink: #eee8d5; --md-mut: #93a1a1; --md-dim: #657b83;
  --md-line: rgba(147,161,161,.16); --md-card: #073642; --md-raise: #08404e; --md-soft: rgba(147,161,161,.15);
  --md-link: #eba445; --md-mark: rgba(181,137,0,.34); --md-c: #6c8289;`;

const MONO = `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;

/** Loaded by BOTH the published document and the editor preview. Hanken
 * Grotesk for reading text, JetBrains Mono (the codecast face) for headings,
 * code and labels. The @import has to be the first rule of whichever <style>
 * holds this. */
export const MD_THEME_CSS = `
@import url("https://fonts.googleapis.com/css2?family=Hanken+Grotesk:ital,wght@0,400..700;1,400..700&family=JetBrains+Mono:wght@400;500;600;700&display=swap");
:root {${MD_LIGHT} }
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) {${MD_DARK} } }
:root[data-theme=dark] {${MD_DARK} }
.md {
  font: 400 clamp(16px, 1rem + .1vw, 17px)/1.7 "Hanken Grotesk", "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: var(--md-ink);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  font-feature-settings: "kern", "liga", "calt";
  overflow-wrap: break-word; hanging-punctuation: first;
}
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md ::selection { background: color-mix(in srgb, var(--md-coral) 30%, transparent); }
.md p { margin: 0 0 1.15em; text-wrap: pretty; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
  position: relative; font-family: ${MONO}; font-weight: 600; line-height: 1.25; color: var(--md-head);
  letter-spacing: -.02em; text-wrap: balance; scroll-margin-top: 64px;
}
.md h1 { font-size: 1.95em; font-weight: 700; margin: 0 0 .9em; letter-spacing: -.035em; line-height: 1.15; }
/* The Solarized accents as one short strip under the page title. */
.md > h1:first-child::after { content: ""; display: block; width: 88px; height: 3px; margin-top: .55em; border-radius: 2px;
  background: linear-gradient(90deg, #b58900 0 12.5%, #cb4b16 0 25%, #dc322f 0 37.5%, #d33682 0 50%,
    #6c71c4 0 62.5%, #268bd2 0 75%, #2aa198 0 87.5%, #859900 0); }
.md h2 { font-size: 1.28em; margin: 2.1em 0 .6em; }
.md h3 { font-size: 1.08em; margin: 1.8em 0 .5em; }
.md h4 { font-size: .96em; margin: 1.6em 0 .45em; }
.md h5, .md h6 { font-size: .82em; color: var(--md-mut); margin: 1.6em 0 .5em; letter-spacing: 0; }
.md .anchor { position: absolute; right: 100%; margin-right: .55em; top: 0; color: var(--md-coral);
  font-family: ${MONO}; font-weight: 500; text-decoration: none; opacity: 0; transition: opacity .15s ease; }
.md h1 .anchor { line-height: 1.15; }
.md :is(h1,h2,h3,h4,h5,h6):hover .anchor, .md .anchor:focus-visible { opacity: .85; }
@media (min-width: 920px) { .md h2 .anchor { opacity: .32; } }
.md a { color: var(--md-link); text-decoration: underline; text-decoration-thickness: 1px;
  text-decoration-color: color-mix(in srgb, var(--md-link) 38%, transparent); text-underline-offset: .2em;
  transition: text-decoration-color .15s ease, color .15s ease; }
.md a:hover { text-decoration-color: currentColor; }
.md strong { font-weight: 650; color: var(--md-head); }
.md em { font-style: italic; }
.md mark { background: var(--md-mark); color: inherit; padding: 0 .15em; border-radius: 3px; }
.md del { color: var(--md-mut); }
.md small { font-size: .85em; color: var(--md-mut); }
.md sup, .md sub { font-size: .7em; line-height: 0; }
.md code, .md kbd, .md samp { font-family: ${MONO}; font-size: .84em; font-variant-ligatures: none; }
.md :not(pre) > code { background: var(--md-soft); padding: .12em .36em; border-radius: 5px; color: var(--md-head); }
.md a > code { color: inherit; }
.md kbd { display: inline-block; font-size: .74em; line-height: 1; padding: .32em .5em .26em; border: 1px solid var(--md-line);
  border-bottom-width: 2px; border-radius: 5px; background: var(--md-raise); color: var(--md-mut); vertical-align: .1em; }
.md pre { position: relative; margin: 1.5em 0; padding: 1.05em 1.2em; background: var(--md-card);
  border: 1px solid var(--md-line); border-radius: 10px; overflow-x: auto; font-size: .8em; line-height: 1.65;
  -webkit-overflow-scrolling: touch; tab-size: 2; }
.md pre code { display: block; font-size: 1em; background: none; padding: 0; white-space: pre; color: var(--md-ink); }
.md pre[data-lang] { padding-top: 2.3em; }
.md pre[data-lang]::before { content: attr(data-lang); position: absolute; top: 10px; left: 1.5em; color: var(--md-dim);
  font: 500 .8em/1 ${MONO}; pointer-events: none; }
.md pre .copy { all: unset; position: absolute; top: 6px; right: 8px; cursor: pointer; color: var(--md-mut);
  font: 500 .8em/1 ${MONO}; padding: 5px 8px; border-radius: 6px;
  background: var(--md-raise); border: 1px solid var(--md-line); opacity: 0; transition: opacity .15s ease, color .15s ease; }
.md pre:hover .copy, .md pre .copy:focus-visible, .md pre .copy.done { opacity: 1; }
.md pre .copy:hover { color: var(--md-head); }
.md pre .copy.done { color: var(--md-k); border-color: color-mix(in srgb, var(--md-k) 45%, transparent); }
@media (hover: none) { .md pre .copy { opacity: 1; } }
.md blockquote { margin: 1.5em 0; padding: .8em 1.1em; border-left: 3px solid var(--md-quote); border-radius: 0 8px 8px 0;
  background: color-mix(in srgb, var(--md-quote) 7%, transparent); color: var(--md-mut); }
.md blockquote p { margin-bottom: .7em; }
.md blockquote > :last-child { margin-bottom: 0; }
.md ul, .md ol { margin: 0 0 1.15em; padding-left: 1.5em; }
.md li { margin: .32em 0; padding-left: .25em; }
.md li > p { margin-bottom: .5em; }
.md li > ul, .md li > ol { margin: .3em 0 .3em; }
.md ul > li::marker { color: var(--md-coral); }
.md ul ul > li::marker { color: var(--md-dim); }
.md ol > li::marker { color: var(--md-dim); font: 500 .8em ${MONO}; font-variant-numeric: tabular-nums; }
.md li:has(> input[type=checkbox]) { list-style: none; margin-left: -1.5em; padding-left: 0; display: flex; gap: .6em; align-items: baseline; }
.md input[type=checkbox] { appearance: none; -webkit-appearance: none; width: .95em; height: .95em; margin: 0; flex: none;
  position: relative; top: .12em; border: 1.5px solid var(--md-dim); border-radius: 4px; background: var(--md-raise); opacity: 1; }
.md input[type=checkbox]:checked { border-color: var(--md-k); background: var(--md-k); }
.md input[type=checkbox]:checked::after { content: ""; position: absolute; left: .26em; top: .08em; width: .28em; height: .5em;
  border: solid var(--md-bg); border-width: 0 2px 2px 0; transform: rotate(45deg); }
.md li:has(> input[type=checkbox]:checked) { color: var(--md-dim); text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--md-dim) 60%, transparent); }
.md hr { border: 0; margin: 2.8em auto; text-align: center; overflow: visible; height: auto; }
.md hr::before { content: "* * *"; color: var(--md-coral); font: 500 .85em/1 ${MONO}; letter-spacing: .6em; padding-left: .6em; }
.md img, .md video { display: block; max-width: 100%; height: auto; margin: 1.5em auto; border-radius: 8px;
  box-shadow: 0 0 0 1px var(--md-line); }
.md p > img:only-child { margin: .2em auto; }
.md figure { margin: 1.5em 0; }
.md figcaption { text-align: center; color: var(--md-mut); font: 400 .78em/1.5 ${MONO}; margin-top: .7em; }
.md .tbl { margin: 1.5em 0; overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--md-line); border-radius: 10px; }
.md table { border-collapse: collapse; width: 100%; font-size: .92em; line-height: 1.5; font-variant-numeric: tabular-nums lining-nums; }
.md th, .md td { text-align: left; padding: .55em .85em; border-bottom: 1px solid var(--md-line); vertical-align: top; }
.md th { font: 600 .8em/1.4 ${MONO}; color: var(--md-head); background: var(--md-card); white-space: nowrap; }
.md tbody tr:last-child td { border-bottom: 0; }
.md tbody tr:hover td { background: color-mix(in srgb, var(--md-card) 60%, transparent); }
.md details { margin: 1.2em 0; padding: .65em 1em; border: 1px solid var(--md-line); border-radius: 10px; background: var(--md-card); }
.md summary { cursor: pointer; font-weight: 600; color: var(--md-head); }
.md summary::marker { color: var(--md-coral); }
.md details[open] > summary { margin-bottom: .6em; }
.md .hljs-comment, .md .hljs-quote { color: var(--md-c); font-style: italic; }
.md .hljs-keyword, .md .hljs-selector-tag, .md .hljs-doctag, .md .hljs-formula { color: var(--md-k); }
.md .hljs-string, .md .hljs-regexp, .md .hljs-addition, .md .hljs-meta .hljs-string { color: var(--md-s); }
.md .hljs-number, .md .hljs-literal, .md .hljs-symbol, .md .hljs-bullet, .md .hljs-link { color: var(--md-n); }
.md .hljs-title, .md .hljs-title.function_, .md .hljs-section, .md .hljs-name, .md .hljs-selector-id, .md .hljs-selector-class { color: var(--md-f); }
.md .hljs-type, .md .hljs-title.class_, .md .hljs-class .hljs-title, .md .hljs-attr, .md .hljs-attribute { color: var(--md-t); }
.md .hljs-variable, .md .hljs-template-variable, .md .hljs-selector-attr, .md .hljs-selector-pseudo, .md .hljs-meta, .md .hljs-params { color: var(--md-v); }
.md .hljs-built_in { color: var(--md-b); }
.md .hljs-deletion { color: var(--md-b); }
.md .hljs-emphasis { font-style: italic; }
.md .hljs-strong { font-weight: 600; }
.md .hljs-tag { color: var(--md-mut); }
.md .hljs-tag .hljs-name { color: var(--md-f); }
`;

// Theme choice. The embedding codecast window wins (it passes ?theme= for the
// first paint and posts "codecast:theme" when its setting changes), then the
// reader's own toggle, then the OS. Runs in <head> so the first paint already
// wears the right palette. The artifact origin is opaque, so storage throws:
// the reader's choice also rides the address (?theme=) to survive a reload.
const MD_THEME_BOOT = `<script>(function(){
  var d=document.documentElement,t=null,framed=false;
  try{framed=window.self!==window.top;}catch(e){framed=true;}
  try{t=new URLSearchParams(location.search).get("theme");}catch(e){}
  if(t!=="dark"&&t!=="light"){try{t=localStorage.getItem("cc-md-theme");}catch(e){t=null;}}
  if(t==="dark"||t==="light"){d.setAttribute("data-theme",t);if(framed)d.setAttribute("data-theme-host","");}
})();</script>`;

const SUN = `<svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;
const MOON = `<svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>`;

/** Progressive enhancement: a copy button on every code block, and the light
 * and dark toggle. The stored HTML stays semantic; a reader with scripts off
 * gets the code and the OS colour scheme. */
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

  var d=document.documentElement;
  var os=window.matchMedia?matchMedia("(prefers-color-scheme: dark)"):null;
  var still=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
  var current=function(){var t=d.getAttribute("data-theme");return t||(os&&os.matches?"dark":"light");};
  var toggle=document.querySelector(".md-theme");
  var label=function(){if(toggle)toggle.setAttribute("aria-label",current()==="dark"?"Switch to light":"Switch to dark");};
  // Apply a theme. From a click the new palette grows out of the button as a
  // circle; a change from the host just crossfades.
  var setTheme=function(t,from){
    if(t===current()&&d.hasAttribute("data-theme")) return;
    var apply=function(){d.setAttribute("data-theme",t);label();};
    if(still||!document.startViewTransition){apply();return;}
    var vt=document.startViewTransition(apply);
    if(!from) return;
    var x=from.clientX,y=from.clientY,r=Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y));
    vt.ready.then(function(){
      d.animate({clipPath:["circle(0px at "+x+"px "+y+"px)","circle("+r+"px at "+x+"px "+y+"px)"]},
        {duration:560,easing:"cubic-bezier(.3,.7,.2,1)",pseudoElement:"::view-transition-new(root)"});
    });
  };
  label();
  if(toggle) toggle.addEventListener("click",function(e){
    var t=current()==="dark"?"light":"dark";
    var r=toggle.getBoundingClientRect();
    setTheme(t,{clientX:e.clientX||r.left+r.width/2,clientY:e.clientY||r.top+r.height/2});
    try{localStorage.setItem("cc-md-theme",t);}catch(err){}
    try{var u=new URL(location.href);u.searchParams.set("theme",t);history.replaceState(history.state,"",u.href);}catch(err){}
  });
  if(os&&os.addEventListener) os.addEventListener("change",label);
  window.addEventListener("message",function(e){
    var m=e.data;
    if(e.source!==window.parent||!m||m.type!=="codecast:theme"||(m.theme!=="dark"&&m.theme!=="light")) return;
    d.setAttribute("data-theme-host","");
    setTheme(m.theme,null);
  });
})();</script>`;

// The stored document wraps the rendered body in exactly this pair, which is
// what lets restyleMarkdownDocument lift the body back out of a stored page.
const MAIN_OPEN = `<main class="md">\n`;
const MAIN_CLOSE = `\n</main>`;

/** The stored artifact document for a markdown publish. It goes through
 * brandArtifactHtml at serve time like any HTML: the bar reserves its own
 * 40px at the top of <html> and follows the page's background as it changes,
 * so the theme never has to talk to the bar. */
export function mdDocumentHtml(o: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escHtml(o.title)}</title>
${MD_THEME_BOOT}
<style>${MD_THEME_CSS}
  * { box-sizing: border-box; }
  html { background: var(--md-bg); }
  body { margin: 0; background: var(--md-bg); color: var(--md-ink); min-height: 100vh; }
  main { max-width: 42rem; margin: 0 auto;
    padding: clamp(32px, 8vh, 80px) calc(24px + env(safe-area-inset-right)) calc(112px + env(safe-area-inset-bottom)) calc(24px + env(safe-area-inset-left));
    animation: md-rise .6s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes md-rise { from { opacity: 0; transform: translateY(8px); } }
  ::view-transition-old(root), ::view-transition-new(root) { animation: none; mix-blend-mode: normal; }
  .md-theme { all: unset; position: fixed; right: calc(18px + env(safe-area-inset-right)); bottom: calc(18px + env(safe-area-inset-bottom));
    z-index: 10; width: 38px; height: 38px; border-radius: 999px; cursor: pointer; display: grid; place-items: center;
    color: var(--md-mut); background: color-mix(in srgb, var(--md-raise) 88%, transparent);
    box-shadow: 0 0 0 1px var(--md-line), 0 6px 20px -8px rgba(0,43,54,.35);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    transition: color .2s ease, transform .2s cubic-bezier(.3,.7,.2,1); -webkit-tap-highlight-color: transparent; }
  .md-theme:hover { color: var(--md-head); transform: translateY(-2px); }
  .md-theme:active { transform: scale(.94); }
  .md-theme:focus-visible { box-shadow: 0 0 0 2px var(--md-coral); }
  .md-theme svg { grid-area: 1 / 1; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8;
    stroke-linecap: round; stroke-linejoin: round; transition: transform .5s cubic-bezier(.3,.7,.2,1), opacity .3s ease; }
  .md-theme .sun { opacity: 0; transform: rotate(-90deg) scale(.5); }
  :root[data-theme=dark] .md-theme .sun { opacity: 1; transform: none; color: #b58900; }
  :root[data-theme=dark] .md-theme .moon { opacity: 0; transform: rotate(90deg) scale(.5); }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme]) .md-theme .sun { opacity: 1; transform: none; color: #b58900; }
    :root:not([data-theme]) .md-theme .moon { opacity: 0; transform: rotate(90deg) scale(.5); }
  }
  /* A codecast window framing the page owns its theme. */
  :root[data-theme-host] .md-theme { display: none; }
  @media (prefers-reduced-motion: reduce) { main { animation: none; } .md-theme svg { transition: none; } }
  @media (max-width: 640px) { .md .anchor { display: none; } .md h1 { font-size: 1.7em; } }
  @media print {
    :root { --md-bg: #fff; --md-ink: #000; --md-head: #000; --md-card: #fff; }
    main { max-width: none; padding: 0; animation: none; }
    .md .anchor, .md .copy, .md-theme { display: none !important; }
    .md pre, .md blockquote, .md .tbl, .md img { break-inside: avoid; }
    .md a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
${MAIN_OPEN}${o.bodyHtml}${MAIN_CLOSE}
<button class="md-theme" type="button" title="Light or dark">${SUN}${MOON}</button>
${MD_SCRIPT}
</body>
</html>`;
}

/** Full render: markdown source → stored document. */
export async function renderMarkdownDocument(md: string, title: string): Promise<string> {
  return mdDocumentHtml({ title, bodyHtml: await renderMarkdownBody(md) });
}

/** A stored markdown page wearing the CURRENT shell. The stored document froze
 * the theme of the day it was published; serving re-wraps its rendered body so
 * every page, old or new, reads the same. A document not in the stored shape
 * is returned as it is. */
export function restyleMarkdownDocument(stored: string, title: string): string {
  const start = stored.indexOf(MAIN_OPEN);
  const end = stored.lastIndexOf(MAIN_CLOSE);
  if (start < 0 || end < start + MAIN_OPEN.length) return stored;
  return mdDocumentHtml({ title, bodyHtml: stored.slice(start + MAIN_OPEN.length, end) });
}

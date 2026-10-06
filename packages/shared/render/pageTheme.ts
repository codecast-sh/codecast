// The theme contract between codecast and a published HTML page framed in it.
//
// A page served by `cast publish` gets a small bootstrap at the top of its
// <head>: the codecast colour tokens (--sol-*) as CSS custom properties, so an
// agent's page can style against the same names a cast-canvas uses and follow
// the reader's palette and light/dark setting. The framing window posts the
// live token values ("codecast:theme" with `tokens`), and the page reports the
// height its content needs ("codecast:height") so the frame can fit it.
//
// The bootstrap only declares variables and never styles elements, so a page
// that ignores the tokens looks exactly as it did before. It rewrites its own
// <style> rather than setting inline properties, so a page's later :root rules
// still win. Pure strings: imported by the Convex serve route and by web.

export const PAGE_THEME_MESSAGE = "codecast:theme";
export const PAGE_HEIGHT_MESSAGE = "codecast:height";

/** The tokens a framed page receives, by name without the leading dashes. */
export const PAGE_THEME_TOKENS = [
  "sol-bg", "sol-bg-alt", "sol-bg-highlight", "sol-card", "sol-border",
  "sol-text", "sol-text-secondary", "sol-text-muted", "sol-text-dim",
  "sol-blue", "sol-green", "sol-yellow", "sol-orange", "sol-red",
  "sol-magenta", "sol-violet", "sol-cyan",
] as const;

export type PageThemeTokens = Partial<Record<(typeof PAGE_THEME_TOKENS)[number], string>>;

const ACCENTS = {
  "sol-yellow": "#b58900", "sol-orange": "#cb4b16", "sol-red": "#dc322f", "sol-magenta": "#d33682",
  "sol-violet": "#6c71c4", "sol-blue": "#268bd2", "sol-cyan": "#2aa198", "sol-green": "#859900",
};

/** Classic Solarized, for a page opened on its own or before the host speaks. */
export const PAGE_THEME_DEFAULTS: Record<"light" | "dark", Required<PageThemeTokens>> = {
  light: {
    "sol-bg": "#FBF5E2", "sol-bg-alt": "#eee8d5", "sol-bg-highlight": "#e4ddc8", "sol-card": "#ffffff",
    "sol-border": "#93a1a1", "sol-text": "#002b36", "sol-text-secondary": "#073642",
    "sol-text-muted": "#586e75", "sol-text-dim": "#657b83", ...ACCENTS,
  },
  dark: {
    "sol-bg": "#002b36", "sol-bg-alt": "#073642", "sol-bg-highlight": "#094959", "sol-card": "#08404e",
    "sol-border": "#586e75", "sol-text": "#fdf6e3", "sol-text-secondary": "#eee8d5",
    "sol-text-muted": "#93a1a1", "sol-text-dim": "#657b83", ...ACCENTS,
  },
};

const FONT_MONO = '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';

function declarations(tokens: PageThemeTokens): string {
  return Object.entries(tokens).map(([name, value]) => `--${name}:${value};`).join("") + `--font-mono:${FONT_MONO};`;
}

const DEFAULT_CSS =
  `:root{${declarations(PAGE_THEME_DEFAULTS.light)}}` +
  `@media (prefers-color-scheme: dark){:root{${declarations(PAGE_THEME_DEFAULTS.dark)}}}`;

// Theme: ?theme=dark|light (the frame's first paint) picks a default palette;
// a host message replaces it with the live values. `data-codecast-theme` on
// <html> names the mode for pages that branch on it. Height: only when framed,
// the bottom of <body> (the document's scrollHeight never drops below the
// frame, so alone it could never shrink it), or the scrollHeight when content
// overflows the frame, posted on every change.
const BOOT_SCRIPT = `(function(){
var s=document.getElementById("cc-page-theme"),d=document.documentElement,D=${JSON.stringify(PAGE_THEME_DEFAULTS)},F=${JSON.stringify(FONT_MONO)};
if(!s)return;
function put(mode,tokens){var c=":root{";for(var k in tokens){if(/^sol-[a-z0-9-]+$/.test(k))c+="--"+k+":"+String(tokens[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"--font-mono:"+F+";}";if(mode)d.setAttribute("data-codecast-theme",mode);}
try{var t=new URLSearchParams(location.search).get("theme");if(t==="dark"||t==="light")put(t,D[t]);}catch(e){}
var framed=false;try{framed=window.self!==window.top;}catch(e){framed=true;}
window.addEventListener("message",function(e){var m=e.data;if(e.source!==window.parent||!m||m.type!==${JSON.stringify(PAGE_THEME_MESSAGE)})return;var mode=m.theme==="dark"||m.theme==="light"?m.theme:null;if(m.tokens&&typeof m.tokens==="object")put(mode,m.tokens);else if(mode)put(mode,D[mode]);});
if(!framed||typeof ResizeObserver==="undefined")return;
var last=0,raf=0;function report(){raf=0;var b=document.body;if(!b)return;var h=Math.ceil(b.getBoundingClientRect().bottom+window.scrollY+(parseFloat(getComputedStyle(b).marginBottom)||0));if(d.scrollHeight>innerHeight)h=Math.max(h,d.scrollHeight);if(h>0&&h!==last){last=h;window.parent.postMessage({type:${JSON.stringify(PAGE_HEIGHT_MESSAGE)},height:h},"*");}}
function queue(){if(!raf)raf=requestAnimationFrame(report);}
function watch(){var ro=new ResizeObserver(queue);ro.observe(d);if(document.body)ro.observe(document.body);queue();}
if(document.body)watch();else document.addEventListener("DOMContentLoaded",watch);
window.addEventListener("load",queue);
})();`;

const BOOTSTRAP = `<style id="cc-page-theme">${DEFAULT_CSS}</style><script>${BOOT_SCRIPT}</script>`;

/** Insert the theme bootstrap at the start of <head>, so the page's own styles come after it. */
export function injectPageTheme(html: string): string {
  if (html.includes('id="cc-page-theme"')) return html;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + BOOTSTRAP + html.slice(head.index + head[0].length);
  const root = /<html(?:\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + `<head>${BOOTSTRAP}</head>` + html.slice(root.index + root[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + `<head>${BOOTSTRAP}</head>` + html.slice(doctype[0].length);
  return BOOTSTRAP + html;
}

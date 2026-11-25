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
// that ignores the tokens looks exactly as it did before. The one exception is
// the canvas of a framed page that paints none of its own: a frame shows the
// host through it, so a page written for a white tab (dark text, no
// background) would put that text on a dark host. When the page's text sits on
// the same side of light and dark as the host's --sol-bg, it gets the backdrop
// a tab would have given it; a page whose text follows the tokens stays clear. It rewrites its own
// <style> rather than setting inline properties, so a page's later :root rules
// still win. Pure strings: imported by the Convex serve route and by web.

export const PAGE_THEME_MESSAGE = "codecast:theme";
export const PAGE_HEIGHT_MESSAGE = "codecast:height";
// A gate standing in front of a page (its password form, its email wall, its
// expiry notice) says so to the window framing it, before anything else, so an
// embed that started loading before it knew the page's gates can tell the
// gate from the page and keep it hidden until it has the way through.
export const PAGE_GATE_MESSAGE = "codecast:gate";
// The framing window moved the page out of sight but kept it alive (the app's
// frame pool keeps a page a reader just left, to show it again at once): the
// page stops whatever it is playing, open shadow roots included, so a player
// does not go on sounding from a page nobody sees.
export const PAGE_PARK_MESSAGE = "codecast:park";
// Escape pressed inside a framed page: a host that lets people step into the
// page (a board) steps back out, since the key never reaches the host itself.
export const PAGE_ESCAPE_MESSAGE = "codecast:escape";
// A wheel over a page that takes no pointer (a board's page before it is
// entered): the host forwards it so the page scrolls in place. x and y are the
// pointer in the page's own CSS pixels; the page scrolls the innermost element
// under it that can still move that way, else the document.
export const PAGE_WHEEL_MESSAGE = "codecast:wheel";
// The page's half of it, as script text every page runs: a markdown page carries its own script and calls
// ccWheel(m) from its message listener just as the bootstrap does.
export const PAGE_WHEEL_JS = `function ccCanScroll(n,dx,dy){var c=getComputedStyle(n),y=/(auto|scroll|overlay)/.test(c.overflowY),x=/(auto|scroll|overlay)/.test(c.overflowX);return (dy>0&&y&&n.scrollTop+n.clientHeight<n.scrollHeight-1)||(dy<0&&y&&n.scrollTop>0)||(dx>0&&x&&n.scrollLeft+n.clientWidth<n.scrollWidth-1)||(dx<0&&x&&n.scrollLeft>0);}
function ccWheel(m){var r=document.documentElement,b=document.body,dx=+m.dx||0,dy=+m.dy||0,n=document.elementFromPoint(+m.x||0,+m.y||0);while(n&&n!==b&&n!==r&&!ccCanScroll(n,dx,dy))n=n.parentElement;(n&&n!==b&&n!==r?n:(document.scrollingElement||r)).scrollBy({left:dx,top:dy,behavior:"instant"});}`;
export const PAGE_GATE_SIGNAL = `<script>try{if(window.parent!==window)window.parent.postMessage({type:${JSON.stringify(PAGE_GATE_MESSAGE)}},"*")}catch(e){}</script>`;

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
// overflows the frame, posted on every change. With it rides the height the
// page asks to open at, from <meta name="codecast:height" content="640">. A
// frame not laid out yet (a
// background tab loads it at 0x0) is never measured: its text wraps at zero
// width into a page a hundred times its real height, and the host would grow
// the frame to that. The frame's first real size arrives as a resize.
const BOOT_SCRIPT = `(function(){
var s=document.getElementById("cc-page-theme"),d=document.documentElement,D=${JSON.stringify(PAGE_THEME_DEFAULTS)},F=${JSON.stringify(FONT_MONO)};
if(!s)return;
function put(mode,tokens){var c=":root{";for(var k in tokens){if(/^sol-[a-z0-9-]+$/.test(k))c+="--"+k+":"+String(tokens[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"--font-mono:"+F+";}";if(mode)d.setAttribute("data-codecast-theme",mode);backdrop();}
function rgba(c){c=String(c||"").trim();var h=/^#([0-9a-f]{3,8})$/i.exec(c);if(h){h=h[1];if(h.length<6)h=h.replace(/./g,"$&$&");return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16),h.length>6?parseInt(h.slice(6,8),16)/255:1];}var m=/^(rgba?|color)\\(\\s*(?:srgb\\s+)?([^)]*)\\)$/i.exec(c);if(!m)return null;var p=m[2].split(/[\\s,\\/]+/).filter(Boolean).map(function(v){return v.slice(-1)==="%"?parseFloat(v)/100:parseFloat(v);});var k=m[1].toLowerCase()==="color"?255:1;return [p[0]*k,p[1]*k,p[2]*k,p.length>3?p[3]:1];}
function dark(c){return (0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255<0.5;}
var bd=null;function backdrop(){try{paint();}catch(e){}}function paint(){if(!framed||!document.body)return;if(!bd){bd=document.createElement("style");bd.id="cc-page-backdrop";(document.head||d).appendChild(bd);}bd.textContent="";var html=rgba(getComputedStyle(d).backgroundColor),body=rgba(getComputedStyle(document.body).backgroundColor);if((html&&html[3]>0)||(body&&body[3]>0))return;var ink=rgba(getComputedStyle(document.body).color),under=rgba(getComputedStyle(d).getPropertyValue("--sol-bg"));if(!ink||!under||dark(ink)!==dark(under))return;bd.textContent="html{background-color:"+(dark(ink)?"#ffffff":D.dark["sol-bg"])+"}";}
try{var t=new URLSearchParams(location.search).get("theme");if(t==="dark"||t==="light")put(t,D[t]);}catch(e){}
var framed=false;try{framed=window.self!==window.top;}catch(e){framed=true;}
${PAGE_WHEEL_JS}
function hush(root){var all=root.querySelectorAll("*");for(var i=0;i<all.length;i++){var n=all[i];if((n.tagName==="VIDEO"||n.tagName==="AUDIO")&&!n.paused)try{n.pause();}catch(e){}if(n.shadowRoot)hush(n.shadowRoot);}}
window.addEventListener("message",function(e){var m=e.data;if(e.source===window.parent&&m&&m.type===${JSON.stringify(PAGE_PARK_MESSAGE)}){hush(document);return;}if(e.source===window.parent&&m&&m.type===${JSON.stringify(PAGE_WHEEL_MESSAGE)}){ccWheel(m);return;}if(e.source!==window.parent||!m||m.type!==${JSON.stringify(PAGE_THEME_MESSAGE)})return;var mode=m.theme==="dark"||m.theme==="light"?m.theme:null;if(m.tokens&&typeof m.tokens==="object")put(mode,m.tokens);else if(mode)put(mode,D[mode]);});
if(framed){if(document.body)backdrop();document.addEventListener("DOMContentLoaded",backdrop);window.addEventListener("load",backdrop);}
if(framed)window.addEventListener("keydown",function(e){if(e.key==="Escape"&&!e.defaultPrevented)try{window.parent.postMessage({type:${JSON.stringify(PAGE_ESCAPE_MESSAGE)}},"*")}catch(x){}});
if(!framed||typeof ResizeObserver==="undefined")return;
var last=0;function report(){var b=document.body;if(!b||!innerWidth||!innerHeight)return;var h=Math.ceil(b.getBoundingClientRect().bottom+window.scrollY+(parseFloat(getComputedStyle(b).marginBottom)||0));if(d.scrollHeight>innerHeight)h=Math.max(h,d.scrollHeight);if(h>0&&h!==last){last=h;var pm=document.querySelector('meta[name="codecast:height"]'),p=pm?parseInt(pm.getAttribute("content")||"",10):NaN;window.parent.postMessage({type:${JSON.stringify(PAGE_HEIGHT_MESSAGE)},height:h,preferred:p>0?p:null},"*");}}
function watch(){var ro=new ResizeObserver(report);ro.observe(d);if(document.body)ro.observe(document.body);report();}
if(document.body)watch();else document.addEventListener("DOMContentLoaded",watch);
window.addEventListener("load",report);window.addEventListener("resize",report);
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

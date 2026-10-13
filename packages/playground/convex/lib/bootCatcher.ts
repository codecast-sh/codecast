// What every served app page carries before its own code: the protocol's
// name the shell and the SDK speak (runtime/protocol), and the boot catcher.
// A leaf with no imports, so the SDK bundle can read it without the rest of
// the runtime contract.

/** The shell and app protocol's name (runtime/protocol). */
export const PROTOCOL = "clayground/1";

/** Raised by the SDK once its own error reporting runs. */
export const SDK_LOADED_FLAG = "__claygroundSdk";

/** Served first in every version's index.html. Until the SDK runs, it tells
 *  the shell about what keeps an app from starting: a module that failed to
 *  load (a CDN import, a missing file) or threw while evaluating. The SDK
 *  lives inside that module graph, so it cannot see those itself. */
export const BOOT_CATCHER = `<script>(()=>{let n=0;const say=(m)=>{if(window.${SDK_LOADED_FLAG}||parent===window||n++>=3)return;\
parent.postMessage({protocol:"${PROTOCOL}",type:"error",message:String(m).slice(0,500)},"*")};\
addEventListener("error",(e)=>{const t=e.target;\
if(t instanceof HTMLScriptElement)say("Couldn't load "+(t.getAttribute("src")||"a script")+" or a module it imports");\
else if(t instanceof HTMLLinkElement)say("Couldn't load "+t.getAttribute("href"));\
else if(t===window)say((e.error&&e.error.message)||e.message)},true);\
addEventListener("unhandledrejection",(e)=>say((e.reason&&e.reason.message)||e.reason))})()</script>`;

/** An entry page with the catcher first inside <head> (or first of all). */
export function withBootCatcher(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return BOOT_CATCHER + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + BOOT_CATCHER + html.slice(at);
}

// The <cast-player> element's code, served same-origin as /cast-player.js by
// plugins/castPlayerScript.ts. An element created before the script lands
// upgrades itself when it does, so callers create theirs right after calling this.
export function loadCastPlayer(): void {
  if (customElements.get("cast-player") || document.querySelector('script[src="/cast-player.js"]')) return;
  const s = document.createElement("script");
  s.src = "/cast-player.js";
  s.async = true;
  document.head.appendChild(s);
}

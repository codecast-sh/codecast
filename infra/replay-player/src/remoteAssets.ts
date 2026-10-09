// The remote hosts a DOM capture would load its assets from, for the player's
// "load remote assets" opt-in (worker.ts header). The page loads none of them
// unless the viewer asks on that view; this names them first, so the viewer
// knows which hosts would learn that they opened the replay.
//
// rrweb serializes the page as nested nodes (a full snapshot's tree, and the
// nodes and attribute changes of each mutation). Only what a browser would
// fetch counts: src, srcset and poster on any element, href on <link>, and
// url(...) or @import in inline styles and inlined stylesheets. A link's href
// on <a> is never fetched, so it is not counted.

const CSS_URL = /https:\/\/[^\s'"(),]+/g;

function hostOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}

/** Distinct https hosts the capture's assets name, in the order first seen. */
export function remoteAssetHosts(events: unknown[]): string[] {
  const hosts = new Set<string>();
  const add = (url: string) => {
    const h = hostOf(url);
    if (h) hosts.add(h);
  };
  const css = (text: string) => {
    for (const m of text.match(CSS_URL) ?? []) add(m);
  };
  const stack: unknown[] = [...events];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    const o = v as Record<string, unknown>;
    const attrs = o.attributes;
    if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
      const a = attrs as Record<string, unknown>;
      const tag = typeof o.tagName === "string" ? o.tagName.toLowerCase() : "";
      for (const k of ["src", "poster"]) if (typeof a[k] === "string") add(a[k] as string);
      if (typeof a.srcset === "string") css(a.srcset);
      if (typeof a.href === "string" && tag === "link") add(a.href);
      if (typeof a.style === "string") css(a.style);
      if (typeof a._cssText === "string") css(a._cssText);
    }
    if (o.isStyle === true && typeof o.textContent === "string") css(o.textContent);
    for (const k in o) {
      const x = o[k];
      if (x && typeof x === "object") stack.push(x);
    }
  }
  return [...hosts];
}

/** The opt-in's label: one host by name, more as the first and a count. */
export function remoteAssetsLabel(hosts: string[]): string {
  if (!hosts.length) return "";
  const rest = hosts.length - 1;
  return `Load images from ${hosts[0]}${rest ? ` and ${rest} other site${rest === 1 ? "" : "s"}` : ""}`;
}

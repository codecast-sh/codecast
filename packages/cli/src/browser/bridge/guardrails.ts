/**
 * What the bridge host refuses or narrows on the CDP face, for every client,
 * whatever engine or raw script it is. The verb-level checks in siteGuard.ts
 * bind only `cast browser`; anything holding the bridge token can speak CDP
 * directly, so the rules that protect the human's Chrome live here, in the
 * one process every client goes through.
 *
 * Three kinds of rule, all pure so they test without a Chrome:
 *
 *   1. Methods refused outright (`methodRefusal`): wiping the human's cookies
 *      or cache, closing their browser, changing site permissions, and
 *      navigating to file:, chrome:, devtools: and the like.
 *   2. Cookie and storage access scoped to the hosts of the tabs the client
 *      has attached (`scopeRefusal`, `filterCookieReply`). A tab at a host
 *      already shows that site, so reading its cookies grants nothing the tab
 *      did not; the rest of the jar (the human's mail, bank, every other
 *      sign-in) stays out of reach.
 *   3. The site allowlist is policy.ts's; the host applies it per tab.
 */

/** URL schemes no client may navigate a tab to: the local disk and the browser's own privileged pages. */
const BLOCKED_NAV_SCHEMES = new Set(["file", "chrome", "chrome-extension", "chrome-untrusted", "devtools", "view-source"]);

/**
 * The scheme Chrome will navigate to for `url`, lowercased, or null when it
 * has none. Judged on the URL as the URL parser sees it, not as typed: the
 * parser trims C0 controls and spaces from both ends and drops every tab and
 * newline anywhere, so "f\tile:///etc/hosts" and "\u0000file:..." both load
 * file:///etc/hosts. A raw-string pattern let those through (found by the
 * bridge fuzzer, scripts/browser-stress/fuzz.ts).
 */
export function navScheme(url: string): string | null {
  const cleaned = url.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\n\r]/g, "");
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  return m ? m[1].toLowerCase() : null;
}

/** Methods refused for every client, with the reason the client reads. */
const REFUSED: Record<string, string> = {
  "Network.clearBrowserCookies": "it deletes every cookie in the human's Chrome, signing them out of every site",
  "Network.clearBrowserCache": "it empties the human's whole browser cache",
  "Storage.clearCookies": "it deletes every cookie in the human's Chrome, signing them out of every site",
  "Browser.close": "it closes the human's Chrome",
  "Browser.crash": "it crashes the human's Chrome",
  "Browser.crashGpuProcess": "it crashes the human's Chrome",
  "Browser.grantPermissions": "site permissions in the human's Chrome are theirs to change",
  "Browser.resetPermissions": "site permissions in the human's Chrome are theirs to change",
  "Browser.setPermission": "site permissions in the human's Chrome are theirs to change",
};

/** Cookie reads whose reply is narrowed to the client's hosts. */
export const COOKIE_READS: ReadonlySet<string> = new Set(["Network.getAllCookies", "Network.getCookies", "Storage.getCookies"]);

/** Domains whose methods can name an origin's storage. */
const ORIGIN_DOMAINS = /^(Storage|IndexedDB|CacheStorage|DOMStorage)\./;

/**
 * The refusal for a method no client may call (or call with these params), or
 * null. Covers both faces: browser-scope `Target.createTarget` is checked for
 * its URL like a session's `Page.navigate`.
 */
export function methodRefusal(method: string, params: any): string | null {
  const why = REFUSED[method];
  if (why) return refusal(method, why);
  // Every storage-type clear (clearDataForOrigin, clearDataForStorageKey,
  // clearSharedStorageEntries, clearTrustTokens, ...) wipes data the human's
  // sites keep; none is needed to drive a page.
  if (/^Storage\.clear/.test(method)) return refusal(method, "it deletes site data the human's Chrome keeps");
  if (method === "Page.navigate" || method === "Target.createTarget") {
    const url = typeof params?.url === "string" ? params.url : "";
    const scheme = navScheme(url);
    if (scheme && BLOCKED_NAV_SCHEMES.has(scheme)) {
      return refusal(method, `${scheme}: pages reach the local disk or the browser's own settings, never a site`);
    }
  }
  return null;
}

function refusal(method: string, why: string): string {
  return `the cast bridge refuses ${method}: ${why}`;
}

/** Whether `scopeRefusal` needs the client's hosts for this method (they cost a tab listing). */
export function needsScope(method: string): boolean {
  return (
    method === "Network.deleteCookies" ||
    method === "Network.getCookies" ||
    method === "Network.setCookie" ||
    method === "Network.setCookies" ||
    method === "Storage.setCookies" ||
    ORIGIN_DOMAINS.test(method)
  );
}

/** The hostname of an http(s) URL, lowercased, or null. */
export function webHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Whether a cookie for `domain` belongs to one of `hosts`: the host would be
 * sent it (`.example.com` for www.example.com), or it is the host's own or a
 * subdomain's (`mail.example.com` for a tab at example.com, which a sign-in
 * spanning the site needs).
 */
export function cookieInScope(domain: string, hosts: readonly string[]): boolean {
  const d = domain.trim().toLowerCase().replace(/^\./, "");
  if (!d) return false;
  return hosts.some((h) => h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`));
}

/** The host of an origin-keyed storage parameter (`https://x.com`, a storage key `https://x.com/^0...`), or null. */
function originHost(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return webHost(value.split("^")[0]) ?? "";
}

/** Every origin a storage method's params name, as hosts ("" for an origin that is not a web page). */
function namedOrigins(params: any): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    const h = originHost(v);
    if (h !== null) out.push(h);
  };
  add(params?.origin);
  add(params?.securityOrigin);
  add(params?.storageKey);
  add(params?.ownerOrigin);
  add(params?.storageId?.securityOrigin);
  add(params?.storageId?.storageKey);
  add(params?.storageBucket?.storageKey);
  return out;
}

/** Where a cookie a client wants to write or delete lives: its domain, else its URL's host. */
function cookieTarget(c: any): string | null {
  if (typeof c?.domain === "string" && c.domain) return c.domain;
  if (typeof c?.url === "string") return webHost(c.url);
  return null;
}

/**
 * The refusal for a cookie or storage call that reaches past the client's own
 * tabs, or null. `hosts` are the hostnames of the tabs this client has
 * attached.
 */
export function scopeRefusal(method: string, params: any, hosts: readonly string[]): string | null {
  const scope = hosts.length ? hosts.join(", ") : "none: its tabs show no web page";
  const outside = (what: string) => `the cast bridge refuses ${method} for ${what}: a client reaches only the cookies and storage of the sites its own tabs show (${scope})`;
  switch (method) {
    case "Network.getCookies": {
      const urls: unknown[] = Array.isArray(params?.urls) ? params.urls : [];
      const bad = urls.find((u) => {
        const h = typeof u === "string" ? webHost(u) : null;
        return !h || !cookieInScope(h, hosts);
      });
      return bad === undefined ? null : outside(String(bad));
    }
    case "Network.deleteCookies":
    case "Network.setCookie": {
      const target = cookieTarget(params);
      if (!target) return outside(`a cookie that names no domain or url`);
      return cookieInScope(target, hosts) ? null : outside(target);
    }
    case "Network.setCookies":
    case "Storage.setCookies": {
      const cookies: unknown[] = Array.isArray(params?.cookies) ? params.cookies : [];
      for (const c of cookies) {
        const target = cookieTarget(c);
        if (!target) return outside(`a cookie that names no domain or url`);
        if (!cookieInScope(target, hosts)) return outside(target);
      }
      return null;
    }
  }
  if (ORIGIN_DOMAINS.test(method)) {
    for (const h of namedOrigins(params)) {
      if (!h || !hosts.includes(h)) return outside(h || "an origin that is not a web page");
    }
  }
  return null;
}

/** A cookie read's reply with every cookie outside the client's hosts removed. */
export function filterCookieReply(result: any, hosts: readonly string[]): any {
  if (!result || !Array.isArray(result.cookies)) return result;
  return { ...result, cookies: result.cookies.filter((c: any) => typeof c?.domain === "string" && cookieInScope(c.domain, hosts)) };
}

import { describe, expect, test } from "bun:test";
import { cookieInScope, filterCookieReply, methodRefusal, needsScope, scopeRefusal, webHost } from "./guardrails.js";

describe("methodRefusal", () => {
  test.each([
    "Network.clearBrowserCookies",
    "Network.clearBrowserCache",
    "Storage.clearCookies",
    "Storage.clearDataForOrigin",
    "Storage.clearDataForStorageKey",
    "Storage.clearSharedStorageEntries",
    "Browser.close",
    "Browser.crash",
    "Browser.grantPermissions",
    "Browser.resetPermissions",
    "Browser.setPermission",
  ])("refuses %s and names it", (method) => {
    expect(methodRefusal(method, {})).toContain(`the cast bridge refuses ${method}`);
  });

  test.each(["file:///etc/passwd", "chrome://settings", "CHROME-EXTENSION://abc/x.html", "devtools://devtools/x", " view-source:https://x.com", "chrome-untrusted://x"])(
    "refuses navigating to %s, from Page.navigate and Target.createTarget",
    (url) => {
      expect(methodRefusal("Page.navigate", { url })).toMatch(/refuses Page.navigate: [a-z-]+: pages reach the local disk/);
      expect(methodRefusal("Target.createTarget", { url })).toMatch(/refuses Target.createTarget/);
    },
  );

  // Chrome's URL parser drops tabs and newlines anywhere and trims C0
  // controls from the ends, so these all load the blocked page (the bridge
  // fuzzer reached file:///etc/hosts with each before navScheme).
  test.each(["f\tile:///etc/hosts", "file\t:///etc/hosts", "\u0000file:///etc/hosts", "\u001ffile:///etc/hosts", "chrome\r-extension://x", "ch\nrome://settings", "file:///x\u0000"])(
    "refuses the parser-normalized spelling %j",
    (url) => {
      expect(methodRefusal("Page.navigate", { url })).toMatch(/pages reach the local disk/);
      expect(methodRefusal("Target.createTarget", { url })).toMatch(/refuses Target.createTarget/);
    },
  );

  test("lets ordinary driving through", () => {
    for (const [method, params] of [
      ["Page.navigate", { url: "https://example.com" }],
      ["Page.navigate", { url: "about:blank" }],
      ["Target.createTarget", {}],
      ["Runtime.evaluate", { expression: "1" }],
      ["Network.getCookies", {}],
      ["Storage.getCookies", {}],
      ["Browser.getVersion", {}],
    ] as const) {
      expect(methodRefusal(method, params)).toBeNull();
    }
  });
});

describe("cookie scope", () => {
  test("a cookie is in scope when the host is sent it, or it is the host's own or a subdomain's", () => {
    expect(cookieInScope(".example.com", ["www.example.com"])).toBe(true);
    expect(cookieInScope("example.com", ["example.com"])).toBe(true);
    expect(cookieInScope("mail.example.com", ["example.com"])).toBe(true);
    expect(cookieInScope("docs.example.com", ["mail.example.com"])).toBe(false);
    expect(cookieInScope(".bank.com", ["example.com"])).toBe(false);
    expect(cookieInScope("notexample.com", ["example.com"])).toBe(false);
    expect(cookieInScope(".example.com", [])).toBe(false);
    expect(cookieInScope("", ["example.com"])).toBe(false);
  });

  test("a tab at a public suffix reaches none of the cookies under it", () => {
    const jar = { cookies: [{ name: "g", domain: ".google.com" }, { name: "m", domain: "mail.google.com" }, { name: "b", domain: ".bank.co.uk" }, { name: "p", domain: "me.github.io" }] };
    for (const url of ["http://com/", "http://co.uk/", "https://github.io/"]) {
      expect(filterCookieReply(jar, [webHost(url)!]).cookies).toEqual([]);
    }
    expect(scopeRefusal("Network.setCookie", { domain: ".google.com", name: "x", value: "y" }, ["com"])).not.toBeNull();
    expect(scopeRefusal("Network.getCookies", { urls: ["https://mail.google.com/"] }, ["com"])).not.toBeNull();
    // A real site keeps its subdomains, under a multi-label suffix too.
    expect(cookieInScope("mail.bank.co.uk", ["bank.co.uk"])).toBe(true);
    expect(cookieInScope("api.me.github.io", ["me.github.io"])).toBe(true);
    expect(cookieInScope("localhost", ["localhost"])).toBe(true);
  });

  test("webHost reads only web pages", () => {
    expect(webHost("https://WWW.Example.com:8443/a")).toBe("www.example.com");
    expect(webHost("about:blank")).toBeNull();
    expect(webHost("file:///x")).toBeNull();
    expect(webHost("nonsense")).toBeNull();
  });

  test("cookie reads are filtered to the client's hosts", () => {
    const reply = { cookies: [{ name: "a", domain: ".example.com" }, { name: "b", domain: "bank.com" }, { name: "c" }] };
    expect(filterCookieReply(reply, ["www.example.com"]).cookies.map((c: any) => c.name)).toEqual(["a"]);
    expect(filterCookieReply(reply, []).cookies).toEqual([]);
    expect(filterCookieReply({ other: 1 }, [])).toEqual({ other: 1 });
  });

  test("getCookies urls, cookie writes and deletes are held to the client's hosts", () => {
    const hosts = ["www.example.com"];
    expect(scopeRefusal("Network.getCookies", {}, hosts)).toBeNull();
    expect(scopeRefusal("Network.getCookies", { urls: ["https://www.example.com/a"] }, hosts)).toBeNull();
    expect(scopeRefusal("Network.getCookies", { urls: ["https://www.example.com", "https://bank.com"] }, hosts)).toContain("https://bank.com");
    expect(scopeRefusal("Network.setCookie", { name: "x", value: "1", url: "https://www.example.com" }, hosts)).toBeNull();
    expect(scopeRefusal("Network.setCookie", { name: "x", value: "1", domain: ".bank.com" }, hosts)).toContain(".bank.com");
    expect(scopeRefusal("Network.setCookie", { name: "x", value: "1" }, hosts)).toContain("names no domain or url");
    expect(scopeRefusal("Network.setCookies", { cookies: [{ name: "x", domain: ".example.com" }, { name: "y", domain: "bank.com" }] }, hosts)).toContain("bank.com");
    expect(scopeRefusal("Storage.setCookies", { cookies: [{ name: "x", domain: ".example.com" }] }, hosts)).toBeNull();
    expect(scopeRefusal("Network.deleteCookies", { name: "sid", domain: "example.com" }, hosts)).toBeNull();
    expect(scopeRefusal("Network.deleteCookies", { name: "sid", url: "https://bank.com/" }, hosts)).toContain("bank.com");
    expect(scopeRefusal("Network.deleteCookies", { name: "sid" }, hosts)).toContain("names no domain or url");
  });

  test("storage methods naming another origin are refused; the tab's own origin passes", () => {
    const hosts = ["www.example.com"];
    expect(scopeRefusal("IndexedDB.requestDatabaseNames", { securityOrigin: "https://www.example.com" }, hosts)).toBeNull();
    expect(scopeRefusal("IndexedDB.requestDatabaseNames", { securityOrigin: "https://bank.com" }, hosts)).toContain("bank.com");
    expect(scopeRefusal("IndexedDB.requestData", { storageKey: "https://bank.com/^0https://www.example.com" }, hosts)).toContain("bank.com");
    expect(scopeRefusal("CacheStorage.requestCacheNames", { securityOrigin: "https://bank.com" }, hosts)).toContain("bank.com");
    expect(scopeRefusal("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: "https://bank.com", isLocalStorage: true } }, hosts)).toContain("bank.com");
    expect(scopeRefusal("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: "https://www.example.com", isLocalStorage: true } }, hosts)).toBeNull();
    expect(scopeRefusal("Storage.getUsageAndQuota", { origin: "chrome://settings" }, hosts)).toContain("not a web page");
    expect(scopeRefusal("DOMStorage.enable", {}, hosts)).toBeNull();
  });

  test("needsScope names exactly the calls that are checked", () => {
    expect(needsScope("Network.getCookies")).toBe(true);
    expect(needsScope("IndexedDB.requestData", { securityOrigin: "https://x.com" })).toBe(true);
    expect(needsScope("IndexedDB.requestData", { storageBucket: { storageKey: "https://x.com/" } })).toBe(true);
    // Storage calls that name no origin cost no tab listing.
    expect(needsScope("DOMStorage.enable", {})).toBe(false);
    expect(needsScope("Storage.getStorageKeyForFrame", { frameId: "F" })).toBe(false);
    expect(needsScope("Runtime.evaluate")).toBe(false);
    expect(needsScope("Network.enable")).toBe(false);
  });
});

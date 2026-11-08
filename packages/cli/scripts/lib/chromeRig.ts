/**
 * Scratch-Chrome plumbing shared by the extension smoke test
 * (packages/browser-extension/smoke.mjs) and the isolated e2e rig
 * (scripts/browser-rig.ts): find a Chrome that still honours
 * --load-extension, talk raw CDP to it, reach the extension's own pages, and
 * pair the extension with a bridge the way `cast browser extension setup`
 * does. Nothing here touches the human's Chrome: every function takes the
 * scratch Chrome's own CDP port.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { BRIDGE_EXTENSION_ID, bridgePairingPage, bridgePairingUrl } from "../../src/browser/bridge/protocol.ts";

/** Opening a page in a Chrome that just started can take most of a minute on a loaded machine. */
const PAGE_OPEN_MS = 60_000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A loopback port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * A Chromium that loads unpacked extensions from the command line: Chrome for
 * Testing from the Playwright or Puppeteer cache (newest first), else a
 * Chromium build. Branded Google Chrome 137+ ignores --load-extension, and it
 * is the human's browser besides, so it is never picked.
 */
export function findTestChrome(): string {
  if (process.env.CAST_RIG_CHROME) return process.env.CAST_RIG_CHROME;
  const home = os.homedir();
  const candidates: string[] = [];
  const glob = (dir: string, suffix: string) => {
    try {
      for (const entry of fs.readdirSync(dir)) candidates.push(path.join(dir, entry, suffix));
    } catch {}
  };
  if (process.platform === "darwin") {
    const cft = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    glob(path.join(home, "Library/Caches/ms-playwright"), path.join("chrome-mac-arm64", cft));
    glob(path.join(home, ".cache/puppeteer/chrome"), path.join("chrome-mac-arm64", cft));
    candidates.push(
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    glob(path.join(home, ".cache/puppeteer/chrome"), path.join("chrome-linux64", "chrome"));
    candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  // Newest cache version first: chromium-1243 sorts after chromium-1208.
  const found = candidates.filter((p) => fs.existsSync(p)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!found.length) {
    throw new Error("no Chrome for Testing or Chromium found; install one with `npx playwright install chromium` (or set CAST_RIG_CHROME)");
  }
  return found[0];
}

/** A minimal flat-session CDP client over the browser socket. */
export class Cdp {
  private id = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      const p = m.id ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    };
  }
  static async connect(port: number, token?: string): Promise<Cdp> {
    const res = await fetch(`http://127.0.0.1:${port}/json/version${token ? `?token=${token}` : ""}`);
    const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}, sessionId?: string, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
    });
  }
  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

/** Wait until a Chrome's CDP HTTP port answers. */
export async function waitForCdp(cdpPort: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`Chrome never opened its CDP port ${cdpPort}`);
      await sleep(300);
    }
  }
}

/**
 * The cast extension's id, from its service worker target. Chrome runs other
 * extensions' workers too (component extensions, a second unpacked load), so
 * the cast id is preferred; any other id is returned only once the wait is
 * over, for the caller to report.
 */
export async function extensionId(cdp: Cdp, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const ids = (targetInfos as Array<{ type: string; url: string }>)
      .filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"))
      .map((t) => new URL(t.url).host);
    if (ids.includes(BRIDGE_EXTENSION_ID)) return BRIDGE_EXTENSION_ID;
    if (Date.now() > deadline) {
      if (ids.length) return ids[0];
      throw new Error("extension service worker never appeared; is this a branded Chrome 137+?");
    }
    await sleep(400);
  }
}

export interface ExtensionContext {
  cdp: Cdp;
  extId: string;
  /** The options page's target and session, for callers that drive it further. */
  targetId: string;
  sessionId: string;
  /** Evaluate an expression in the options page (a promise is awaited) and return its value. */
  eval(expression: string): Promise<any>;
  close(): Promise<void>;
}

/** Open the extension's options page in the background and return a handle to evaluate in it. */
export async function extensionContext(cdpPort: number): Promise<ExtensionContext> {
  const cdp = await Cdp.connect(cdpPort);
  const extId = await extensionId(cdp);
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/options.html`, background: true }, undefined, PAGE_OPEN_MS);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  return {
    cdp,
    extId,
    targetId,
    sessionId,
    async eval(expression) {
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ": " + JSON.stringify(r.exceptionDetails.exception?.description));
      return r.result?.value;
    },
    close: () => cdp.send("Target.closeTarget", { targetId }).then(() => undefined, () => undefined),
  };
}

export interface PairingObservation {
  href: string | null;
  hash: string | null;
  forwarded: boolean;
  offered: boolean;
  storedBeforeClick: boolean;
  stored: boolean;
}

/**
 * The product pairing path. `setup` writes a forwarding page to a 0600 file
 * and starts Chrome on the file's path, so no process argument carries the
 * token. Here the same page is opened over CDP in the scratch Chrome. A token
 * the extension does not hold yet is offered, not stored: the options page
 * waits for one click on Pair, which is the human's proof that the terminal,
 * and not some local HTML file, asked. Returns what was observed so a caller
 * can assert each half.
 */
/** `code` with `token`: setup's page, which pairs a build with codes by the code and the Store's 0.1.5 by the token. */
export async function pairExtension(ext: ExtensionContext, bridge: { port: number } & ({ code: string; token?: string } | { token: string; code?: undefined }), workDir: string): Promise<PairingObservation> {
  const { token, code, port } = bridge;
  const optionsUrl = `chrome-extension://${BRIDGE_EXTENSION_ID}/options.html`;
  const pagePath = path.join(workDir, "pair.html");
  // A one-time code is what setup sends now; a token is the pairing of an
  // older cast, kept so a rig can stand up an extension paired the old way.
  const pairingUrl = code ? bridgePairingUrl({ code, port, legacyToken: token }) : `${optionsUrl}#${new URLSearchParams({ token: token!, port: String(port) })}`;
  fs.writeFileSync(pagePath, bridgePairingPage(pairingUrl), { mode: 0o600 });
  const { targetId } = await ext.cdp.send("Target.createTarget", { url: pathToFileURL(pagePath).href, background: true }, undefined, PAGE_OPEN_MS);
  let { sessionId } = await ext.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  // The hop crosses from file: into the extension's process; a session that
  // died with the old renderer is re-attached rather than reported.
  const evalIn = async (expression: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await ext.cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId).catch(() => null);
      if (r?.result) return r.result.value;
      ({ sessionId } = await ext.cdp.send("Target.attachToTarget", { targetId, flatten: true }).catch(() => ({ sessionId })));
    }
    return undefined;
  };
  const storedNow = async () => {
    const b = await ext.eval(`chrome.storage.local.get("bridge").then((v) => v.bridge || null)`).catch(() => null);
    if (!b || b.port !== port) return false;
    // A code is stored until the worker exchanges it for the profile's key.
    // A token is gone once the worker migrated it to the profile's own key.
    return (code && (!!b.secret || (typeof b.code === "string" && b.code.length === 8))) || (!!token && b.token === token) || !!b.secret;
  };
  // Generous: on a loaded machine the file page's renderer can take most of
  // a minute to answer its first evaluate.
  const deadline = Date.now() + 60_000;
  let href: string | null = null;
  let hash: string | null = null;
  let offered = false;
  let storedBeforeClick = false;
  while (Date.now() < deadline) {
    href = (await evalIn("location.href")) ?? href;
    if (href && href.startsWith(optionsUrl)) {
      hash = await evalIn("location.hash");
      offered = (await evalIn(`!document.getElementById("pair").hidden`)) === true;
      if (hash === "" && offered) break;
    }
    await sleep(250);
  }
  const forwarded = !!href && href.startsWith(optionsUrl);
  if (offered) storedBeforeClick = await storedNow();
  // The click is an evaluate in a renderer that a loaded machine may not
  // schedule in time, and a failed evaluate reads as undefined; so it is sent
  // again while the offer is still on screen and nothing is stored.
  let stored = false;
  const storeDeadline = Date.now() + 60_000;
  while (offered && Date.now() < storeDeadline) {
    stored = await storedNow();
    if (stored) break;
    if ((await evalIn(`!document.getElementById("pair").hidden`)) === true) await evalIn(`document.getElementById("pair").click()`);
    await sleep(500);
  }
  await ext.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  fs.rmSync(pagePath, { force: true });
  return { href, hash, forwarded, offered, storedBeforeClick, stored };
}

/**
 * The by-hand pairing: write the token into the extension's storage from its
 * options page and ask the worker to reconnect. Skips the pairing page and
 * the Pair click, so it proves nothing about them; for when only a connected
 * extension matters.
 */
export async function seedExtensionToken(ext: ExtensionContext, bridge: { token: string; port: number }, timeoutMs = 60_000): Promise<boolean> {
  const expr = `chrome.storage.local.set({ bridge: { token: ${JSON.stringify(bridge.token)}, port: ${bridge.port} } })
    .then(() => chrome.runtime.sendMessage({ op: "reconnect" }).catch(() => null))
    .then(() => "seeded")`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ext.eval(expr).catch(() => null)) === "seeded") return true;
    await sleep(500);
  }
  return false;
}

/**
 * Evaluate in the scratch Chrome's own chrome://extensions page, where
 * chrome.developerPrivate and chrome.management reach every extension, the
 * disabled ones included. Opens the page in the background and closes it.
 */
export async function inExtensionsPage<T = any>(cdpPort: number, expression: string): Promise<T> {
  const cdp = await Cdp.connect(cdpPort);
  const { targetId } = await cdp.send("Target.createTarget", { url: "chrome://extensions/", background: true }, undefined, PAGE_OPEN_MS);
  try {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const deadline = Date.now() + 30_000;
    for (;;) {
      // The page's bindings appear once it has loaded; until then the evaluate throws.
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, 30_000).catch((e: Error) => ({ exceptionDetails: { text: e.message } }));
      if (!r.exceptionDetails) return r.result?.value as T;
      if (Date.now() > deadline) throw new Error(`chrome://extensions: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`.trim());
      await sleep(500);
    }
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    cdp.close();
  }
}

/**
 * Developer mode on. Chrome keeps a --load-extension extension at startup
 * without it, but disables an unpacked extension that reloads in a profile
 * without it (disable reason unsupportedDeveloperExtension), so a reload
 * would leave no extension at all. The pref cannot be seeded in a fresh
 * profile's Preferences file: Chrome drops it on first write.
 */
export async function enableDeveloperMode(cdpPort: number): Promise<void> {
  const on = await inExtensionsPage<boolean>(cdpPort, `chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })
    .then(() => chrome.developerPrivate.getProfileConfiguration()).then((c) => c.inDeveloperMode)`);
  if (!on) throw new Error("could not turn on Developer mode in the scratch Chrome");
}

export interface ExtensionInfoSummary {
  state: string;
  disableReasons: string[];
  views: string[];
  manifestErrors: string[];
  runtimeErrors: string[];
}

/** Chrome's own account of an extension: enabled or why not, what is running, what failed. */
export function extensionInfo(cdpPort: number, extId: string): Promise<ExtensionInfoSummary | null> {
  return inExtensionsPage(cdpPort, `chrome.developerPrivate.getExtensionInfo(${JSON.stringify(extId)}).then((i) => ({
    state: i.state,
    disableReasons: Object.entries(i.disableReasons).filter(([, v]) => v).map(([k]) => k),
    views: i.views.map((v) => v.type),
    manifestErrors: i.manifestErrors.map((e) => e.message),
    runtimeErrors: i.runtimeErrors.slice(-5).map((e) => e.source + ": " + e.message),
  }), () => null)`);
}

/**
 * Reload an unpacked extension from disk, the way the Reload button on
 * chrome://extensions does, re-enabling it first if a reload disabled it.
 * Returns Chrome's load error (a broken manifest, a missing file) or null.
 */
export function reloadUnpacked(cdpPort: number, extId: string): Promise<string | null> {
  const id = JSON.stringify(extId);
  return inExtensionsPage(cdpPort, `chrome.management.setEnabled(${id}, true).catch(() => {})
    .then(() => chrome.developerPrivate.reload(${id}, { failQuietly: true, populateErrorForUnpacked: true }))
    .then((err) => err ? err.error + (err.source ? " (" + err.source.highlight + ")" : "") : null)`);
}

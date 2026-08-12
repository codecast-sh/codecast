/**
 * Console and network capture.
 *
 * The shape of the problem is set by the process model: every `cast browser`
 * call is a new short-lived CLI process, while the browser lives on between
 * them. CDP's Console and Network domains only deliver events to a client that
 * was already attached when they fired, so a CLI that attaches, asks, and exits
 * would only ever see what happened during its own half second.
 *
 * So the recorder lives in the PAGE instead. A small script is installed with
 * `Page.addScriptToEvaluateOnNewDocument`, which Chrome runs before any page
 * script on every document in the target — including after navigations and in
 * new tabs. It keeps a bounded ring buffer on `window.__cast`, and reading it
 * is one `Runtime.evaluate`. That is what lets an agent navigate, act, and
 * only THEN ask what the console said, which is the order debugging actually
 * happens in.
 *
 * Buffers are bounded because a page in a render loop can log tens of thousands
 * of lines a second, and an unbounded array in the inspected page is a memory
 * leak we would be inflicting on the user's own browser.
 */

import type { PageSession } from "./instance.js";

export const RECORDER_MAX = 500;

/**
 * The in-page recorder. Written as a single expression so it can be installed
 * both as a new-document script and evaluated into an already-open page.
 *
 * It patches console, fetch and XHR, and listens for uncaught errors and
 * rejections. PerformanceObserver picks up every other resource (scripts,
 * images, stylesheets) so a broken asset shows up even though nothing in the
 * page's own code went near it.
 */
export function recorderSource(max = RECORDER_MAX): string {
  return `(() => {
  if (window.__cast && window.__cast.v === 1) return;
  const S = { v: 1, console: [], network: [], errors: [], start: Date.now() };
  window.__cast = S;
  const push = (arr, item) => { arr.push(item); if (arr.length > ${max}) arr.splice(0, arr.length - ${max}); };
  const t = () => Date.now() - S.start;
  const brief = (v) => {
    try {
      if (typeof v === "string") return v.slice(0, 800);
      if (v instanceof Error) return (v.stack || v.message).slice(0, 800);
      return JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) : x)).slice(0, 800);
    } catch { return String(v).slice(0, 300); }
  };

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      push(S.console, { t: t(), level, text: args.map(brief).join(" ") });
      orig(...args);
    };
  }

  addEventListener("error", (e) => {
    push(S.errors, { t: t(), text: (e.message || "error") + " @ " + (e.filename || "?") + ":" + (e.lineno || 0),
                     stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 1200) : null });
  });
  addEventListener("unhandledrejection", (e) => {
    push(S.errors, { t: t(), text: "unhandled rejection: " + brief(e.reason), stack: null });
  });

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (input, init) {
      const started = t();
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      const method = (init && init.method) || (input && input.method) || "GET";
      try {
        const res = await origFetch.apply(this, arguments);
        push(S.network, { t: started, ms: t() - started, method, url: String(url).slice(0, 500), status: res.status, kind: "fetch" });
        return res;
      } catch (err) {
        push(S.network, { t: started, ms: t() - started, method, url: String(url).slice(0, 500), status: 0, kind: "fetch", error: brief(err) });
        throw err;
      }
    };
  }

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__cm = m; this.__cu = u; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const started = t();
    this.addEventListener("loadend", () => {
      push(S.network, { t: started, ms: t() - started, method: this.__cm || "GET",
                        url: String(this.__cu || "").slice(0, 500), status: this.status, kind: "xhr" });
    });
    return XS.apply(this, arguments);
  };

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest") continue;
        push(S.network, { t: Math.round(e.startTime), ms: Math.round(e.duration), method: "GET",
                          url: String(e.name).slice(0, 500), status: e.responseStatus || null, kind: e.initiatorType || "resource" });
      }
    }).observe({ type: "resource", buffered: true });
  } catch {}
})()`;
}

export interface ConsoleEntry {
  t: number;
  level: string;
  text: string;
}
export interface NetworkEntry {
  t: number;
  ms: number;
  method: string;
  url: string;
  status: number | null;
  kind: string;
  error?: string;
}
export interface PageErrorEntry {
  t: number;
  text: string;
  stack: string | null;
}

export interface Recording {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  errors: PageErrorEntry[];
  /** False when the recorder was not installed before the page ran. */
  armed: boolean;
}

/**
 * Install the recorder so it runs on every future document in this target, and
 * also inject it into the document already loaded. Without the second half, an
 * agent that opens a page and only then arms the recorder sees nothing until it
 * navigates — which reads exactly like a broken feature.
 */
export async function armRecorder(page: PageSession): Promise<void> {
  const src = recorderSource();
  await page.conn.send("Page.addScriptToEvaluateOnNewDocument", { source: src }, page.sessionId).catch(() => {});
  await page.conn.send("Runtime.evaluate", { expression: src }, page.sessionId).catch(() => {});
}

export async function readRecording(page: PageSession): Promise<Recording> {
  const res = await page.conn
    .send<any>(
      "Runtime.evaluate",
      {
        expression: `JSON.stringify(window.__cast ? {console: __cast.console, network: __cast.network, errors: __cast.errors, armed: true} : {console: [], network: [], errors: [], armed: false})`,
        returnByValue: true,
      },
      page.sessionId,
    )
    .catch(() => null);
  if (!res?.result?.value) return { console: [], network: [], errors: [], armed: false };
  try {
    return JSON.parse(res.result.value) as Recording;
  } catch {
    return { console: [], network: [], errors: [], armed: false };
  }
}

export async function clearRecording(page: PageSession): Promise<void> {
  await page.conn
    .send(
      "Runtime.evaluate",
      { expression: `(() => { if (window.__cast) { __cast.console.length = 0; __cast.network.length = 0; __cast.errors.length = 0; } })()` },
      page.sessionId,
    )
    .catch(() => {});
}

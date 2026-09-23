// A raw DevTools client for one page target: the smallest thing that
// evaluates JS, listens for events and takes a screenshot. The engine's own
// `eval` verb hangs under machine load; a WebSocket to the page never has.
// After .codecast/perf/cdp.mjs, without the perf library.
import { writeFileSync } from "node:fs";

export async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json`);
  return r.json();
}

/** Open a new page target on a browser and hand back its descriptor. */
export async function newTarget(port, url = "about:blank") {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" });
  return r.json();
}

/** Connect to the page whose URL matches `match`; the first page otherwise. */
export async function connect(port, match = /localhost:3200/) {
  const targets = await listTargets(port);
  const t = targets.find((x) => x.type === "page" && match.test(x.url)) || targets.find((x) => x.type === "page");
  if (!t) throw new Error(`no page target on ${port}`);
  return connectTarget(t);
}

export async function connectTarget(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) {
      for (const l of listeners) l(m);
    }
  };
  // A page that dies (a killed browser, a navigation that drops the target)
  // answers nothing: every call still in flight fails at once, so a leg
  // reports the death instead of the whole run hanging on a promise.
  ws.onclose = () => {
    for (const { rej } of pending.values()) rej(new Error(`page gone: ${t.url}`));
    pending.clear();
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      if (ws.readyState !== WebSocket.OPEN) return rej(new Error(`page gone: ${t.url}`));
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const on = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  /** Evaluate an expression; promises are awaited, the value comes back by value. */
  const evaluate = async (expression, opts = {}) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...opts });
    if (r.exceptionDetails) {
      throw new Error("eval: " + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
    }
    return r.result.value;
  };
  /** Navigate and wait for the load event. */
  const navigate = async (url) => {
    await send("Page.enable");
    const loaded = new Promise((res) => {
      const off = on((m) => {
        if (m.method === "Page.loadEventFired") {
          off();
          res();
        }
      });
    });
    await send("Page.navigate", { url });
    await loaded;
  };
  /** A script that runs in every new document before the app does. */
  const addInitScript = (source) => send("Page.addScriptToEvaluateOnNewDocument", { source });
  /** Screenshot the viewport, or one element (a CSS selector), to a PNG file. */
  const screenshot = async (file, selector) => {
    let clip;
    if (selector) {
      const rect = await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
      );
      if (!rect) throw new Error(`screenshot: nothing matches ${selector}`);
      const pad = 12;
      clip = { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2, scale: 2 };
    }
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip } : {}) });
    writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  };
  return { ws, send, on, evaluate, navigate, addInitScript, screenshot, target: t, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

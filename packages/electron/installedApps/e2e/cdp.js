// What the installed-apps end-to-end runs share for driving a from-source
// Codecast: a DevTools protocol session on one target (a renderer, or the main
// process's Node inspector), polling, and free local ports.
const http = require("node:http");
const net = require("node:net");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves fn()'s first truthy value, polling until timeoutMs. */
async function until(what, fn, timeoutMs = 30_000, everyMs = 150) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** An HTTP server on a free local port: {server, origin}. */
function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

/**
 * A DevTools protocol session on one target. An evaluate that lands while the
 * target is between documents can go unanswered, so every command gives up
 * after a while and the caller retries.
 */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).catch((err) => {
        throw new Error(`${err.message}: ${expression.slice(0, 120)}`);
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    /**
     * Answers a consent window (apps.consent.answer). The window closes once
     * answered, sometimes before DevTools sends back the evaluate's reply, so
     * the answer runs on the page's next turn, after the reply is out.
     */
    async answerConsent(id, answer) {
      await this.eval(`setTimeout(() => window.__CODECAST_ELECTRON__.apps.consent.answer(${JSON.stringify(id)}, ${JSON.stringify(answer)}), 0); true`);
    },
    /** A PNG of the target's page. */
    async screenshot() {
      const shot = await send("Page.captureScreenshot", { format: "png" }, 20_000);
      return Buffer.from(shot.data, "base64");
    },
    close: () => ws.close(),
  };
}

module.exports = { sleep, until, freePort, listen, attach };

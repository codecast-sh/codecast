// The wire for installed apps (docs/architecture/installed-apps.md): error
// codes, reply envelopes, the macOS shims' socket, and what an Electron app
// window needs to bring the page client up.
//
// A call is `{id, module, method, args}`; it is answered with
// `{id, ok: true, value}` or `{id, ok: false, code, message}`. Host events go to
// the page as `{event, data}`.
//
// Kept free of electron so it is unit-testable (protocol.test.js).
const fs = require("node:fs");
const net = require("node:net");
const { join } = require("node:path");

const CODES = Object.freeze([
  "not-installed",
  "needs-consent",
  "denied",
  "not-allowed-by-team",
  "not-your-page",
  "mixed-version",
  "unknown-method",
  "bad-args",
  "failed",
]);

/** A refusal or failure with a protocol code; the client rethrows it with `.code`. */
class AppError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = CODES.includes(code) ? code : "failed";
  }
}

const ok = (id, value) => ({ id, ok: true, value: value === undefined ? null : value });
const fail = (id, code, message) => ({ id, ok: false, code, message: message || code });

/** The reply for anything thrown while handling a call: its own code if it carries one, else `failed`. */
function replyFor(id, err) {
  if (err instanceof AppError) return fail(id, err.code, err.message);
  return fail(id, "failed", (err && err.message) || String(err));
}

// ── Electron: the app window ──
//
// A sandboxed preload can require nothing but electron's own modules, so the
// page client cannot be loaded from a file there. It travels to the renderer
// in the window's command line instead, and appPreload.js runs it in the
// page's world at document start, ahead of the page's scripts and outside
// its CSP. It is base64, which no command line quoting splits. appPreload.js
// repeats CHANNELS and CLIENT_ARG for the same reason; protocol.test.js keeps
// the copies equal.
const CHANNELS = Object.freeze({ call: "cast-app:call", event: "cast-app:event" });
const CLIENT_ARG = "--cast-app-client=";
const CLIENT_PATH = join(__dirname, "client.js");
const PRELOAD_PATH = join(__dirname, "appPreload.js");

let clientCache = null;
/** The page client's source: what Electron injects, and what the macOS host writes into each bundle. */
function clientSource() {
  if (clientCache === null) clientCache = fs.readFileSync(CLIENT_PATH, "utf8");
  return clientCache;
}

/** webPreferences for an installed app's BrowserWindow (never the shell preload). */
function appWebPreferences(slug) {
  return {
    partition: `persist:app-${slug}`,
    preload: PRELOAD_PATH,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    additionalArguments: [CLIENT_ARG + Buffer.from(clientSource(), "utf8").toString("base64")],
  };
}

// ── macOS: the shims' socket ──
//
// `<userData>/apps.sock`, mode 0600, newline-delimited JSON both ways. A shim
// sends `{app, frame: {version, surface}, msg: {id, module, method, args}}` and
// gets the reply envelope back on its own line; the host pushes events as
// `{event, data}` lines on the same connection.
const MAX_LINE = 8 * 1024 * 1024;

/**
 * Listen on `path`. `onMessage(conn, message)` returns (a promise of) the reply
 * to write back; `onClose(conn)` runs when a shim goes away. `conn.send(obj)`
 * pushes an event. Resolves to the net.Server once listening.
 */
function serveSocket(path, { onMessage, onClose }) {
  try {
    fs.unlinkSync(path);
  } catch {}
  const server = net.createServer((socket) => {
    const conn = {
      send(obj) {
        if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`);
      },
    };
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE && !buffer.includes("\n")) return socket.destroy();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handleLine(conn, line);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => onClose && onClose(conn));
  });

  async function handleLine(conn, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return conn.send(fail(null, "bad-args", "not a JSON line"));
    }
    const id = message && message.msg ? message.msg.id : null;
    try {
      conn.send(await onMessage(conn, message));
    } catch (err) {
      conn.send(replyFor(id, err));
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      fs.chmodSync(path, 0o600);
      server.off("error", reject);
      resolve(server);
    });
  });
}

module.exports = {
  CODES,
  AppError,
  ok,
  fail,
  replyFor,
  CHANNELS,
  CLIENT_ARG,
  clientSource,
  appWebPreferences,
  serveSocket,
};

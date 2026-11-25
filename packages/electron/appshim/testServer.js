// A stand-in for the installed-apps engine on the shim's socket. It allows
// every call, so the shim's round trip can be proven without Codecast. It
// listens through the host's own socket code (installedApps/protocol.js
// serveSocket), so the framing is the real one: {app, frame: {version,
// surface}, msg: {id, module, method, args}} in, the reply envelope out, and
// {event, data} lines pushed to the shim.
//
// CLI: node testServer.js <socketPath> [logFile]
const fs = require("node:fs");
const { serveSocket, ok } = require("../installedApps/protocol");

const ALL_GRANTS = ["notifications", "menu-bar", "shortcuts", "overlay"];

/** What the stand-in answers: `info` shaped like the engine's, the request echoed for consent, null otherwise. */
function defaultAnswer({ app, frame, msg }) {
  const key = `${msg.module}.${msg.method}`;
  if (key === "app.info") {
    return ok(msg.id, {
      slug: app, name: app, version: frame?.version ?? 0, surface: frame?.surface ?? "window",
      platform: process.platform, grants: ALL_GRANTS, requested: [],
    });
  }
  if (key === "permissions.request") return ok(msg.id, msg.args?.[0] ?? []);
  return ok(msg.id, null);
}

/** Starts the stand-in. `decide(envelope)` returns the reply envelope; default allows everything. */
function startTestEngine({ socketPath, log = () => {}, decide = defaultAnswer }) {
  const calls = [];
  const conns = new Set();
  const sockets = new Set();
  const ready = serveSocket(socketPath, {
    onMessage(conn, envelope) {
      conns.add(conn);
      log(`<- ${JSON.stringify(envelope)}`);
      calls.push(envelope);
      const reply = decide(envelope);
      log(`-> ${JSON.stringify(reply)}`);
      return reply;
    },
    onClose: (conn) => conns.delete(conn),
  }).then((server) => {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    return server;
  });
  return {
    ready: ready.then(() => undefined),
    calls,
    push(event, data) {
      log(`=> ${JSON.stringify({ event, data })}`);
      for (const c of conns) c.send({ event, data });
    },
    /** Cuts every shim connection, as a Codecast restart would. */
    dropAll() {
      for (const s of sockets) s.destroy();
    },
    close: () => ready.then((server) => new Promise((resolve) => {
      server.close(() => resolve());
      server.unref();
    })),
  };
}

module.exports = { startTestEngine, defaultAnswer };

if (require.main === module) {
  const [socketPath, logFile] = process.argv.slice(2);
  if (!socketPath) {
    console.error("usage: node testServer.js <socketPath> [logFile]");
    process.exit(2);
  }
  const log = (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    if (logFile) fs.appendFileSync(logFile, stamped + "\n");
  };
  const engine = startTestEngine({ socketPath, log });
  engine.ready.then(() => log(`listening ${socketPath}`));
  const stop = () => engine.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

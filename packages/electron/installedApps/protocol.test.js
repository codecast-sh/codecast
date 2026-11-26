// Run: node --test packages/electron/installedApps/protocol.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, statSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const net = require("node:net");
const os = require("node:os");
const protocol = require("./protocol");

test("replies: refusals keep their code; anything else is failed", () => {
  assert.deepEqual(protocol.ok(1, undefined), { id: 1, ok: true, value: null });
  assert.deepEqual(protocol.replyFor(2, new protocol.AppError("denied", "no")), { id: 2, ok: false, code: "denied", message: "no" });
  assert.deepEqual(protocol.replyFor(3, new Error("EACCES")), { id: 3, ok: false, code: "failed", message: "EACCES" });
  assert.equal(new protocol.AppError("made-up").code, "failed");
});

test("appPreload.js repeats protocol.js's channels and client argument exactly", () => {
  // The sandboxed preload cannot require protocol.js, so it holds copies.
  const preload = readFileSync(join(__dirname, "appPreload.js"), "utf8");
  assert.ok(preload.includes(`const CHANNELS = { call: "${protocol.CHANNELS.call}", event: "${protocol.CHANNELS.event}" };`));
  assert.ok(preload.includes(`const CLIENT_ARG = "${protocol.CLIENT_ARG}";`));
  assert.deepEqual(preload.match(/require\(["'][^"']+["']\)/g), ['require("electron")']);
});

test("an app window is sandboxed, isolated, in its own partition, and carries the client", () => {
  const prefs = protocol.appWebPreferences("vitals");
  assert.equal(prefs.partition, "persist:app-vitals");
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.preload, join(__dirname, "appPreload.js"));
  const [arg] = prefs.additionalArguments;
  assert.ok(arg.startsWith(protocol.CLIENT_ARG));
  // A switch on a command line: nothing a shell or Windows' quoting would split.
  assert.doesNotMatch(arg, /[\s"']/);
  assert.equal(Buffer.from(arg.slice(protocol.CLIENT_ARG.length), "base64").toString("utf8"), readFileSync(join(__dirname, "client.js"), "utf8"));
  assert.ok(arg.length < 24_000, `client argument is ${arg.length} chars; Windows caps a command line at 32767`);
});

function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path, () => resolve(socket));
    socket.on("error", reject);
  });
}
function lines(socket) {
  const got = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (c) => {
    buffer += c;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      got.push(JSON.parse(buffer.slice(0, nl)));
      buffer = buffer.slice(nl + 1);
    }
  });
  return async (n) => {
    for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    return got.slice(0, n);
  };
}

// The socket is the macOS shim's channel (macHost.js); Windows apps run in
// Electron windows and never open it, and a file path is no pipe name there.
const unixSocket = { skip: process.platform === "win32" && "the macOS shim's unix socket" };

test("the shim socket: 0600, one JSON line per message, events pushed, errors answered", unixSocket, async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "cast-sock-"));
  const path = join(dir, "apps.sock");
  const closed = [];
  let connection;
  const server = await protocol.serveSocket(path, {
    onMessage: async (conn, m) => {
      connection = conn;
      if (m.msg.method === "boom") throw new protocol.AppError("needs-consent", "ask first");
      return protocol.ok(m.msg.id, { app: m.app, version: m.frame.version });
    },
    onClose: (conn) => closed.push(conn),
  });
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const socket = await connect(path);
    const read = lines(socket);
    // Two messages in one write, the second split across writes.
    socket.write(`${JSON.stringify({ app: "vitals", frame: { version: 4 }, msg: { id: 1, module: "app", method: "info", args: [] } })}\n{"app":"vitals","frame":{},`);
    socket.write(`"msg":{"id":2,"module":"app","method":"boom"}}\nnot json\n`);
    const replies = await read(3);
    assert.deepEqual(replies.find((r) => r.id === 1), { id: 1, ok: true, value: { app: "vitals", version: 4 } });
    assert.deepEqual(replies.find((r) => r.id === 2), { id: 2, ok: false, code: "needs-consent", message: "ask first" });
    assert.deepEqual(replies.find((r) => r.id === null), { id: null, ok: false, code: "bad-args", message: "not a JSON line" });
    connection.send({ event: "shortcut", data: { accelerator: "CmdOrCtrl+Shift+K" } });
    assert.deepEqual((await read(4))[3], { event: "shortcut", data: { accelerator: "CmdOrCtrl+Shift+K" } });
    socket.end();
    for (let i = 0; i < 100 && !closed.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(closed[0], connection);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shim socket replaces a stale socket file left by a crash", unixSocket, async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "cast-sock-"));
  const path = join(dir, "apps.sock");
  try {
    const first = await protocol.serveSocket(path, { onMessage: () => null });
    first.close();
    require("node:fs").writeFileSync(path, "");
    const second = await protocol.serveSocket(path, { onMessage: (c, m) => protocol.ok(m.msg.id, "up") });
    const socket = await connect(path);
    const read = lines(socket);
    socket.write(`${JSON.stringify({ app: "a", frame: {}, msg: { id: 9 } })}\n`);
    assert.deepEqual(await read(1), [{ id: 9, ok: true, value: "up" }]);
    socket.end();
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

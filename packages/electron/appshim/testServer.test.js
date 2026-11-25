// Run: node --test packages/electron/appshim/testServer.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { startTestEngine, defaultAnswer } = require("./testServer");
const { fail } = require("../installedApps/protocol");

function client(socketPath) {
  const sock = net.connect(socketPath);
  const lines = [];
  let wake = null;
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
      if (wake) wake();
    }
  });
  const next = async () => {
    while (!lines.length) await new Promise((r) => { wake = r; });
    return lines.shift();
  };
  return { send: (obj) => sock.write(JSON.stringify(obj) + "\n"), next, end: () => sock.destroy() };
}

test("the stand-in engine speaks the shim's socket framing", async () => {
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "as-")), "apps.sock");
  const engine = startTestEngine({
    socketPath,
    decide: (env) => env.msg.module === "fs" ? fail(env.msg.id, "needs-consent", "not granted") : defaultAnswer(env),
  });
  await engine.ready;
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const c = client(socketPath);
  const frame = { version: 4, surface: "tray" };
  c.send({ app: "vitals-x7", frame, msg: { id: 1, module: "app", method: "info", args: [] } });
  const info = await c.next();
  assert.equal(info.id, 1);
  assert.equal(info.ok, true);
  assert.deepEqual([info.value.slug, info.value.version, info.value.surface], ["vitals-x7", 4, "tray"]);
  c.send({ app: "vitals-x7", frame, msg: { id: 2, module: "fs", method: "readText", args: ["/etc/hosts"] } });
  assert.deepEqual(await c.next(), { id: 2, ok: false, code: "needs-consent", message: "not granted" });
  engine.push("version", { version: 5 });
  assert.deepEqual(await c.next(), { event: "version", data: { version: 5 } });
  assert.deepEqual(engine.calls.map((e) => `${e.app} ${e.msg.module}.${e.msg.method}`),
    ["vitals-x7 app.info", "vitals-x7 fs.readText"]);
  c.end();
  await engine.close();
});

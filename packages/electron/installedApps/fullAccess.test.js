// Run: node --test packages/electron/installedApps/fullAccess.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const { createFullAccess, resolvePath } = require("./fullAccess");

const node = process.execPath;
const tmp = () => mkdtempSync(join(os.tmpdir(), "cast-app-full-"));

test("paths: ~ expands to home and relative paths are refused", () => {
  assert.equal(resolvePath("~"), os.homedir());
  assert.equal(resolvePath("~/notes.md"), join(os.homedir(), "notes.md"));
  assert.throws(() => resolvePath("notes.md"), (e) => e.code === "bad-args");
});

test("files: write, read, list, stat and remove", async () => {
  const dir = tmp();
  try {
    const ops = createFullAccess();
    mkdirSync(join(dir, "sub"));
    await ops["fs.writeText"](join(dir, "a.txt"), "héllo");
    assert.equal(await ops["fs.readText"](join(dir, "a.txt")), "héllo");
    assert.deepEqual(
      (await ops["fs.list"](dir)).sort((a, b) => a.name.localeCompare(b.name)),
      [{ name: "a.txt", type: "file" }, { name: "sub", type: "dir" }],
    );
    const s = await ops["fs.stat"](join(dir, "a.txt"));
    assert.equal(s.type, "file");
    assert.equal(s.size, Buffer.byteLength("héllo"));
    await ops["fs.remove"](join(dir, "sub"));
    assert.equal(existsSync(join(dir, "sub")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files: a read past the cap fails", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "big.txt"), "x".repeat(2048));
    const ops = createFullAccess({ maxReadBytes: 1024 });
    await assert.rejects(ops["fs.readText"](join(dir, "big.txt")), (e) => e.code === "failed" && /larger than the 1024 byte limit/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files: a file whose stat size lies is still capped", { skip: process.platform === "win32" }, async () => {
  const ops = createFullAccess({ maxReadBytes: 1024 });
  // /dev/zero is a character device: refused before any read.
  await assert.rejects(ops["fs.readText"]("/dev/zero"), (e) => e.code === "failed" && /not a regular file/.test(e.message));
});

test("files: a FIFO is refused instead of blocking", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  try {
    const fifo = join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    const ops = createFullAccess();
    await assert.rejects(ops["fs.readText"](fifo), (e) => e.code === "failed" && /not a regular file/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watches: capped per app and closed by unwatchAll", () => {
  const dir = tmp();
  try {
    const ops = createFullAccess({ maxWatches: 2 });
    ops.watch("a", dir, () => {});
    ops.watch("a", dir, () => {});
    assert.throws(() => ops.watch("a", dir, () => {}), (e) => e.code === "failed" && /at most 2/.test(e.message));
    ops.watch("b", dir, () => {});
    ops.unwatchAll("a");
    ops.watch("a", dir, () => {});
    ops.unwatchAll("a");
    ops.unwatchAll("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("process: exit code, stdout, stderr, cwd and env", async () => {
  const dir = tmp();
  try {
    const ops = createFullAccess();
    const script = "process.stdout.write(process.cwd() + '|' + process.env.CAST_X); process.stderr.write('warn'); process.exit(3)";
    const r = await ops["process.run"](node, ["-e", script], { cwd: dir, env: { CAST_X: "yes" } });
    assert.equal(r.code, 3);
    assert.equal(r.stdout.split("|")[1], "yes");
    assert.ok(r.stdout.split("|")[0].endsWith(dir.split("/").pop()));
    assert.equal(r.stderr, "warn");
    assert.equal(r.timedOut, false);
    assert.equal(r.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("process: killed at the timeout", async () => {
  const ops = createFullAccess();
  const started = Date.now();
  const r = await ops["process.run"](node, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, "SIGKILL");
  assert.ok(Date.now() - started < 5000);
});

test("process: the timeout resolves even when a grandchild holds the pipes", { skip: process.platform === "win32" }, async () => {
  const ops = createFullAccess();
  const started = Date.now();
  const r = await ops["process.run"]("/bin/sh", ["-c", "sleep 7.31 & sleep 7.31"], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  // The background sleep was in the killed group too. The pattern is bracketed
  // so it never matches a command line that names it (a shell running pgrep).
  assert.equal(execFileSync("/bin/sh", ["-c", "pgrep -f 'sleep 7[.]31' || true"]).toString().trim(), "");
});

test("process: the timeout never exceeds the cap", async () => {
  const ops = createFullAccess({ maxTimeoutMs: 200 });
  const r = await ops["process.run"](node, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 60_000 });
  assert.equal(r.timedOut, true);
});

test("process: output past the cap is dropped and flagged", async () => {
  const ops = createFullAccess({ maxOutputBytes: 1000 });
  const r = await ops["process.run"](node, ["-e", "process.stdout.write('y'.repeat(100000))"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "y".repeat(1000));
  assert.equal(r.truncated, true);
});

test("process: a missing program is failed", async () => {
  const ops = createFullAccess();
  await assert.rejects(ops["process.run"]("/no/such/program", []), (e) => e.code === "failed" && /ENOENT/.test(e.message));
});

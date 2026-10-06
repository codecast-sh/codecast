// Run: node --test packages/electron/daemonSetup.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDaemonSetup } = require("./daemonSetup");

const HOME = "/Users/new";
const on = (...paths) => (p) => paths.includes(p);

test("a fresh Mac has neither the CLI nor a sign-in", () => {
  const s = createDaemonSetup({ exists: on(), home: HOME, platform: "darwin", env: {} }).state();
  assert.deepEqual(s, { supported: true, installed: false, linked: false, running: false });
});

test("an installed, linked machine reports both", () => {
  const s = createDaemonSetup({ exists: on(`${HOME}/.local/bin/cast`, `${HOME}/.codecast/config.json`), home: HOME, platform: "darwin", env: {} }).state();
  assert.equal(s.installed, true);
  assert.equal(s.linked, true);
});

test("setup runs the installer once with the token and reports success", async () => {
  const tokens = [];
  const setup = createDaemonSetup({ run: async (t) => { tokens.push(t); return { code: 0, tail: "" }; }, exists: on(), home: HOME, platform: "darwin", env: {} });
  const [a, b] = await Promise.all([setup.setup("tok_abcdefgh"), setup.setup("tok_abcdefgh")]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: true });
  assert.deepEqual(tokens, ["tok_abcdefgh"]);
  assert.equal(setup.state().running, false);
});

test("a failing installer returns its last output", async () => {
  const setup = createDaemonSetup({ run: async () => ({ code: 1, tail: "curl: (6) Could not resolve host" }), exists: on(), home: HOME, platform: "darwin", env: {} });
  assert.deepEqual(await setup.setup("tok_abcdefgh"), { ok: false, error: "installer_failed", detail: "curl: (6) Could not resolve host" });
});

test("a token that is not a token never reaches the installer", async () => {
  let ran = false;
  const setup = createDaemonSetup({ run: async () => { ran = true; return { code: 0, tail: "" }; }, exists: on(), home: HOME, platform: "darwin", env: {} });
  for (const bad of ["", "short", "tok; rm -rf ~", "$(whoami)aaaaaaaa", null, undefined]) {
    assert.deepEqual(await setup.setup(bad), { ok: false, error: "invalid_token" });
  }
  assert.equal(ran, false);
});

test("Windows is refused: the daemon runs inside WSL there", async () => {
  const setup = createDaemonSetup({ run: async () => ({ code: 0, tail: "" }), exists: on(), home: HOME, platform: "win32", env: {} });
  assert.equal(setup.state().supported, false);
  assert.deepEqual(await setup.setup("tok_abcdefgh"), { ok: false, error: "unsupported_platform" });
});

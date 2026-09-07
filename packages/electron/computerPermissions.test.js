// Run: node --test packages/electron/computerPermissions.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  COMPUTER_KINDS,
  resolveCli,
  statusToReadiness,
  createComputerPermissions,
} = require("./computerPermissions");

// A CLI that answers with whatever the test hands it, and records every argv
// it was given.
function fakeCli(answers) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const answer = answers.shift();
    return typeof answer === "function" ? answer(args) : (answer ?? null);
  };
  return { run, calls };
}

const GRANTED = {
  ok: true,
  platform: "darwin",
  permissions: [
    { id: "accessibility", status: "granted" },
    { id: "screenshots", status: "granted" },
  ],
};

test("the CLI's grant vocabulary maps onto readiness", () => {
  assert.equal(statusToReadiness("granted"), "granted");
  // Never asked and denied are the same row to the human: only System
  // Settings turns it on, so both offer that button.
  assert.equal(statusToReadiness("not-granted"), "off");
  assert.equal(statusToReadiness("unsupported"), "n/a");
  assert.equal(statusToReadiness(undefined), "unknown");
  assert.equal(statusToReadiness("something-else"), "unknown");
});

test("both grants read from one CLI call", async () => {
  const cli = fakeCli([
    {
      ok: true,
      permissions: [
        { id: "accessibility", status: "granted" },
        { id: "screenshots", status: "not-granted" },
      ],
    },
  ]);
  const p = createComputerPermissions({ run: cli.run, platform: "darwin" });
  assert.deepEqual(await p.getAll(), { computerAccessibility: "granted", computerScreen: "off" });
  assert.deepEqual(cli.calls, [["computer", "permissions", "--json"]]);
});

test("the read never opens anything", async () => {
  const cli = fakeCli([GRANTED]);
  const p = createComputerPermissions({ run: cli.run, platform: "darwin" });
  await p.getAll();
  // --open-settings is the one flag that takes the screen, and a status read
  // is what an agent's recovery loop runs on the machine a human is using.
  for (const args of cli.calls) assert.ok(!args.includes("--open-settings"));
});

test("a CLI that cannot answer reads as unknown, so nothing nags", async () => {
  for (const answer of [null, { ok: false, code: "accessibility_error" }, { ok: true }]) {
    const cli = fakeCli([answer]);
    const p = createComputerPermissions({ run: cli.run, platform: "darwin" });
    assert.deepEqual(await p.getAll(), { computerAccessibility: "unknown", computerScreen: "unknown" });
  }
});

test("a grant missing from the answer reads as unknown rather than denied", async () => {
  const cli = fakeCli([{ ok: true, permissions: [{ id: "accessibility", status: "granted" }] }]);
  const p = createComputerPermissions({ run: cli.run, platform: "darwin" });
  assert.deepEqual(await p.getAll(), { computerAccessibility: "granted", computerScreen: "unknown" });
});

test("off macOS there is no such grant, and no CLI is run", async () => {
  const cli = fakeCli([GRANTED]);
  const p = createComputerPermissions({ run: cli.run, platform: "win32" });
  assert.deepEqual(await p.getAll(), { computerAccessibility: "n/a", computerScreen: "n/a" });
  assert.equal(await p.openSettings("computerAccessibility"), false);
  assert.deepEqual(cli.calls, []);
});

test("opening settings materializes the helper first, then opens its pane", async () => {
  const cli = fakeCli([{ ok: true }, { ok: true, launchedHelper: true }]);
  const p = createComputerPermissions({ run: cli.run, platform: "darwin" });
  assert.equal(await p.openSettings("computerScreen"), true);
  assert.deepEqual(cli.calls, [
    // `capabilities` is the CLI's own materialization path; with no helper on
    // disk there is no window for --open-settings to put on screen.
    ["computer", "capabilities", "--json"],
    ["computer", "permissions", "--open-settings", "--id", "screenshots", "--json"],
  ]);
});

test("each kind opens its own pane", async () => {
  const cli = fakeCli([{ ok: true }, { ok: true }]);
  const p = createComputerPermissions({ run: cli.run, platform: "darwin" });
  await p.openSettings("computerAccessibility");
  assert.deepEqual(cli.calls[1], ["computer", "permissions", "--open-settings", "--id", "accessibility", "--json"]);
});

test("a refused open is reported, not swallowed as success", async () => {
  const cli = fakeCli([{ ok: true }, { ok: false, code: "accessibility_error" }]);
  const p = createComputerPermissions({ run: cli.run, platform: "darwin" });
  assert.equal(await p.openSettings("computerAccessibility"), false);
});

test("a kind this module does not own is left to the shell's own permissions", async () => {
  const cli = fakeCli([]);
  const p = createComputerPermissions({ run: cli.run, platform: "darwin" });
  assert.deepEqual(COMPUTER_KINDS, ["computerAccessibility", "computerScreen"]);
  for (const kind of COMPUTER_KINDS) assert.ok(p.owns(kind));
  for (const kind of ["microphone", "camera", "screen", "notifications"]) assert.ok(!p.owns(kind));
  assert.equal(await p.openSettings("screen"), false);
  assert.deepEqual(cli.calls, []);
});

test("the CLI is found where it installs itself, and an override wins", () => {
  const home = "/Users/x";
  assert.equal(resolveCli({ env: { CODECAST_CLI: "/tmp/cast" }, home, exists: () => true }), "/tmp/cast");
  assert.equal(resolveCli({ env: {}, home, exists: (p) => p === "/Users/x/.local/bin/cast" }), "/Users/x/.local/bin/cast");
  assert.equal(resolveCli({ env: {}, home, exists: (p) => p === "/opt/homebrew/bin/cast" }), "/opt/homebrew/bin/cast");
  // The shell is launched from Finder, whose PATH holds none of these — a bare
  // command is the last resort, and its failure reads as unknown.
  assert.equal(resolveCli({ env: {}, home, exists: () => false }), "cast");
});

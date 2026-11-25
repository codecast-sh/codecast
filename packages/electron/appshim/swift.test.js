// Run: node --test packages/electron/appshim/swift.test.js
// Compiles each Swift unit under Tests/<name>/main.swift with the sources it
// covers and runs it; the program exits nonzero and prints FAIL lines on a failure.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const hasSwift = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;

function runSwiftUnit(name, sources) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `appshim-${name}-`)), name);
  const build = spawnSync("xcrun", ["swiftc", "-swift-version", "5", "-o", out,
    ...sources.map((s) => path.join(__dirname, "Sources", s)), path.join(__dirname, "Tests", name, "main.swift")],
  { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(out, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^ok/m);
}

const opts = { skip: !hasSwift, timeout: 120_000 };
test("accelerators parse into Carbon key codes and modifiers", opts, () => runSwiftUnit("accelerator", ["Accelerator.swift"]));
test("navigation stays under the page, the opener takes only http, https and mailto, the bridge answers only the page's main frame",
  opts, () => runSwiftUnit("policy", ["UrlPolicy.swift"]));
test("the user agent suffix, the notification settings link and what each Codecast state shows",
  opts, () => runSwiftUnit("hoststate", ["HostState.swift"]));

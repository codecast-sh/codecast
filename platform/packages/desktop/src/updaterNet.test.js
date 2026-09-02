// bun test entry for the updaterNet suite. The real tests live in
// updaterNetSuite.node.js and run under Node (see the note there); this
// wrapper fails with Node's output when any of them fails.
const { test, expect } = require("bun:test");
const { spawnSync } = require("child_process");
const path = require("path");

test("updaterNet: resume, hash, truncation, abort, inactivity (node --test)", () => {
  const file = path.join(__dirname, "updaterNetSuite.node.js");
  const r = spawnSync("node", ["--test", file], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) console.error(r.stdout + r.stderr);
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/# pass 6/);
  expect(r.stdout).toMatch(/# fail 0/);
}, 120_000);

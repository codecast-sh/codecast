// Run: node --test packages/electron/installedApps/tiers.test.js
//
// tiers.json is generated from shared/contracts/pageApp.ts by genTiers.ts; a
// hand edit to either side that the other does not follow fails here.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

test("tiers.json is what genTiers.ts writes from the contract", () => {
  const out = spawnSync("bun", [join(__dirname, "genTiers.ts"), "--check"], { encoding: "utf8" });
  assert.equal(out.error, undefined, `bun is needed to run the generator: ${out.error && out.error.message}`);
  assert.equal(out.status, 0, out.stderr || out.stdout);
});

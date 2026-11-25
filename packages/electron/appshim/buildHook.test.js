// Run: node --test packages/electron/appshim/buildHook.test.js
// The electron-builder beforePack hook builds the shim for a macOS pack and
// does nothing for any other platform.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const beforePack = require("../scripts/build-appshim");

test("a Windows pack skips the shim", async () => {
  const before = fs.existsSync(beforePack.BINARY) ? fs.statSync(beforePack.BINARY).mtimeMs : null;
  await beforePack({ electronPlatformName: "win32" });
  assert.equal(fs.existsSync(beforePack.BINARY) ? fs.statSync(beforePack.BINARY).mtimeMs : null, before);
});

test("a macOS pack leaves a universal shim where extraResources reads it", { skip: process.platform !== "darwin", timeout: 240_000 }, async () => {
  await beforePack({ electronPlatformName: "darwin" });
  assert.deepEqual(execFileSync("lipo", ["-archs", beforePack.BINARY]).toString().trim().split(/\s+/).sort(), ["arm64", "x86_64"]);
});

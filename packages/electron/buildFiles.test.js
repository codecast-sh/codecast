// Run: node --test packages/electron/buildFiles.test.js
//
// Every local module the shell requires must be in the packaged build.
//
// electron-builder ships an ALLOWLIST (`build.files`), so a new file beside
// main.js runs perfectly from source and is simply absent from the .app. The
// failure is not subtle and not recoverable: the packaged app dies at boot with
// "Cannot find module './x'" before it draws anything, and there is no build
// step that would have caught it — from-source verification passes.
//
// It has happened twice already (callWindowPolicy.js and meetingDetector.js
// both landed missing), which is why this is a test and not a comment.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const HERE = __dirname;
const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));

// `require("./x")` and `require("./x.js")` → "x.js".
function localRequires(file) {
  const src = readFileSync(join(HERE, file), "utf8");
  const out = new Set();
  for (const m of src.matchAll(/require\(["']\.\/([^"']+)["']\)/g)) {
    out.add(m[1].endsWith(".js") ? m[1] : `${m[1]}.js`);
  }
  return [...out].sort();
}

test("every local module main.js and preload.js require is packaged", () => {
  const allowed = new Set(pkg.build.files);
  const missing = [];
  for (const entry of ["main.js", "preload.js"]) {
    for (const dep of localRequires(entry)) {
      if (!allowed.has(dep)) missing.push(`${entry} requires ./${dep}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Add these to build.files in packages/electron/package.json, or the packaged app crashes at boot:\n  ${missing.join("\n  ")}`,
  );
});

test("the entry points themselves are packaged", () => {
  const allowed = new Set(pkg.build.files);
  assert.ok(allowed.has("main.js"));
  assert.ok(allowed.has("preload.js"));
});

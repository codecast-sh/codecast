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

// `require("./x")` and `require("./x.js")` → "x.js"; a native addon keeps
// its own extension (`require("./native/x.node")` → "native/x.node").
function localRequires(file) {
  const src = readFileSync(join(HERE, file), "utf8");
  const out = new Set();
  for (const m of src.matchAll(/require\(["']\.\/([^"']+)["']\)/g)) {
    out.add(/\.(js|node)$/.test(m[1]) ? m[1] : `${m[1]}.js`);
  }
  return [...out].sort();
}

// Every local module reachable from the entry points, following requires
// through the modules themselves (osPermissions.js is what loads the addon).
function reachableRequires(entries) {
  const seen = new Map();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const deps = file.endsWith(".js") ? localRequires(file) : [];
    seen.set(file, deps);
    queue.push(...deps);
  }
  return seen;
}

test("every local module reachable from main.js and preload.js is packaged", () => {
  const allowed = new Set(pkg.build.files);
  const missing = [];
  for (const [file, deps] of reachableRequires(["main.js", "preload.js"])) {
    for (const dep of deps) {
      if (!allowed.has(dep)) missing.push(`${file} requires ./${dep}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Add these to build.files in packages/electron/package.json, or the packaged app crashes at boot:\n  ${missing.join("\n  ")}`,
  );
});

test("native addons are unpacked from the asar", () => {
  // A .node inside the asar can't be dlopen'd; electron-builder must leave it
  // on disk (app.asar.unpacked) for require() to reach it.
  const natives = pkg.build.files.filter((f) => f.endsWith(".node"));
  assert.ok(natives.length > 0, "the notifications addon is packaged");
  for (const f of natives) {
    const unpacked = (pkg.build.asarUnpack ?? []).some((glob) =>
      new RegExp(`^${glob.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`).test(f),
    );
    assert.ok(unpacked, `${f} is not matched by build.asarUnpack`);
  }
});

test("the entry points themselves are packaged", () => {
  const allowed = new Set(pkg.build.files);
  assert.ok(allowed.has("main.js"));
  assert.ok(allowed.has("preload.js"));
});

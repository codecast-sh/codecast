// Vite plugin: publish the release manifest the desktop shell's offline copy
// reads (src/webCache.js). After the build it walks the output directory and
// writes `release.json` next to index.html:
//
//   { release, commit, builtAt, files: { "index.html": "<sha256>", … } }
//
// `release` is a hash over every file's path and content, so any change to
// the site produces a new id and a byte-identical rebuild keeps the old one.
// `commit` is git HEAD (or RELEASE_COMMIT), informational.
//
//   import { releaseManifest } from "@platform/desktop/vite";
//   export default defineConfig({ plugins: [react(), releaseManifest()] });

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { releaseIdFor, sha256 } = require("../src/webCache");

function walk(root, rel = "", out = []) {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, p, out);
    else out.push(p);
  }
  return out;
}

function gitHead(cwd) {
  if (process.env.RELEASE_COMMIT) return process.env.RELEASE_COMMIT;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

// Build the manifest for a directory. Exported so a packager can produce the
// same file for a seed copy, and so it can be tested without Vite.
function buildManifest(outDir, { fileName = "release.json", commit } = {}) {
  const files = {};
  for (const f of walk(outDir).sort()) {
    if (f === fileName) continue;
    files[f] = sha256(fs.readFileSync(path.join(outDir, f)));
  }
  if (!files["index.html"]) throw new Error(`release manifest: no index.html in ${outDir}`);
  return {
    release: releaseIdFor(files),
    commit: commit === undefined ? gitHead(outDir) : commit,
    builtAt: new Date().toISOString(),
    files,
  };
}

function writeManifest(outDir, opts = {}) {
  const manifest = buildManifest(outDir, opts);
  fs.writeFileSync(path.join(outDir, opts.fileName || "release.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function releaseManifest(opts = {}) {
  let outDir = null;
  return {
    name: "platform-desktop-release-manifest",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!outDir || !fs.existsSync(path.join(outDir, "index.html"))) return;
      const m = writeManifest(outDir, opts);
      console.log(`release.json: ${m.release} (${Object.keys(m.files).length} files)`);
    },
  };
}

module.exports = { releaseManifest, buildManifest, writeManifest };

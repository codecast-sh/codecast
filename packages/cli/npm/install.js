#!/usr/bin/env node
// Downloads the compiled codecast binary for this platform from the GitHub
// release matching this package's version, verifies its SHA-256 against
// checksums.json (baked in at publish time), and places it in vendor/.
// The same binary serves every install channel (curl, brew, npm), and it
// keeps itself up to date after this first download.
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const pkg = require("./package.json");
const checksums = require("./checksums.json");

const REPO = "codecast-sh/codecast";

// codecast runs inside WSL on Windows. A global npm install on Windows
// writes a POSIX `cast` launcher next to cast.cmd, and WSL puts the Windows
// PATH on its own, so that launcher shadows the real Linux install and fails
// with "node: not found". The refusal runs in preinstall: npm writes the
// launchers before postinstall, and a failed postinstall leaves them behind
// pointing at nothing.
const WINDOWS_MESSAGE =
  "codecast does not install through npm on Windows. It runs inside WSL.\n" +
  "In PowerShell, run:\n" +
  "  irm codecast.sh/install.ps1 | iex\n" +
  "That sets up WSL if needed and installs codecast inside it.";

function platformKey() {
  const platform = { darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (!platform || !arch) return null;
  return `${platform}-${arch}`;
}

function binaryPath() {
  return path.join(__dirname, "vendor", "codecast");
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    https
      .get(url, { headers: { "user-agent": `codecast-npm/${pkg.version}` } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(resolve));
        out.on("error", reject);
      })
      .on("error", reject);
  });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function install() {
  const key = platformKey();
  if (!key) {
    console.error(`codecast: unsupported platform ${process.platform}-${process.arch}`);
    process.exit(1);
  }
  const expected = checksums[key];
  if (!expected) {
    console.error(`codecast: no checksum for ${key} in this package`);
    process.exit(1);
  }

  const dest = binaryPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  const url = `https://github.com/${REPO}/releases/download/v${pkg.version}/codecast-${key}`;

  await download(url, tmp);

  const actual = sha256(tmp);
  if (actual !== expected) {
    fs.rmSync(tmp, { force: true });
    // A bad checksum is never acceptable: fail the install loudly.
    console.error(`codecast: checksum mismatch for ${key}`);
    console.error(`  expected ${expected}`);
    console.error(`  got      ${actual}`);
    process.exit(1);
  }

  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

if (require.main === module) {
  if (process.platform === "win32") {
    console.error(WINDOWS_MESSAGE);
    process.exit(1);
  }
  if (process.argv.includes("--check-platform")) process.exit(0);
  install().catch((err) => {
    // Network trouble at install time is survivable — the launcher retries
    // the download on first run. Don't fail the whole `npm install` for it.
    console.warn(`codecast: could not download binary (${err.message})`);
    console.warn("codecast: will retry on first run");
  });
}

module.exports = { install, binaryPath, WINDOWS_MESSAGE };

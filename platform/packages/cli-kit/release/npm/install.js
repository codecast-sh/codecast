#!/usr/bin/env node
// Downloads the compiled binary for this platform from the GitHub release
// matching this package's version, verifies its SHA-256 against checksums.json
// (written by upload-binaries.sh at publish time), and places it in vendor/.
// The same binary serves every install channel (curl, brew, npm), and it keeps
// itself up to date after this first download.
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const pkg = require("./package.json");
const checksums = require("./checksums.json");

// Rename these three for a new product.
const REPO = "acme-org/acme";
const BINARY_NAME = "acme";
const USER_AGENT = `${BINARY_NAME}-npm/${pkg.version}`;

function platformKey() {
  const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  // Windows on ARM runs x64 binaries under emulation; no native arm64 build.
  const arch = process.platform === "win32" ? "x64" : { arm64: "arm64", x64: "x64" }[process.arch];
  if (!platform || !arch) return null;
  return `${platform}-${arch}`;
}

function assetName(key) {
  return key.startsWith("windows") ? `${BINARY_NAME}-${key}.exe` : `${BINARY_NAME}-${key}`;
}

function binaryPath() {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(__dirname, "vendor", `${BINARY_NAME}${ext}`);
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    https
      .get(url, { headers: { "user-agent": USER_AGENT } }, (res) => {
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
    console.error(`${BINARY_NAME}: unsupported platform ${process.platform}-${process.arch}`);
    process.exit(1);
  }
  const expected = checksums[key];
  if (!expected) {
    console.error(`${BINARY_NAME}: no checksum for ${key} in this package`);
    process.exit(1);
  }
  const dest = binaryPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  const url = `https://github.com/${REPO}/releases/download/v${pkg.version}/${assetName(key)}`;
  await download(url, tmp);
  const actual = sha256(tmp);
  if (actual !== expected) {
    fs.rmSync(tmp, { force: true });
    // A bad checksum is never acceptable: fail loudly.
    console.error(`${BINARY_NAME}: checksum mismatch for ${key}`);
    console.error(`  expected ${expected}`);
    console.error(`  got      ${actual}`);
    process.exit(1);
  }
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

if (require.main === module) {
  install().catch((err) => {
    // Network trouble at install time is survivable: the launcher retries the
    // download on first run. Do not fail the whole npm install for it.
    console.warn(`${BINARY_NAME}: could not download binary (${err.message})`);
    console.warn(`${BINARY_NAME}: will retry on first run`);
  });
}

module.exports = { install, binaryPath };

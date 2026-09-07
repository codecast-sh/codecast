#!/usr/bin/env bun
/**
 * Cut a Chrome Web Store release of the extension.
 *
 *   bun packages/browser-extension/release.mjs                # bump patch, build the zip, print it
 *   bun packages/browser-extension/release.mjs --upload       # ...and upload it to the store as a draft
 *   bun packages/browser-extension/release.mjs --upload --publish   # ...and submit it for review
 *   --bump patch|minor|major   which part of manifest.json's version moves (default patch)
 *   --version X.Y.Z            set it outright instead
 *   --dry-run                  build the zip for the next version, write nothing back, upload nothing
 *
 * The zip is the extension directory minus the development-only files, with
 * two edits to manifest.json: the new version, and no `key`. The store signs
 * every package with the key pair it generated on the first upload and
 * derives the extension ID from that, so the committed key is for unpacked
 * development loads only (it is the store's public key, so both loads share
 * one ID; see README "The extension ID is stable").
 *
 * Store credentials come from the environment, never from arguments:
 * CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN (an OAuth client on the
 * store owner's Google Cloud project plus a refresh token minted for it with
 * the chromewebstore scope), CWS_PUBLISHER_ID and CWS_ITEM_ID (both from the
 * developer dashboard). Every upload goes through store review before it
 * reaches anyone; installs update themselves once it passes.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const extDir = path.dirname(new URL(import.meta.url).pathname);
const manifestPath = path.join(extDir, "manifest.json");

/** What ships. Everything else in the directory is for developing it. */
const SHIPPED = ["background.js", "options.html", "options.js", "popup.html", "popup.js", "status.js", "brand.css", "icons"];

const API = "https://chromewebstore.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

function parseArgs(argv) {
  const o = { bump: "patch", version: null, upload: false, publish: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bump") o.bump = argv[++i];
    else if (a === "--version") o.version = argv[++i];
    else if (a === "--upload") o.upload = true;
    else if (a === "--publish") o.publish = true;
    else if (a === "--dry-run") o.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!["patch", "minor", "major"].includes(o.bump)) throw new Error(`--bump takes patch, minor or major, not ${o.bump}`);
  if (o.version && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(o.version)) throw new Error(`--version must be X.Y.Z, not ${o.version}`);
  if (o.publish && !o.upload) throw new Error("--publish needs --upload");
  if (o.dryRun && o.upload) throw new Error("--dry-run uploads nothing; drop --upload");
  return o;
}

export function nextVersion(current, bump) {
  const [major, minor, patch] = current.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The store's own limits, checked before an upload rather than learned from its rejection. */
const STORE_LIMITS = { name: 75, description: 132 };

/** The manifest as the store receives it: this version, no development key. */
export function storeManifest(manifest, version) {
  const { key: _key, ...rest } = manifest;
  for (const [field, max] of Object.entries(STORE_LIMITS)) {
    const len = String(rest[field] ?? "").length;
    if (len > max) throw new Error(`manifest ${field} is ${len} characters; the Chrome Web Store allows ${max}`);
  }
  return { ...rest, version };
}

/** Stage the shipped files with the store manifest and zip them. Returns the zip path. */
export function buildZip(version, outDir) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-extension-"));
  for (const name of SHIPPED) {
    const src = path.join(extDir, name);
    if (!fs.existsSync(src)) throw new Error(`shipped file missing: ${name}`);
    fs.cpSync(src, path.join(stage, name), { recursive: true });
  }
  fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(storeManifest(manifest, version), null, 2) + "\n");
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `codecast-extension-${version}.zip`);
  fs.rmSync(zipPath, { force: true });
  // -X drops the extra file attributes; -D drops directory entries; both keep the archive reproducible across hosts.
  execFileSync("zip", ["-q", "-r", "-X", "-D", zipPath, "."], { cwd: stage, stdio: "inherit" });
  fs.rmSync(stage, { recursive: true, force: true });
  return zipPath;
}

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`missing store credentials in the environment: ${missing.join(", ")}`);
  return Object.fromEntries(names.map((n) => [n, process.env[n]]));
}

async function accessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.CWS_CLIENT_ID,
      client_secret: env.CWS_CLIENT_SECRET,
      refresh_token: env.CWS_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`token refresh failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  if (body.scope && !body.scope.includes(SCOPE)) throw new Error(`the refresh token lacks the ${SCOPE} scope (has: ${body.scope})`);
  return body.access_token;
}

async function storeCall(token, method, url, body, contentType) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(contentType ? { "content-type": contentType } : {}) },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  return json;
}

async function upload(zipPath, publish) {
  const env = requireEnv(["CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN", "CWS_PUBLISHER_ID", "CWS_ITEM_ID"]);
  const token = await accessToken(env);
  const item = `${API}/v2/publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_ITEM_ID}`;
  const uploaded = await storeCall(token, "POST", `${API}/upload/v2/publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_ITEM_ID}:upload`, fs.readFileSync(zipPath), "application/zip");
  console.log(`uploaded: ${JSON.stringify(uploaded)}`);
  // A large package is processed after the request returns; wait for the store to accept it before publishing.
  const deadline = Date.now() + 5 * 60_000;
  let status = uploaded;
  while (JSON.stringify(status).includes("IN_PROGRESS") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    status = await storeCall(token, "GET", `${item}:fetchStatus`);
    console.log(`status: ${JSON.stringify(status)}`);
  }
  if (JSON.stringify(status).includes("IN_PROGRESS")) throw new Error("the store is still processing the upload; run again with --publish only once it settles");
  if (/FAIL|ERROR|INVALID/.test(JSON.stringify(status).toUpperCase())) throw new Error(`the store rejected the package: ${JSON.stringify(status)}`);
  if (!publish) {
    console.log("draft uploaded; publish from the dashboard or run again with --upload --publish");
    return;
  }
  const published = await storeCall(token, "POST", `${item}:publish`);
  console.log(`submitted for review: ${JSON.stringify(published)}`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const version = o.version ?? nextVersion(manifest.version, o.bump);
  const zipPath = buildZip(version, path.join(extDir, "dist"));
  const bytes = fs.readFileSync(zipPath);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  console.log(`codecast extension ${manifest.version} → ${version}`);
  console.log(`zip: ${zipPath} (${bytes.length} bytes, sha256 ${sha})`);
  execFileSync("unzip", ["-l", zipPath], { stdio: "inherit" });
  if (o.dryRun) {
    console.log("dry run: manifest.json unchanged, nothing uploaded");
    return;
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  console.log(`manifest.json now says ${version}; commit it with the release`);
  if (o.upload) await upload(zipPath, o.publish);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`release failed: ${err.message}`);
    process.exit(1);
  });
}

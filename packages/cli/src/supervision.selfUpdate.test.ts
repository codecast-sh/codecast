// The binary watchdog's self-update fallback, executed: the real script runs
// once against a scratch HOME with curl, uname, codesign and the installed
// binary replaced by stubs. A release it installs must be the one latest.json
// names, by checksum, and ours, by a pinned manifest signature or (darwin) our
// Apple team's code signature. Anything less is refused and nothing changes.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicKeyToBase64, signManifest } from "@platform/cli-kit/update";
import { DARWIN_SIGNING_TEAM, RELEASE_BASE_URL, RELEASE_MANIFEST_SIGNING } from "./releaseTrust.js";
import { buildWatchdogShellScript, shellEscapeForSh } from "./supervision.js";
import { VERSION_FLOOR_SH } from "./releaseTrust.js";
import { cmpVersions } from "../../electron/updatePolicy.js";

// run_pass polls each pass once a second, so one fallback run takes a few seconds.
setDefaultTimeout(30_000);

const KEY = generateKeyPairSync("ed25519");
const TEST_PUB = publicKeyToBase64(KEY.publicKey);
const [PINNED_ID, PINNED_PUB] = Object.entries(RELEASE_MANIFEST_SIGNING.keys)[0]!;
/** A release binary that answers --version with `version`. */
const binaryAt = (version: string) => `#!/bin/sh\n[ "$1" = --version ] && echo ${version}\nexit 0\n`;
const NEW_BINARY = binaryAt("9.9.9");
/** The installed CLI's version, the rollback floor the script is written with. */
const FLOOR = "1.1.218";

/** An openssl that verifies Ed25519 (OpenSSL 3), or null: macOS's LibreSSL cannot. */
const ed25519Openssl = ["/opt/homebrew/bin/openssl", "/usr/local/bin/openssl", "/usr/bin/openssl"].find((p) => {
  const r = spawnSync(p, ["version"], { encoding: "utf8" });
  return r.status === 0 && /^OpenSSL 3/.test(r.stdout);
}) ?? null;

type Release = { url?: string; sha256?: string; sign?: "pinned" | "none"; platform: "Linux" | "Darwin"; team?: string | null; updateExit?: number; version?: string; binary?: string };

function run(release: Release) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-update-"));
  const bin = path.join(home, "bin");
  const fix = path.join(home, "fixture");
  for (const d of [bin, fix, path.join(home, ".codecast")]) fs.mkdirSync(d, { recursive: true });
  const exe = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

  const key = release.platform === "Darwin" ? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64") : (process.arch === "arm64" ? "linux-arm64" : "linux-x64");
  const url = release.url ?? `${RELEASE_BASE_URL}/cli/releases/v9.9.9/abc/codecast-${key}`;
  const binary = release.binary ?? NEW_BINARY;
  const manifest = JSON.stringify({ version: release.version ?? "9.9.9", released: "2026-11-10T00:00:00Z", binaries: { [key]: { url, sha256: release.sha256 ?? createHash("sha256").update(binary).digest("hex") } } }, null, 2);
  fs.writeFileSync(path.join(fix, "latest.json"), manifest);
  if (release.sign === "pinned") {
    const sig = signManifest(new TextEncoder().encode(manifest), KEY.privateKey.export({ type: "pkcs8", format: "pem" }) as string, PINNED_ID);
    fs.writeFileSync(path.join(fix, "latest.json.sig"), JSON.stringify({ signatures: [sig] }, null, 2));
  }
  fs.writeFileSync(path.join(fix, "binary"), binary);

  // curl: serve latest.json, its signature and the binary from the fixture, by URL.
  exe("curl", `out=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; https://*) url="$1";; esac; shift; done
echo "$url" >> "${home}/fetched"
case "$url" in
  ${RELEASE_BASE_URL}/latest.json) src="${fix}/latest.json";;
  ${RELEASE_BASE_URL}/latest.json.sig) src="${fix}/latest.json.sig";;
  ${url}) src="${fix}/binary";;
  *) exit 22;;
esac
[ -f "$src" ] || exit 22
cp "$src" "$out"`);
  exe("uname", `[ "$1" = "-m" ] && { [ "${process.arch}" = arm64 ] && echo arm64 || echo x86_64; exit 0; }; echo ${release.platform}`);
  exe("codesign", release.team === undefined || release.team === null
    ? `exit 1`
    : `[ "$1" = "--verify" ] && exit 0; echo "TeamIdentifier=${release.team}" >&2`);
  if (ed25519Openssl) fs.symlinkSync(ed25519Openssl, path.join(bin, "openssl"));
  // The installed binary: its watchdog pass fails, its own updater exits as told.
  exe("codecast", `case "$2" in _watchdog) exit 1;; update) echo update >> "${home}/updated"; exit ${release.updateExit ?? 1};; esac`);

  const script = buildWatchdogShellScript({ isBinary: true, floorVersion: FLOOR, watchdogCommand: [path.join(bin, "codecast"), "--", "_watchdog"].map(shellEscapeForSh).join(" ") })
    .replace(/^CODESIGN=.*$/m, `CODESIGN="${path.join(bin, "codesign")}"`)
    .replace(/^PASS_TIMEOUT=.*$/m, "PASS_TIMEOUT=20")
    .replaceAll(PINNED_PUB, TEST_PUB)
    .replace(/while :;[\s\S]*$/, "run_check\n");
  expect(script).toContain(TEST_PUB);
  const scriptPath = path.join(home, "watchdog.sh");
  fs.writeFileSync(scriptPath, script);
  spawnSync("sh", [scriptPath], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf-8", timeout: 30_000 });
  const read = (p: string) => { try { return fs.readFileSync(path.join(home, p), "utf-8"); } catch { return ""; } };
  const result = { installed: read(".local/bin/codecast"), log: read(".codecast/watchdog-shell.log"), fetched: read("fetched"), updated: read("updated") };
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

describe("watchdog self-update fallback", () => {
  test("a binary that still runs updates through its own verified updater, and nothing is downloaded here", () => {
    const r = run({ platform: "Linux", sign: "none", updateExit: 0 });
    expect(r.updated).toContain("update");
    expect(r.log).toContain("through the installed updater");
    expect(r.fetched).not.toContain("/cli/releases/");
    expect(r.installed).toBe("");
  });

  test("an unsigned manifest is refused on Linux even when the checksum matches", () => {
    const r = run({ platform: "Linux", sign: "none" });
    expect(r.log).toContain("Refusing download");
    expect(r.installed).toBe("");
  });

  test("an unsigned manifest and a binary signed by another team is refused on darwin", () => {
    const r = run({ platform: "Darwin", sign: "none", team: "EVIL123456" });
    expect(r.log).toContain("Refusing download");
    expect(r.installed).toBe("");
  });

  test("a binary signed by our Apple team installs on darwin", () => {
    const r = run({ platform: "Darwin", sign: "none", team: DARWIN_SIGNING_TEAM });
    expect(r.installed).toBe(NEW_BINARY);
  });

  test("a checksum that does not match latest.json is refused", () => {
    const r = run({ platform: "Darwin", sign: "none", team: DARWIN_SIGNING_TEAM, sha256: "00".repeat(32) });
    expect(r.log).toContain("does not match latest.json");
    expect(r.installed).toBe("");
  });

  test("a binary URL off the release origin is never fetched", () => {
    const r = run({ platform: "Darwin", sign: "none", team: DARWIN_SIGNING_TEAM, url: "https://dl.codecast.sh.evil.net/codecast" });
    expect(r.log).toContain("Refusing release URL");
    expect(r.fetched).not.toContain("evil");
    expect(r.installed).toBe("");
  });

  test.skipIf(!ed25519Openssl)("a manifest signed by a pinned key installs on Linux", () => {
    const r = run({ platform: "Linux", sign: "pinned" });
    expect(r.installed).toBe(NEW_BINARY);
  });

  test.skipIf(!ed25519Openssl)("a replayed older signed manifest is refused before anything downloads", () => {
    const r = run({ platform: "Linux", sign: "pinned", version: "1.1.100", binary: binaryAt("1.1.100") });
    expect(r.log).toContain("Refusing v1.1.100: older than the installed v1.1.218");
    expect(r.fetched).not.toContain("/cli/releases/");
    expect(r.installed).toBe("");
  });

  test("an unsigned manifest naming an older build signed by our Apple team is refused on darwin", () => {
    const r = run({ platform: "Darwin", sign: "none", team: DARWIN_SIGNING_TEAM, version: "9.9.9", binary: binaryAt("1.1.100") });
    expect(r.log).toContain("Refusing download: v1.1.100 is older than the installed v1.1.218");
    expect(r.installed).toBe("");
  });

  test("the installed version itself may be reinstalled", () => {
    const r = run({ platform: "Darwin", sign: "none", team: DARWIN_SIGNING_TEAM, version: FLOOR, binary: binaryAt(FLOOR) });
    expect(r.installed).toBe(binaryAt(FLOOR));
  });

  test("a binary that reports no version is refused", () => {
    const r = run({ platform: "Darwin", sign: "none", team: DARWIN_SIGNING_TEAM, binary: "#!/bin/sh\nexit 0\n" });
    expect(r.log).toContain("is older than the installed");
    expect(r.installed).toBe("");
  });
});

test("the sh version floor agrees with cmpVersions", () => {
  const versions = ["0", "1", "1.0", "1.0.0", "1.1.9", "1.1.10", "1.1.218", "1.1.219", "1.2", "1.2.0.1", "2.0.0", "10.0.0", "1.10.0"];
  const pairs = versions.flatMap((a) => versions.map((b) => [a, b] as const));
  const script = `${VERSION_FLOOR_SH}\n${pairs.map(([a, b]) => `not_older_than '${a}' '${b}' && echo 1 || echo 0`).join("\n")}\n`;
  const out = spawnSync("sh", ["-c", script], { encoding: "utf8" }).stdout.trim().split("\n");
  expect(out).toEqual(pairs.map(([a, b]) => (cmpVersions(a, b) >= 0 ? "1" : "0")));
  const bad = spawnSync("sh", ["-c", `${VERSION_FLOOR_SH}\nfor v in '' 'dev' '1.2.3-beta' '9.9.9; id'; do not_older_than "$v" 0 && echo yes || echo no; done`], { encoding: "utf8" }).stdout.trim().split("\n");
  expect(bad).toEqual(["no", "no", "no", "no"]);
});

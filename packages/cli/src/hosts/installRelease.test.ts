import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { publicKeyToBase64, signManifest } from "@platform/cli-kit/update";
import { RELEASE_MANIFEST_SIGNING } from "../releaseTrust";
import { hostReleaseScript, latestRelease, releaseFor } from "./installRelease";

// A test key stands in for the release key, pinned by a test policy.
const KEY = generateKeyPairSync("ed25519");
const TEST_PUB = publicKeyToBase64(KEY.publicKey);
const POLICY = { keys: { "test-key": TEST_PUB }, required: true };
const signed = (text: string) =>
  JSON.stringify({ signatures: [signManifest(new TextEncoder().encode(text), KEY.privateKey.export({ type: "pkcs8", format: "pem" }) as string, "test-key")] }, null, 2);

/** A curl stand-in for the host script: serves fixtures from $HOME by the URL's last path part, writes to -o. */
const FAKE_CURL = `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; https://*) url="$1";; esac; shift; done
case "$url" in
  */latest.json) src="$HOME/latest.json";;
  */latest.json.sig) src="$HOME/latest.json.sig";;
  *) src="$HOME/binary";;
esac
[ -f "$src" ] || exit 22
cp "$src" "$out"
`;

/** The host script for the unpinned path, with the test key pinned in place of the release key. */
const unpinnedScript = () => {
  const script = hostReleaseScript("linux", false);
  const [, pub] = Object.entries(RELEASE_MANIFEST_SIGNING.keys)[0]!;
  expect(script).toContain(pub);
  return script.replaceAll(pub, TEST_PUB).replaceAll(`'${Object.keys(RELEASE_MANIFEST_SIGNING.keys)[0]}=`, "'test-key=");
};

/** An openssl that verifies Ed25519 (OpenSSL 3), or null: macOS's LibreSSL cannot. */
const ed25519Openssl = ["/opt/homebrew/bin/openssl", "/usr/local/bin/openssl", "/usr/bin/openssl"].find((p) => {
  const r = spawnSync(p, ["version"], { encoding: "utf8" });
  return r.status === 0 && /^OpenSSL 3/.test(r.stdout);
}) ?? null;

function hostRun(fixture: { latest?: string; sig?: string; binary?: string }, script: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "host-release-"));
  const bin = path.join(home, ".local/bin");
  fs.mkdirSync(bin, { recursive: true });
  const previous = "#!/bin/sh\necho previous\n";
  fs.writeFileSync(path.join(bin, "cast"), previous, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  if (ed25519Openssl) fs.symlinkSync(ed25519Openssl, path.join(bin, "openssl"));
  if (fixture.latest) fs.writeFileSync(path.join(home, "latest.json"), fixture.latest);
  if (fixture.sig) fs.writeFileSync(path.join(home, "latest.json.sig"), fixture.sig);
  if (fixture.binary) fs.writeFileSync(path.join(home, "binary"), fixture.binary);
  const result = spawnSync("/bin/bash", ["-s"], { input: script, encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, timeout: 30_000 });
  const installed = fs.readFileSync(path.join(bin, "cast"), "utf8");
  const backedUp = fs.existsSync(path.join(bin, "cast.before-remote-release"));
  fs.rmSync(home, { recursive: true, force: true });
  return { ...result, installed, previous, backedUp };
}

const artifact = { url: "https://dl.codecast.sh/cli/releases/fixture/cast", sha256: "0".repeat(64) };
const fixtureManifest = JSON.stringify({ version: "1.2.3", binaries: { "linux-arm64": artifact, "linux-x64": artifact } }, null, 2);

test("an unsigned latest.json is refused on the host and the installed CLI is unchanged", () => {
  const r = hostRun({ latest: fixtureManifest, binary: "tampered" }, unpinnedScript());
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("no valid signature by a pinned key");
  expect(r.installed).toBe(r.previous);
  expect(r.backedUp).toBe(false);
});

test("a latest.json signed by another key is refused on the host", () => {
  const other = generateKeyPairSync("ed25519");
  const sig = JSON.stringify({ signatures: [signManifest(new TextEncoder().encode(fixtureManifest), other.privateKey.export({ type: "pkcs8", format: "pem" }) as string, "test-key")] });
  const r = hostRun({ latest: fixtureManifest, sig, binary: "tampered" }, unpinnedScript());
  expect(r.stderr).toContain("no valid signature by a pinned key");
  expect(r.installed).toBe(r.previous);
});

test.skipIf(!ed25519Openssl)("a signed latest.json passes, and a failed checksum still leaves the installed CLI unchanged", () => {
  const r = hostRun({ latest: fixtureManifest, sig: signed(fixtureManifest), binary: "tampered" }, unpinnedScript());
  expect(r.status).not.toBe(0);
  expect(r.stderr).not.toContain("signature");
  expect(r.stderr).toContain("Release checksum mismatch");
  expect(r.installed).toBe(r.previous);
  expect(r.backedUp).toBe(false);
});

test("latestRelease trusts latest.json only when a pinned key signed its exact bytes", () => {
  const text = JSON.stringify({ version: "1.1.213", binaries: { "linux-x64": artifact } });
  const serve = (files: Record<string, string>) => (url: string) => {
    const f = files[url.slice(url.lastIndexOf("/") + 1)];
    if (f === undefined) throw new Error(`404 ${url}`);
    return f;
  };
  expect(latestRelease(serve({ "latest.json": text, "latest.json.sig": signed(text) }), POLICY)?.version).toBe("1.1.213");
  expect(latestRelease(serve({ "latest.json": text }), POLICY)).toBeNull();
  expect(latestRelease(serve({ "latest.json": text.replace("1.1.213", "1.1.214"), "latest.json.sig": signed(text) }), POLICY)).toBeNull();
  expect(latestRelease(serve({ "latest.json": text, "latest.json.sig": "{nonsense" }), POLICY)).toBeNull();
  // The production policy pins the release key, which the test key is not.
  expect(latestRelease(serve({ "latest.json": text, "latest.json.sig": signed(text) }))).toBeNull();
});

test("releaseFor names latest when it is that version, else the version's own objects under the commit it was cut from", () => {
  const latest = { version: "1.1.213", binaries: { "linux-x64": { url: "https://dl.codecast.sh/cli/releases/v1.1.213/c/codecast-linux-x64", sha256: "a".repeat(64) } } };
  const [bump, between, source] = ["1", "2", "3"].map((d) => d.repeat(40));
  const urls: string[] = [];
  const latestText = JSON.stringify(latest);
  const releaseJson = { artifacts: { "codecast-linux-x64": { sha256: "c".repeat(64) }, "codecast-darwin-arm64": { sha256: "d".repeat(64) } } };
  const fetch = (url: string) => {
    urls.push(url);
    if (url.endsWith("/latest.json")) return latestText;
    if (url.endsWith("/latest.json.sig")) return signed(latestText);
    // Cut from `source`; a commit landed on main before finalize bumped the version.
    if (url === `https://dl.codecast.sh/cli/releases/v1.1.200/${source}/release.json`) return JSON.stringify(releaseJson);
    throw new Error(`404 ${url}`);
  };
  let assets = [{ name: "codecast-linux-x64", digest: `sha256:${"c".repeat(64)}` }, { name: "codecast-darwin-arm64", digest: `sha256:${"d".repeat(64)}` }];
  const github = (url: string) => {
    if (url === "https://api.github.com/repos/codecast-sh/codecast/commits?sha=v1.1.200&per_page=10") return [bump, between, source].map((sha) => ({ sha }));
    if (url === "https://api.github.com/repos/codecast-sh/codecast/releases/tags/v1.1.200") return { assets };
    throw new Error(`404 ${url}`);
  };
  expect(releaseFor("1.1.213", fetch, github, POLICY)).toEqual(latest);
  expect(urls).toEqual(["https://dl.codecast.sh/latest.json", "https://dl.codecast.sh/latest.json.sig"]);
  expect(releaseFor("1.1.200", fetch, github, POLICY)).toEqual({
    version: "1.1.200",
    binaries: {
      "darwin-arm64": { url: `https://dl.codecast.sh/cli/releases/v1.1.200/${source}/codecast-darwin-arm64`, sha256: "d".repeat(64) },
      "linux-x64": { url: `https://dl.codecast.sh/cli/releases/v1.1.200/${source}/codecast-linux-x64`, sha256: "c".repeat(64) },
    },
  });
  expect(() => releaseFor("1.1.199", fetch, (url) => (url.includes("/releases/tags/") ? { assets } : github(url)), POLICY)).toThrow("could not read the history of GitHub tag v1.1.199");
  expect(() => releaseFor("1.1.200", fetch, (url) => (url.includes("/releases/tags/") ? { assets } : [{ sha: bump }]), POLICY)).toThrow("no published release objects under the last 1 commits");
  expect(() => releaseFor("dev", fetch, github, POLICY)).toThrow("not a published release version");
  // release.json is not signed: a binary whose sha256 GitHub does not hold is refused.
  assets = [{ name: "codecast-linux-x64", digest: `sha256:${"e".repeat(64)}` }, assets[1]!];
  expect(() => releaseFor("1.1.200", fetch, github, POLICY)).toThrow("codecast-linux-x64 on dl.codecast.sh does not match GitHub release v1.1.200");
  expect(() => releaseFor("1.1.200", fetch, (url) => (url.includes("/releases/tags/") ? {} : github(url)), POLICY)).toThrow("could not read the asset digests of GitHub release v1.1.200");
});

test("an unsigned latest.json is never the release for its version: the version's own objects are checked against GitHub", () => {
  const latest = JSON.stringify({ version: "1.1.213", binaries: { "linux-x64": { url: "https://dl.codecast.sh/codecast-linux-x64", sha256: "f".repeat(64) } } });
  const source = "3".repeat(40);
  const fetch = (url: string) => {
    if (url.endsWith("/latest.json")) return latest;
    if (url === `https://dl.codecast.sh/cli/releases/v1.1.213/${source}/release.json`) return JSON.stringify({ artifacts: { "codecast-linux-x64": { sha256: "f".repeat(64) } } });
    throw new Error(`404 ${url}`);
  };
  const github = (url: string) => (url.includes("/releases/tags/") ? { assets: [{ name: "codecast-linux-x64", digest: `sha256:${"a".repeat(64)}` }] } : [{ sha: source }]);
  expect(() => releaseFor("1.1.213", fetch, github, POLICY)).toThrow("does not match GitHub release v1.1.213");
});

test("a pinned release installs that version without reading latest.json", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "host-release-"));
  try {
    const bin = path.join(home, ".local/bin");
    fs.mkdirSync(bin, { recursive: true });
    const binary = "#!/bin/sh\necho 1.1.200\n";
    const sha256 = createHash("sha256").update(binary).digest("hex");
    const artifact = { url: "https://dl.codecast.sh/cli/releases/v1.1.200/x/codecast-linux", sha256 };
    fs.writeFileSync(path.join(home, "binary"), binary);
    // latest.json would name another version; reading it fails the test.
    // latest.json is absent from the fixture, so reading it fails the run.
    fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
    const release = { version: "1.1.200", binaries: { "linux-arm64": artifact, "linux-x64": artifact } };
    const result = spawnSync("/bin/bash", ["-s"], { input: hostReleaseScript("linux", false, release), encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 30_000 });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("CAST-RELEASE=1.1.200");
    expect(fs.readFileSync(path.join(bin, "cast"), "utf8")).toBe(binary);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

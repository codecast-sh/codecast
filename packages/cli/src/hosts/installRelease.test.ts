import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { hostReleaseScript, releaseFor } from "./installRelease";

test("a failed release checksum leaves the installed CLI unchanged", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "host-release-"));
  try {
    const bin = path.join(home, ".local/bin");
    fs.mkdirSync(bin, { recursive: true });
    const previous = "#!/bin/sh\necho previous\n";
    fs.writeFileSync(path.join(bin, "cast"), previous, { mode: 0o755 });
    const artifact = { url: "https://dl.codecast.sh/cli/releases/fixture/cast", sha256: "0".repeat(64) };
    fs.writeFileSync(path.join(home, "manifest.json"), JSON.stringify({ version: "1.2.3", binaries: { "linux-arm64": artifact, "linux-x64": artifact } }));
    fs.writeFileSync(path.join(bin, "curl"), '#!/bin/sh\ncase "$*" in *latest.json*) cp "$HOME/manifest.json" "$6";; *) printf tampered > "$6";; esac\n', { mode: 0o755 });
    const result = spawnSync("/bin/bash", ["-s"], { input: hostReleaseScript("linux", false), encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 30_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Release checksum mismatch");
    expect(fs.readFileSync(path.join(bin, "cast"), "utf8")).toBe(previous);
    expect(fs.existsSync(path.join(bin, "cast.before-remote-release"))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("releaseFor names latest when it is that version, else the version's own objects under the commit it was cut from", () => {
  const latest = { version: "1.1.213", binaries: { "linux-x64": { url: "https://dl.codecast.sh/cli/releases/v1.1.213/c/codecast-linux-x64", sha256: "a".repeat(64) } } };
  const [bump, between, source] = ["1", "2", "3"].map((d) => d.repeat(40));
  const urls: string[] = [];
  const fetch = (url: string) => {
    urls.push(url);
    if (url.endsWith("/latest.json")) return latest;
    // Cut from `source`; a commit landed on main before finalize bumped the version.
    if (url === `https://dl.codecast.sh/cli/releases/v1.1.200/${source}/release.json`) {
      return { artifacts: { "codecast-linux-x64": { sha256: "c".repeat(64) }, "codecast-darwin-arm64": { sha256: "d".repeat(64) } } };
    }
    throw new Error(`404 ${url}`);
  };
  const github = (url: string) => {
    if (url === "https://api.github.com/repos/codecast-sh/codecast/commits?sha=v1.1.200&per_page=10") return [bump, between, source].map((sha) => ({ sha }));
    throw new Error(`404 ${url}`);
  };
  expect(releaseFor("1.1.213", fetch, github)).toEqual(latest);
  expect(urls).toEqual(["https://dl.codecast.sh/latest.json"]);
  expect(releaseFor("1.1.200", fetch, github)).toEqual({
    version: "1.1.200",
    binaries: {
      "darwin-arm64": { url: `https://dl.codecast.sh/cli/releases/v1.1.200/${source}/codecast-darwin-arm64`, sha256: "d".repeat(64) },
      "linux-x64": { url: `https://dl.codecast.sh/cli/releases/v1.1.200/${source}/codecast-linux-x64`, sha256: "c".repeat(64) },
    },
  });
  expect(() => releaseFor("1.1.199", fetch, github)).toThrow("could not read the history of GitHub tag v1.1.199");
  expect(() => releaseFor("1.1.200", fetch, () => [{ sha: bump }])).toThrow("no published release objects under the last 1 commits");
  expect(() => releaseFor("dev", fetch, github)).toThrow("not a published release version");
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
    fs.writeFileSync(path.join(bin, "curl"), '#!/bin/sh\ncase "$*" in *latest.json*) exit 9;; *) cp "$HOME/binary" "$6";; esac\n', { mode: 0o755 });
    const release = { version: "1.1.200", binaries: { "linux-arm64": artifact, "linux-x64": artifact } };
    const result = spawnSync("/bin/bash", ["-s"], { input: hostReleaseScript("linux", false, release), encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 30_000 });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("CAST-RELEASE=1.1.200");
    expect(fs.readFileSync(path.join(bin, "cast"), "utf8")).toBe(binary);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

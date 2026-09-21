import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hostReleaseScript } from "./installRelease";

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

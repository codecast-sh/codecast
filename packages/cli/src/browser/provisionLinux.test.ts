import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { baseProvisionScript, daemonUnitScript, RTSP_PORT, HLS_PORT, SCREEN_DISPLAY, SCREEN_SIZE } from "./provisionLinux.js";
import { listCloudRemoteHosts, toRemoteHost, writeHosts, type CloudHost } from "./cloudHost.js";
import { remoteHome, type RemoteHost } from "../remote/session-move.js";

describe("baseProvisionScript", () => {
  const script = baseProvisionScript(20);

  test("display, stream and idle constants are interpolated", () => {
    expect(script).toContain(`Xvfb ${SCREEN_DISPLAY} -screen 0 ${SCREEN_SIZE.width}x${SCREEN_SIZE.height}x24`);
    expect(script).toContain(`rtspAddress: 127.0.0.1:${RTSP_PORT}`);
    expect(script).toContain(`hlsAddress: 127.0.0.1:${HLS_PORT}`);
    expect(script).toContain(`echo "20" | sudo tee /etc/cast-idle-minutes`);
  });

  test("no template placeholder survives into the shipped script", () => {
    // A leftover ${...} means a constant failed to interpolate — the remote
    // shell would then write a broken config without erroring (quoted heredocs
    // expand nothing).
    expect(script).not.toContain("${");
  });

  test("mediamtx runtime variables survive for mediamtx itself", () => {
    // These are NOT ours: mediamtx substitutes them when spawning the encoder.
    expect(script).toContain("rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH");
  });

  test("stream binds to loopback only — the screen shows logged-in pages", () => {
    expect(script).not.toContain("0.0.0.0");
    expect(script).toMatch(/rtspAddress: 127\.0\.0\.1/);
  });

  test("idle 0 disables the watchdog rather than powering off immediately", () => {
    const s = baseProvisionScript(0);
    expect(s).toContain(`echo "0" | sudo tee /etc/cast-idle-minutes`);
    // The check script exits when minutes <= 0.
    expect(s).toContain('[ "$MINUTES" -le 0 ] && exit 0');
  });

  test("daemon unit marks the box as a remote device", () => {
    expect(daemonUnitScript()).toContain("CODECAST_REMOTE_DEVICE=1");
  });
});

describe("idle watchdog and the daemon's activity stamp", () => {
  const script = baseProvisionScript(20);
  test("a fresh stamp keeps the box awake; a stale one lets it sleep", () => {
    expect(script).toContain("STAMP=/home/ubuntu/.codecast/host-active");
    expect(script).toContain('[ -f "$STAMP" ]');
    expect(script).toMatch(/stat -c %Y "\$STAMP".*-lt 180/);
  });
  test("process rules survive only as the fallback for a daemon that never stamped", () => {
    const fallback = script.slice(script.indexOf("else"), script.indexOf("fi", script.indexOf("else")));
    expect(fallback).toContain("pgrep -x claude");
    expect(fallback).toContain("pgrep -f 'chrome'");
    // The stamp branch must not count processes: that is the whole point.
    const stampBranch = script.slice(script.indexOf('if [ -f "$STAMP" ]'), script.indexOf("else"));
    expect(stampBranch).not.toContain("pgrep");
  });
  test("a watcher or a stream viewer still counts as activity", () => {
    expect(script).toContain("sport = :22");
    expect(script).toContain("x11grab");
  });
});

describe("remoteHome", () => {
  const base = { address: "1.2.3.4", user: "m1", keyPath: "/k", remoteBaseDir: "/Users/m1/work" };

  test("defaults to the macOS layout for legacy Scaleway hosts", () => {
    expect(remoteHome(base as RemoteHost)).toBe("/Users/m1");
  });

  test("honors an explicit Linux home", () => {
    expect(remoteHome({ ...base, user: "ubuntu", homeDir: "/home/ubuntu" } as RemoteHost)).toBe("/home/ubuntu");
  });
});

describe("cloud host registry", () => {
  test("toRemoteHost carries the Linux home", () => {
    const h: CloudHost = { id: "i-1", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k", address: "1.2.3.4" };
    const r = toRemoteHost(h);
    expect(r.homeDir).toBe("/home/ubuntu");
    expect(r.remoteBaseDir).toBe("/home/ubuntu/work");
  });

  test("listCloudRemoteHosts skips hosts with no known address", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-hosts-"));
    const prev = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = dir;
    try {
      writeHosts([
        { id: "i-a", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k", address: "1.2.3.4" },
        { id: "i-b", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k" },
      ]);
      const hosts = listCloudRemoteHosts();
      expect(hosts.map((h) => h.address)).toEqual(["1.2.3.4"]);
    } finally {
      if (prev === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

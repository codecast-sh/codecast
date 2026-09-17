import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { baseProvisionScript, buildLinuxCast, uploadLinuxCast, daemonUnitScript, IDLE_WATCHDOG_VERSION, RTSP_PORT, HLS_PORT, SCREEN_DISPLAY, SCREEN_SIZE, type ProvisionReport } from "./provisionLinux.js";
import * as remote from "./remote.js";
import { AGENT_BRIDGE_MIN_WATCHDOG } from "../cloud/agentBridge.js";
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

test("Linux provisioning ships the current CLI build entry, not stale index.js", () => {
  const source = fs.readFileSync(new URL("./provisionLinux.ts", import.meta.url), "utf8");
  expect(source).toContain('indexJs: path.join(distDir, "main.js")');
});

describe("Linux split bundle transfer", () => {
  let dir: string;
  const buildDirs: string[] = [];
  const host: RemoteHost = { address: "unused", user: "ubuntu", keyPath: "/unused", remoteBaseDir: "/home/ubuntu/work" };
  const execFileSync = childProcess.execFileSync;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-linux-transfer-test-"));
  });

  afterEach(() => {
    mock.restore();
    for (const buildDir of buildDirs.splice(0)) fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runLocal(command: string, args: string[]) {
    const output = fs.mkdtempSync(path.join(dir, "child-"));
    const out = path.join(output, "stdout");
    const err = path.join(output, "stderr");
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      childProcess.execFile("bash", ["-c", 'exec "$@" > "$TEST_OUT" 2> "$TEST_ERR"', "child", command, ...args], {
        cwd: dir, env: { ...process.env, TEST_OUT: out, TEST_ERR: err }, timeout: 20_000,
      }, (error) => {
        const stdout = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
        const stderr = fs.existsSync(err) ? fs.readFileSync(err, "utf8") : "";
        if (error) {
          error.message += `\n${stderr}`;
          reject(error);
        } else resolve({ stdout, stderr });
      });
    });
  }

  function splitDist(): string {
    const dist = path.join(dir, "dist");
    fs.mkdirSync(path.join(dist, "nested/assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "main.js"), 'import { value } from "./main-chunk.js"; console.log("cli:" + value, JSON.stringify(process.argv.slice(2)));');
    fs.writeFileSync(path.join(dist, "daemon.js"), 'const { value } = await import("./main-chunk.js"); console.log("daemon:" + value);');
    fs.writeFileSync(path.join(dist, "main-chunk.js"), 'export { value } from "./nested/dependency.js";');
    fs.writeFileSync(path.join(dist, "nested/dependency.js"), 'import { readFileSync } from "node:fs"; export const value = readFileSync(new URL("./assets/value.txt", import.meta.url), "utf8");');
    fs.writeFileSync(path.join(dist, "nested/assets/value.txt"), "split-tree-ok");
    fs.writeFileSync(path.join(dist, ".build-marker"), "hidden asset");
    fs.writeFileSync(path.join(dist, "index.js"), 'throw new Error("stale index.js");');
    return dist;
  }

  function localRemote() {
    const install = path.join(dir, "installed");
    const launcher = path.join(dir, "cast");
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, "idle-probe.py"), "preserve probe");
    fs.writeFileSync(path.join(install, "unrelated.txt"), "preserve unrelated");
    const stages: string[] = [];
    const uploads: string[] = [];
    const commands = spyOn(remote, "remoteExec").mockImplementation((_host, command) => {
      if (command.startsWith("mktemp -d ")) {
        const stage = fs.mkdtempSync(path.join(dir, "remote-stage-"));
        stages.push(stage);
        return stage;
      }
      return execFileSync("bash", ["-c", command
        .replaceAll("sudo ", "")
        .replaceAll("/usr/local/lib/codecast", install)
        .replaceAll("/usr/local/bin/cast", launcher)
        .replaceAll("/home/ubuntu/.bun/bin/bun", process.execPath)], { cwd: dir, encoding: "utf8", timeout: 20_000 }).trim();
    });
    const copy = spyOn(remote, "scpTo").mockImplementation((_host, local, destination) => {
      uploads.push(local);
      fs.copyFileSync(local, destination);
    });
    return { install, launcher, stages, uploads, commands, copy };
  }

  test("the generated transfer installs transitive chunks and assets, retaining the launcher and adjacent files", async () => {
    const dist = splitDist();
    const legacy = path.join(dir, "legacy");
    fs.mkdirSync(legacy);
    fs.copyFileSync(path.join(dist, "main.js"), path.join(legacy, "index.js"));
    fs.copyFileSync(path.join(dist, "daemon.js"), path.join(legacy, "daemon.js"));
    for (const entry of ["index.js", "daemon.js"]) {
      await expect(runLocal(process.execPath, [path.join(legacy, entry)])).rejects.toThrow("Cannot find module './main-chunk.js'");
    }

    const target = localRemote();
    uploadLinuxCast(host, dist);
    expect(await runLocal(target.launcher, ["argument with spaces"])).toEqual({ stdout: 'cli:split-tree-ok ["argument with spaces"]\n', stderr: "" });
    expect(await runLocal(process.execPath, [path.join(target.install, "daemon.js")])).toEqual({ stdout: "daemon:split-tree-ok\n", stderr: "" });
    expect(fs.readFileSync(path.join(target.install, ".build-marker"), "utf8")).toBe("hidden asset");
    expect(fs.readFileSync(path.join(target.install, "idle-probe.py"), "utf8")).toBe("preserve probe");
    expect(fs.readFileSync(path.join(target.install, "unrelated.txt"), "utf8")).toBe("preserve unrelated");
    expect(fs.statSync(target.install).mode & 0o555).toBe(0o555);
    uploadLinuxCast(host, dist);
    expect(new Set(target.stages).size).toBe(2);
    expect(new Set(target.uploads).size).toBe(2);
    for (const stage of target.stages) expect(fs.existsSync(stage)).toBe(false);
    for (const archive of target.uploads) expect(fs.existsSync(path.dirname(archive))).toBe(false);
  }, 30_000);

  test.each(["upload", "extract"])("cleans staging after %s failure without changing the installed bundle", (failure) => {
    const dist = splitDist();
    const target = localRemote();
    fs.writeFileSync(path.join(target.install, "index.js"), "existing entry");
    target.copy.mockImplementation((_host, archive, destination) => {
      target.uploads.push(archive);
      fs.writeFileSync(destination, "partial transfer");
      if (failure === "upload") throw new Error("upload interrupted");
    });
    expect(() => uploadLinuxCast(host, dist)).toThrow();
    expect(fs.readFileSync(path.join(target.install, "index.js"), "utf8")).toBe("existing entry");
    expect(fs.readFileSync(path.join(target.install, "idle-probe.py"), "utf8")).toBe("preserve probe");
    for (const stage of target.stages) expect(fs.existsSync(stage)).toBe(false);
    for (const archive of target.uploads) expect(fs.existsSync(path.dirname(archive))).toBe(false);
  });

  test("build overrides the shared outdir with a fresh, complete build on every run", async () => {
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "dist/stale-chunk.js"), "stale");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: {
      build: "bun build src/main.ts src/daemon.ts --outdir dist --target=node --splitting",
    } }));
    fs.writeFileSync(path.join(dir, "src/main.ts"), 'console.log((await import("./shared.ts")).value);');
    fs.writeFileSync(path.join(dir, "src/daemon.ts"), 'console.log((await import("./shared.ts")).value);');
    fs.writeFileSync(path.join(dir, "src/shared.ts"), 'export const value = "fresh-split-build";');
    const build = spyOn(childProcess, "execFileSync").mockImplementation(((command, args, options) => {
      expect(command).toBe("bun");
      expect(args?.slice(0, 3)).toEqual(["run", "build", "--outdir"]);
      buildDirs.push(String(args?.[3]));
      return execFileSync(process.execPath, args, { ...options, cwd: dir, timeout: 20_000 });
    }) as typeof childProcess.execFileSync);
    const first = buildLinuxCast(() => {});
    const second = buildLinuxCast(() => {});
    build.mockRestore();
    expect(first.distDir).not.toBe(second.distDir);
    for (const result of [first, second]) {
      expect(fs.existsSync(path.join(result.distDir, "stale-chunk.js"))).toBe(false);
      expect(fs.readdirSync(result.distDir).some(name => name !== "main.js" && name !== "daemon.js")).toBe(true);
      for (const entry of [result.indexJs, result.daemonJs]) {
        expect(await runLocal(process.execPath, [entry])).toEqual({ stdout: "fresh-split-build\n", stderr: "" });
      }
    }
  }, 30_000);

  test.each(["failed", "missing entry"])("cleans an incomplete build when %s", (failure) => {
    spyOn(childProcess, "execFileSync").mockImplementation(((_command: string, args: readonly string[]) => {
      const output = String(args?.[3]);
      buildDirs.push(output);
      fs.writeFileSync(path.join(output, "main.js"), "partial entry");
      if (failure === "failed") throw new Error("build failed");
      return Buffer.alloc(0);
    }) as typeof childProcess.execFileSync);
    expect(() => buildLinuxCast(() => {})).toThrow(failure === "failed" ? "build failed" : "daemon.js");
    expect(fs.existsSync(buildDirs.at(-1)!)).toBe(false);
  });
});

describe("idle watchdog and the daemon's activity stamp", () => {
  const script = baseProvisionScript(20).split("<<'IDLE'\n")[1]!.split("\nIDLE")[0]!;
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

  test("the SSH rule subtracts live agent bridges (argv0-anchored pgrep) and never goes negative-active", () => {
    // The bridge's own connection must not keep the box awake; the anchored
    // pattern matches only the `exec -a cast-agent-bridge cat` sleeper, not
    // the `bash -c '<remote command>'` wrapper whose cmdline also holds the
    // literal — counting that would subtract two per bridge and let a real
    // inbound session read as idle.
    expect(script).toContain("conns=$(ss -Htn state established '( sport = :22 )' | wc -l)");
    expect(script).toContain("bridges=$(pgrep -c -f '^cast-agent-bridge$' 2>/dev/null)");
    expect(script).toContain('[ -n "$bridges" ] || bridges=0');
    expect(script).toContain("[ $(( conns - bridges )) -gt 0 ] && active=1");
    expect(script).not.toContain('[ "$(ss -Htn state established');
    expect(script).not.toContain("${");
  });

  test("the watchdog version the bridge needs is the one provisioning installs", () => {
    expect(IDLE_WATCHDOG_VERSION).toBe(2);
    expect(AGENT_BRIDGE_MIN_WATCHDOG).toBe(IDLE_WATCHDOG_VERSION);
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

describe("ProvisionReport", () => {
  test("carries the agent CLI versions and the tools summary beside the mirror and git lines (type-level)", () => {
    const report: ProvisionReport = {
      chrome: "c", cast: "c", claude: "c", services: "cast-novnc=active", device: "active", mirror: "m", git: "ssh-ed25519 …",
      agents: "claude=2.1.263 (Claude Code)  codex=codex-cli 0.153.4  gemini=missing  grok=missing  node=v22.12.0",
      tools: "5 ok, 1 installed, 0 missing, 0 unsupported",
    };
    expect(Object.keys(report).sort()).toEqual(["agents", "cast", "chrome", "claude", "device", "git", "mirror", "services", "tools"]);
  });
});

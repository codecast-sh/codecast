import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { readHosts, upsertHost, type CloudHost } from "../../browser/cloudHost";
import { resolveRemote } from "../../browser/managedBrowser";
import { cloudIdleProbeScript } from "../../cloud/idleProbe";
import { IDLE_WATCHDOG_VERSION, idleConfigScript, idleWatchdogScript } from "../../browser/provisionLinux";
import type { RemoteHost } from "../../remote/session-move";
import { FAKE_BOX, installFakeNamespace } from "../../test-helpers/fakeNamespace";
import { buildHostsCommand } from "../cli";
import { castForPrepare, hostCastPlatform, updateHostCast } from "../updateHost";
import { daemonServiceArgs, idleServiceArgs, namespaceBaseScript, provisionDevboxHost, restartDevboxDaemon } from "./namespaceProvision";
import { displayRefusal, hostHasSystemd, hostProvider } from "./registry";

const remote: RemoteHost = {
  address: "cast-box", user: "devbox", keyPath: "/k/cast-box.key", remoteBaseDir: "/home/devbox/work", homeDir: "/home/devbox",
  proxyCommand: "/b/devbox ssh-proxy cast-box",
};
const host: CloudHost = { id: "box123", provider: "namespace", region: "iad", platform: "linux", user: "devbox", keyPath: remote.keyPath, address: "cast-box", proxyCommand: remote.proxyCommand };
const DAEMON_SCRIPT = `export CODECAST_REMOTE_DEVICE='1' CODECAST_CLOUD='1' HOME='/home/devbox' PATH='/usr/local/bin:/usr/bin:/bin:/home/devbox/.local/bin'; while :; do p=$(cat "$HOME/.codecast/daemon.pid" 2>/dev/null); [ -n "$p" ] && tr '\\0' ' ' 2>/dev/null < /proc/$p/cmdline | grep -q _daemon || /usr/local/bin/cast _daemon; sleep 5; done`;
const IDLE_SCRIPT = "sleep 300; while :; do sudo -n /usr/local/bin/cast-idle-check; sleep 120; done";

let root: string, fake: ReturnType<typeof installFakeNamespace>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cast-nsprov-"));
  fake = installFakeNamespace(root, { ssh: true });
  fs.writeFileSync(path.join(fake.bin, "curl"), "#!/bin/sh\nexit 22\n", { mode: 0o755 });
  for (const k of ["HOME", "PATH", "FAKE_NS", "CODECAST_DIR", "CODECAST_TAILSCALE_BIN"]) saved[k] = process.env[k];
  process.env.HOME = fake.home;
  process.env.PATH = `${fake.bin}:${saved.PATH}`;
  process.env.FAKE_NS = fake.state;
  process.env.CODECAST_DIR = path.join(root, "codecast");
  process.env.CODECAST_TAILSCALE_BIN = "";
  fake.set("devbox-list", JSON.stringify([FAKE_BOX]));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(root, { recursive: true, force: true });
});

const devboxServiceCalls = () => fake.argv().filter((a) => a[0] === "devbox" && a[1] === "service").map((a) => a.slice(1));
const sshCommands = () => fake.argv().filter((a) => a[0] === "ssh").map((a) => a.at(-1)!);

describe("the Namespace provisioning plan", () => {
  const base = (extra: Partial<Parameters<typeof namespaceBaseScript>[0]> = {}) => namespaceBaseScript({ idleStopMinutes: 20, home: "/home/devbox", ...extra });

  test("the watchdog's data files are written in marker mode for the host's own home", () => {
    expect(base()).toContain(idleConfigScript(20, { action: "marker", home: "/home/devbox" }));
    expect(idleConfigScript(20, { action: "marker", home: "/home/devbox" }).split("\n")).toEqual([
      'echo "20" | sudo tee /etc/cast-idle-minutes >/dev/null',
      'echo "marker" | sudo tee /etc/cast-idle-action >/dev/null',
      'echo "/home/devbox" | sudo tee /etc/cast-idle-home >/dev/null',
    ]);
  });

  test("the idle probe and the watchdog installed are byte for byte the ones every host is compared against", () => {
    const script = base();
    expect(script).toContain(`sudo tee /usr/local/lib/codecast/idle-probe.py >/dev/null <<'IDLE_PROBE'\n${cloudIdleProbeScript}\nIDLE_PROBE`);
    expect(script).toContain(`sudo tee /usr/local/bin/cast-idle-check >/dev/null <<'IDLE'\n${idleWatchdogScript()}IDLE\nsudo chmod 755 /usr/local/bin/cast-idle-check`);
  });

  test("the host's run limit is a bare integer in /etc/cast-max-run-minutes, and absent when there is none", () => {
    expect(base({ maxRunMinutes: 240 })).toContain('echo "240" | sudo tee /etc/cast-max-run-minutes >/dev/null');
    expect(base({ maxRunMinutes: 240 })).not.toContain("rm -f /etc/cast-max-run-minutes");
    expect(base()).toContain("sudo rm -f /etc/cast-max-run-minutes");
    expect(base()).not.toContain("tee /etc/cast-max-run-minutes");
  });

  test("only what the daemon and agents need is installed, and none of the display stack", () => {
    const script = base();
    expect(script).toContain("for p in tmux git rsync curl jq sshfs unzip python3 iproute2 procps; do");
    for (const display of ["xvfb", "ffmpeg", "/usr/local/bin/mediamtx", "/usr/bin/x11vnc", "novnc", "/usr/bin/websockify", "google-chrome", "fonts-noto", "cast-display", "cast-stream", "cast-vnc", "/etc/systemd", "enable-linger"]) {
      expect(script).not.toContain(display);
    }
    expect(script).toEndWith("echo PROVISION-BASE-OK");
  });

  test("the two Devbox services are exact argv, run without a shell of devbox's own", () => {
    expect(daemonServiceArgs("cast-box", "/home/devbox")).toEqual(["service", "create", "cast-box", "--name", "codecast-daemon", "--no_logs", "--", "sh", "-c", DAEMON_SCRIPT]);
    expect(idleServiceArgs("cast-box")).toEqual(["service", "create", "cast-box", "--name", "cast-idle", "--no_logs", "--", "sh", "-c", IDLE_SCRIPT]);
  });
});

describe("provisioning a Namespace host", () => {
  async function provision(opts: { skipDaemon?: boolean; maxRunMinutes?: number } = {}) {
    const lines: string[] = [];
    const steps: string[] = [];
    let baseInstalled = 0;
    const report = await provisionDevboxHost(
      remote,
      { idleStopMinutes: 20, skipDaemon: opts.skipDaemon, maxRunMinutes: opts.maxRunMinutes, onBaseInstalled: () => { baseInstalled++; } },
      (m) => lines.push(m),
      async (h, o) => { steps.push(`${h.address} ${o.gitIdentity ?? "-"}`); return { agents: "claude=1", mirror: "mirrored", git: "key", tools: "ok" }; },
    );
    return { report, lines, steps, baseInstalled };
  }

  const LIST = ["service", "list", "cast-box", "-o", "json"];
  const FIRST_RUN = [
    LIST,
    ["service", "create", "cast-box", "--name", "cast-idle", "--no_logs", "--", "sh", "-c", IDLE_SCRIPT],
    LIST,
    ["service", "create", "cast-box", "--name", "codecast-daemon", "--no_logs", "--", "sh", "-c", DAEMON_SCRIPT],
    LIST,
  ];
  const SECOND_RUN = [
    LIST,
    ["service", "delete", "cast-box", "cast-idle", "--force"],
    ["service", "create", "cast-box", "--name", "cast-idle", "--no_logs", "--", "sh", "-c", IDLE_SCRIPT],
    LIST,
    ["service", "delete", "cast-box", "codecast-daemon", "--force"],
    ["service", "create", "cast-box", "--name", "codecast-daemon", "--no_logs", "--", "sh", "-c", DAEMON_SCRIPT],
    LIST,
  ];

  test("installs the base stack, the idle service, then the daemon service, and reports both running", async () => {
    const { report, lines, steps, baseInstalled } = await provision({ maxRunMinutes: 90 });
    expect(devboxServiceCalls()).toEqual(FIRST_RUN);
    expect(baseInstalled).toBe(1);
    expect(steps).toEqual(["cast-box -"]);
    const [baseScript, prepScript] = fake.stdins().filter(Boolean);
    expect(baseScript).toBe(namespaceBaseScript({ idleStopMinutes: 20, maxRunMinutes: 90, home: "/home/devbox" }));
    expect(prepScript).toBe("set -euo pipefail\nCODECAST_NO_AUTO_UPDATE=1 /usr/local/bin/cast stop\ninstall -d -m 700 /home/devbox/.codecast && : > /home/devbox/.codecast/remote-device\necho DAEMON-PREP-OK");
    expect(report).toMatchObject({
      services: "codecast-daemon=running cast-idle=running", device: "running (pid 4242)",
      chrome: "none (no display on Namespace hosts: no host browser)", agents: "claude=1", mirror: "mirrored", git: "key", tools: "ok",
    });
    expect(lines).toEqual([
      "base stack: packages, idle watchdog, run limit (no display stack on Namespace)…",
      "starting the idle watchdog service…",
      "starting the daemon service…",
    ]);
  });

  test("the daemon is stopped on the host between deleting its service and creating it", async () => {
    fake.set("services", "codecast-daemon\ncast-idle\n");
    await provision();
    const events = fake.argv().flatMap((a) => (a[0] === "devbox" && a[2] !== "list" ? [`${a[2]} ${a[2] === "create" ? a[5] : a[4]}`] : a.at(-1) === "bash -s" ? ["script"] : []));
    expect(events).toEqual(["script", "delete cast-idle", "create cast-idle", "delete codecast-daemon", "script", "create codecast-daemon"]);
  });

  test("a service is deleted only when the box lists it: a first run issues no delete, so no failure is swallowed", async () => {
    await provision();
    expect(devboxServiceCalls().some((c) => c[1] === "delete")).toBe(false);
  });

  test("provisioning again recreates both services: delete then create, one of each, no duplicate", async () => {
    await provision();
    const before = devboxServiceCalls().length;
    await provision();
    expect(devboxServiceCalls().slice(before)).toEqual(SECOND_RUN);
    expect(fs.readFileSync(path.join(fake.state, "services"), "utf-8").trim().split("\n").sort()).toEqual(["cast-idle", "codecast-daemon"]);
  });

  test("without a daemon only the watchdog is supervised", async () => {
    const { report } = await provision({ skipDaemon: true });
    expect(devboxServiceCalls().map((c) => c[1])).toEqual(["list", "create", "list"]);
    expect(report.device).toBe("daemon skipped");
  });

  test("a service list that cannot be read at the end reports unknown instead of failing a finished provision", async () => {
    const report = await provisionDevboxHost(
      remote,
      { idleStopMinutes: 20, skipDaemon: true },
      () => {},
      async () => { fake.set("service-list-garbage"); return { agents: "claude=1", mirror: "mirrored", git: "key", tools: "ok" }; },
    );
    expect(report.services).toBe("codecast-daemon=unknown cast-idle=unknown");
  });

  test("a devbox failure stops the run", async () => {
    fake.set("devbox-fail");
    await expect(provision()).rejects.toThrow("devbox: boom");
  });

  test("a daemon that never starts is an error naming where to look", async () => {
    fs.writeFileSync(path.join(fake.bin, "ssh"), fs.readFileSync(path.join(fake.bin, "ssh"), "utf-8").replace('echo "DAEMON-PID=4242"', 'echo DAEMON-DOWN'));
    await expect(provision()).rejects.toThrow("no daemon came up within 30 s: devbox service list cast-box");
  });
});

describe("restarting a Namespace host's daemon", () => {
  const running = () => fake.set("services", "codecast-daemon\ncast-idle\n");

  test("stops the daemon on the host over ssh and waits for the service's own loop to start the next one, touching no service", () => {
    running();
    expect(restartDevboxDaemon(remote)).toEqual({ pid: "4242" });
    expect(fake.argv().filter((a) => a[0] === "devbox")).toEqual([]);
    expect(sshCommands()[0]).toBe("CODECAST_NO_AUTO_UPDATE=1 /usr/local/bin/cast stop");
    expect(sshCommands()).toHaveLength(2);
    expect(fs.readFileSync(path.join(fake.state, "services"), "utf-8").trim().split("\n").sort()).toEqual(["cast-idle", "codecast-daemon"]);
  });

  test("cast hosts update on a Devbox installs the release and restarts the daemon, never systemctl or a service", () => {
    running();
    const log: string[] = [];
    const up = updateHostCast(remote, "devbox", { restart: true, release: { version: "1.2.3", binaries: {} } }, (m) => log.push(m));
    expect(up).toEqual({ version: "1.2.3", restart: { pid: "4242" } });
    expect(devboxServiceCalls()).toEqual([]);
    expect(sshCommands().join("\n")).not.toContain("systemctl");
  });

  test("a wake or placement that finds the host behind restarts the daemon the same way", () => {
    running();
    const versions = ["1.2.0", "1.2.3"];
    const line = castForPrepare(remote, "devbox", () => {}, { laptop: () => "1.2.3", read: () => versions.shift() ?? "1.2.3", release: () => ({ version: "1.2.3", binaries: {} }) });
    expect(line).toBe("host cast updated to 1.2.3 and its daemon restarted onto it");
    expect(devboxServiceCalls()).toEqual([]);
  });

  test("the platform of a host follows its provider's capabilities", () => {
    expect(hostCastPlatform(host)).toBe("devbox");
    expect(hostCastPlatform({ provider: "aws" })).toBe("linux");
    expect(hostCastPlatform({ provider: "codecast" })).toBe("linux");
    expect(hostCastPlatform({ provider: "scaleway-mac" })).toBe("darwin");
    expect([hostHasSystemd(host), hostHasSystemd({ provider: "aws" }), hostHasSystemd({})]).toEqual([false, true, true]);
  });
});

describe("what a Namespace host does not support yet", () => {
  const MESSAGE = "live view and the managed browser are not supported on Namespace hosts yet";
  let errors: string[], err: ReturnType<typeof spyOn>, exit: ReturnType<typeof spyOn>, out: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errors = [];
    err = spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });
    out = spyOn(console, "log").mockImplementation(() => {});
    exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    upsertHost(host);
    fake.set("nsc-list", JSON.stringify([{ created_at: "2026-11-17T10:00:00Z" }]));
  });

  afterEach(() => {
    err.mockRestore();
    out.mockRestore();
    exit.mockRestore();
  });

  const cast = (...argv: string[]) => {
    const program = new Command().exitOverride();
    buildHostsCommand(program);
    return program.parseAsync(["hosts", ...argv], { from: "user" });
  };

  test("only the providers without a display say so, with one message", () => {
    expect(displayRefusal(host)).toBe(MESSAGE);
    for (const provider of ["aws", "codecast", "scaleway-mac"]) expect(displayRefusal({ provider })).toBeUndefined();
    expect([hostProvider(host).display, hostProvider({ provider: "aws" }).display, hostProvider({ provider: "scaleway-mac" }).display]).toEqual([false, true, true]);
  });

  for (const command of [["view"], ["vnc"], ["vnc", "--stop"], ["shot"]]) {
    test(`cast hosts ${command.join(" ")} is refused before the box is started or dialed`, async () => {
      await expect(cast(...command, "box123")).rejects.toThrow("exit 1");
      expect(errors.join("\n")).toContain(MESSAGE);
      expect(fake.argv().filter((a) => a[0] === "ssh")).toEqual([]);
    });
  }

  test("--shared provisioning is refused before the box is started or dialed", async () => {
    await expect(cast("provision", "box123", "--shared")).rejects.toThrow("exit 1");
    expect(errors.join("\n")).toContain("--shared is not supported on namespace hosts yet");
    expect(fake.argv().filter((a) => a[0] === "ssh")).toEqual([]);
  });

  test("the managed browser refuses a named or only Namespace host", async () => {
    await expect(resolveRemote("box123")).rejects.toThrow("exit 1");
    await expect(resolveRemote(true)).rejects.toThrow("exit 1");
    expect(errors.filter((e) => e.includes(MESSAGE))).toHaveLength(2);
    expect(fake.argv().filter((a) => a[0] === "ssh")).toEqual([]);
  });

  test("cast hosts provision takes the Devbox path: base stack and services over a proxy dial, no systemd or display", async () => {
    await expect(cast("provision", "box123", "--idle", "30")).rejects.toThrow("exit 1");
    expect(errors.join("\n")).toContain("The published Codecast release could not be read");
    const [baseScript] = fake.stdins().filter(Boolean);
    expect(baseScript).toContain('echo "marker" | sudo tee /etc/cast-idle-action >/dev/null');
    expect(baseScript).toContain('echo "30" | sudo tee /etc/cast-idle-minutes >/dev/null');
    expect(devboxServiceCalls().map((c) => c.slice(0, 5).join(" "))).toEqual(["service list cast-box -o json", "service create cast-box --name cast-idle"]);
    expect(readHosts()[0]).toMatchObject({ id: "box123", idleStopMinutes: 30, watchdogVersion: IDLE_WATCHDOG_VERSION });
    expect(fake.stdins().join("\n")).not.toContain("systemctl enable");
  });
});

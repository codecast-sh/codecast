import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { devServices, devStateDir, ensureService, readRecord, serviceStatus, tcpListeners, type DevRecord } from "./dev.js";
import type { WorkspaceManifest } from "./types.js";
import {
  IDLE_STOP_MS, SWEEP_GAP_MS, awakeSince, clientCount, devServerExit, inCodecastWorktree, logSaysCrashed, looksLikeDevServer, orphanExit, orphanTreeGone,
  parseLsofTcp, parseProcNetClients, parsePs, readLogEnd, reapDevServers, sweepFile, treeClients,
} from "./devReap.js";
import { pollUntil } from "../test-helpers/pollUntil.js";

const HOUR = 3_600_000;

describe("devServerExit", () => {
  const base = { treeExists: true, crashed: false, clients: 0, startedAt: 0, awakeSince: 0 };

  test("a tree that is gone stops it, whatever else holds", () => {
    expect(devServerExit({ ...base, treeExists: false, clients: 3 }, 1)).toBe("gone");
  });

  test("a crashed runner stops it", () => {
    expect(devServerExit({ ...base, crashed: true }, 1)).toBe("crashed");
  });

  test("no client for the whole window stops it; less does not", () => {
    expect(devServerExit(base, IDLE_STOP_MS - 1)).toBeNull();
    expect(devServerExit(base, IDLE_STOP_MS)).toBe("idle");
  });

  test("an open connection keeps it, however long it has run", () => {
    expect(devServerExit({ ...base, clients: 1 }, 48 * HOUR)).toBeNull();
  });

  test("connections it cannot read never count as idle", () => {
    expect(devServerExit({ ...base, clients: null }, 48 * HOUR)).toBeNull();
  });

  test("the window runs from the last use", () => {
    expect(devServerExit({ ...base, lastUsedAt: 10 * HOUR }, 11 * HOUR)).toBeNull();
    expect(devServerExit({ ...base, lastUsedAt: 10 * HOUR }, 12 * HOUR)).toBe("idle");
  });

  test("the window restarts when the machine wakes", () => {
    expect(devServerExit({ ...base, awakeSince: 10 * HOUR }, 11 * HOUR)).toBeNull();
    expect(devServerExit({ ...base, awakeSince: 10 * HOUR }, 12 * HOUR)).toBe("idle");
  });
});

describe("awakeSince", () => {
  test("an unbroken run of sweeps keeps its start; a gap, or no earlier sweep, starts it now", () => {
    expect(awakeSince({ at: 100 * HOUR, awakeSince: 90 * HOUR }, 100 * HOUR + SWEEP_GAP_MS)).toBe(90 * HOUR);
    expect(awakeSince({ at: 100 * HOUR, awakeSince: 90 * HOUR }, 100 * HOUR + SWEEP_GAP_MS + 1)).toBe(100 * HOUR + SWEEP_GAP_MS + 1);
    expect(awakeSince(null, 5)).toBe(5);
  });
});

describe("orphanExit", () => {
  test("a gone tree stops an orphan only with no client", () => {
    expect(orphanExit({ treeGone: true, castDev: false, inWorktree: true, upMs: 0, clients: 0 })).toBe("gone");
    expect(orphanExit({ treeGone: true, castDev: false, inWorktree: true, upMs: 0, clients: 1 })).toBeNull();
    expect(orphanExit({ treeGone: true, castDev: true, inWorktree: false, upMs: 0, clients: null })).toBeNull();
  });

  test("idle applies only to a cast dev orphan up the whole window", () => {
    expect(orphanExit({ treeGone: false, castDev: true, inWorktree: false, upMs: IDLE_STOP_MS, clients: 0 })).toBe("idle");
    expect(orphanExit({ treeGone: false, castDev: true, inWorktree: false, upMs: IDLE_STOP_MS - 1, clients: 0 })).toBeNull();
    expect(orphanExit({ treeGone: false, castDev: false, inWorktree: true, upMs: 48 * HOUR, clients: 0 })).toBeNull();
  });

  test("an orphan vite from an unrelated directory is left alone, its cwd gone or not", () => {
    const cwd = "/Users/someone/side-project/web";
    const args = "node /Users/someone/side-project/node_modules/.bin/vite --port 5173";
    expect(orphanTreeGone(cwd, () => false)).toBe(true);
    expect(inCodecastWorktree(cwd, args)).toBe(false);
    expect(orphanExit({ treeGone: true, castDev: false, inWorktree: inCodecastWorktree(cwd, args), upMs: 48 * HOUR, clients: 0 })).toBeNull();
  });

  test("codecast and agent worktrees are ours, by cwd or by script", () => {
    expect(inCodecastWorktree("/r/.codecast/worktrees/_trash-1/packages/web", "bun run dev")).toBe(true);
    expect(inCodecastWorktree(null, "node /r/.claude/worktrees/agent-a12/packages/web/node_modules/.bin/vite")).toBe(true);
    expect(inCodecastWorktree("/r/packages/web", "next dev")).toBe(false);
  });
});

describe("parsing", () => {
  test("lsof rows: listeners and accepted connections, with the local port", () => {
    const out = "p57475\ng55635\nf18\nn*:3204\nTST=LISTEN\nTQR=0\nf22\nn127.0.0.1:3204->127.0.0.1:51000\nTST=ESTABLISHED\nf23\nn127.0.0.1:50100->127.0.0.1:443\nTST=ESTABLISHED\n";
    expect(parseLsofTcp(out)).toEqual([
      { pid: 57475, local: 3204, state: "LISTEN" },
      { pid: 57475, local: 3204, state: "ESTABLISHED" },
      { pid: 57475, local: 50100, state: "ESTABLISHED" },
    ]);
  });

  test("/proc/net/tcp connected rows as local ports, a not-yet-accepted client included", () => {
    // Read on Linux from a Bun.serve on 47500 with one client that has sent nothing: the
    // server side sits in SYN_RECV (03) under TCP_DEFER_ACCEPT; the client's own row is 01.
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:8128 0100007F:B98C 01 00000000:00000000 00:00000000 00000000  1000        0 111",
    ].join("\n");
    const tcp6 = [
      "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000000000000000000000000000:B98C 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 112",
      "   1: 0000000000000000FFFF00000100007F:B98C 0000000000000000FFFF00000100007F:8128 03 00000000:00000000 00:00000000 00000000  1000        0 0",
    ].join("\n");
    const ports = [...parseProcNetClients(tcp), ...parseProcNetClients(tcp6)];
    expect(ports).toEqual([0x8128, 47500]);
    expect(ports.filter((p) => p === 47500)).toHaveLength(1);
  });

  test("ps rows carry their age", () => {
    expect(parsePs("  89271     1 66045   501 01-20:44:20 Sun Nov  2 21:14:00 2026     node /x/node_modules/.bin/vite --port 3202\n")).toEqual([
      { pid: 89271, ppid: 1, pgid: 66045, uid: 501, etimeSecs: 86400 + 20 * 3600 + 44 * 60 + 20, start: "Sun Nov 2 21:14:00 2026", args: "node /x/node_modules/.bin/vite --port 3202" },
    ]);
  });

  test("this machine's ps parses, start time included", () => {
    const out = spawnSync("ps", ["-o", "pid=,ppid=,pgid=,uid=,etime=,lstart=,args=", "-p", String(process.pid)], { encoding: "utf-8" }).stdout;
    expect(parsePs(out)).toEqual([expect.objectContaining({ pid: process.pid, start: expect.stringMatching(/^\w{3} \w{3} \d+ \d\d:\d\d:\d\d \d{4}$/) })]);
  });

  test("the crash banner is found under the output vite printed after it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-dev-log-"));
    const log = path.join(dir, "web.log");
    fs.writeFileSync(log, `VITE ready\npanic(main thread): Segmentation fault at address 0x0\noh no: Bun has crashed.\n${"[vite] (client) hmr update /app/globals.css\n".repeat(200)}`);
    expect(logSaysCrashed(readLogEnd(log))).toBe(true);
    expect(readLogEnd(log, 10)).toBe("obals.css\n");
    expect(readLogEnd(path.join(dir, "missing.log"))).toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("dev server shapes", () => {
    expect(looksLikeDevServer("bun run dev --port 3203")).toBe(true);
    expect(looksLikeDevServer("/usr/bin/node /r/packages/web/node_modules/.bin/vite --port 3205")).toBe(true);
    expect(looksLikeDevServer("node node_modules/.bin/vite --port 3201 --strictPort")).toBe(true);
    expect(looksLikeDevServer("/Applications/Vitess.app/Contents/MacOS/vitess")).toBe(false);
    expect(looksLikeDevServer("bun run devtools")).toBe(false);
  });

  test("an orphan's tree is gone when its checkout is, or it sits in a _trash- dir", () => {
    const exists = (p: string) => p.startsWith("/live");
    expect(orphanTreeGone("/live/r/packages/web", exists)).toBe(false);
    expect(orphanTreeGone("/dead/r/packages/web", exists)).toBe(true);
    expect(orphanTreeGone("/live/.codecast/worktrees/_trash-1234/packages/web", exists)).toBe(true);
    expect(orphanTreeGone(null, exists)).toBe(false);
  });

  test("a deleted node_modules or package dir under a present worktree is not a gone tree", () => {
    const wt = "/r/.codecast/worktrees/goals-lab";
    const exists = (p: string) => p === wt;
    expect(orphanTreeGone(`${wt}/packages/web`, exists)).toBe(false);
    expect(orphanTreeGone(`${wt}/packages/web`, () => false)).toBe(true);
  });

  test("bun's crash banner", () => {
    expect(logSaysCrashed("panic(main thread): Segmentation fault at address 0x0\noh no: Bun has crashed.")).toBe(true);
    expect(logSaysCrashed("VITE v6.4.2  ready in 593 ms")).toBe(false);
  });
});

describe("reapDevServers on real servers", () => {
  let tmp: string;
  const savedDir = process.env.CODECAST_DIR;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cast-dev-reap-"));
    process.env.CODECAST_DIR = path.join(tmp, "state");
  });
  afterAll(() => {
    if (savedDir === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = savedDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const manifest = (base: number): WorkspaceManifest => ({
    setup: { copy: [], share: [], install: [], generate: [], migrate: [] },
    ports: { web: { base, range: 1 } }, env: {}, teardown: { run: [] },
    services: { web: { mode: "isolated", start: `bun -e 'Bun.serve({ port: Number(process.env.PORT_WEB), fetch: () => new Response("ok") })' & wait`, port: "web" } },
    browser: { enabled: false, headless: true, cdpPort: { base: 9222, range: 100 } }, backend: "local",
  });

  const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

  /**
   * A server laid out as `cast dev` leaves one: a detached group whose leader
   * shell has the server as its child (`bun run dev` and its vite), with its
   * record. Not through ensureService: its readiness probe keeps sockets open
   * from this process, which are clients until it exits.
   */
  async function start(port: number): Promise<{ checkout: string; record: DevRecord }> {
    const checkout = fs.mkdtempSync(path.join(tmp, "repo-"));
    const command = `bun -e 'Bun.serve({ port: ${port}, fetch: () => new Response("ok") })' & wait`;
    const child = spawn("bash", ["-c", command], { cwd: checkout, detached: true, stdio: "ignore" });
    child.unref();
    const record: DevRecord = {
      name: "web", pid: child.pid!, port, url: `http://localhost:${port}`, command, cwd: checkout,
      log: path.join(devStateDir(checkout), "web.log"), startedAt: new Date().toISOString(),
    };
    fs.mkdirSync(devStateDir(checkout), { recursive: true });
    fs.writeFileSync(path.join(devStateDir(checkout), "web.json"), JSON.stringify(record));
    await pollUntil(() => (tcpListeners({ pgid: record.pid }) ?? []).some((l) => l.port === port), `the server to listen on ${port}`);
    return { checkout, record };
  }

  test("a server whose checkout is deleted stops, its child included", async () => {
    const { checkout, record } = await start(47410);
    fs.rmSync(checkout, { recursive: true, force: true });
    const lines = await reapDevServers({ orphans: false });
    expect(lines).toEqual([expect.stringContaining("its checkout is gone")]);
    await pollUntil(() => !groupAlive(record.pid), "the server's process group to exit");
    expect(readRecord(checkout, "web")?.stopped?.reason).toBe("its checkout is gone");
  }, 60_000);

  test("an orphan wrapper's clients include its child's: a wrapper listening on nothing is not idle", async () => {
    const { record } = await start(47450);
    const child = tcpListeners({ pgid: record.pid })!.find((l) => l.port === 47450)!.pid;
    expect(child).not.toBe(record.pid);
    const socket = net.connect({ host: "127.0.0.1", port: record.port });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    try {
      expect(treeClients([{ pid: record.pid, pgid: record.pid }])).toBe(0);
      const clients = treeClients([{ pid: record.pid, pgid: record.pid }, { pid: child, pgid: record.pid }]);
      expect(clients).toBe(1);
      expect(orphanExit({ treeGone: true, castDev: true, inWorktree: true, upMs: 48 * HOUR, clients })).toBeNull();
    } finally {
      socket.destroy();
      try { process.kill(-record.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }, 60_000);

  test("a server whose runner crashed stops even with a client connected", async () => {
    const { record } = await start(47440);
    fs.writeFileSync(record.log, `panic(main thread): Segmentation fault at address 0x0\noh no: Bun has crashed.\n${"[vite] hmr update /a.tsx\n".repeat(200)}`);
    const socket = net.connect({ host: "127.0.0.1", port: record.port });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    try {
      expect(clientCount(record.pid)).toBe(1);
      expect(await reapDevServers({ orphans: false })).toEqual([expect.stringContaining("its runner crashed")]);
      await pollUntil(() => !groupAlive(record.pid), "the crashed server's group to exit");
    } finally {
      socket.destroy();
      try { process.kill(-record.pid, "SIGKILL"); } catch { /* gone */ }
    }
    // The tombstone keeps status and logs answering, and a restart keeps the crash in <log>.prev.
    const m = manifest(47440);
    const svc = devServices(m)[0];
    expect(await serviceStatus(svc, record.cwd, m)).toEqual({ name: "web", state: "stopped", stoppedBy: { at: expect.any(String), reason: "its runner crashed" } });
    expect(fs.readFileSync(record.log, "utf-8")).toContain("stopped by the codecast daemon: its runner crashed");
    expect(await reapDevServers({ orphans: false })).toEqual([]);
    const again = await ensureService(svc, { checkout: record.cwd, manifest: m, timeoutSec: 30 });
    try {
      expect(again.state).toBe("started");
      expect(fs.readFileSync(`${record.log}.prev`, "utf-8")).toContain("Bun has crashed");
      expect(fs.readFileSync(record.log, "utf-8")).not.toContain("Bun has crashed");
    } finally {
      if (again.state === "started") try { process.kill(-again.record.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }, 60_000);

  test("the first sweep after a sleep restarts the idle count instead of stopping", async () => {
    const { checkout, record } = await start(47470);
    try {
      const later = Date.now() + IDLE_STOP_MS + 60_000;
      fs.writeFileSync(sweepFile(), JSON.stringify({ at: Date.now() - 60_000, awakeSince: 0 }));
      expect(await reapDevServers({ orphans: false, now: later })).toEqual([]);
      expect(JSON.parse(fs.readFileSync(sweepFile(), "utf-8"))).toEqual({ at: later, awakeSince: later });
      expect(groupAlive(record.pid)).toBe(true);
      expect(readRecord(checkout, "web")?.stopped).toBeUndefined();
    } finally {
      try { process.kill(-record.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }, 60_000);

  test("cast dev reusing a server counts as a use", async () => {
    const { checkout, record } = await start(47480);
    try {
      const m = manifest(47480);
      expect((await ensureService(devServices(m)[0], { checkout, manifest: m, timeoutSec: 30 })).state).toBe("running");
      const used = Date.parse(readRecord(checkout, "web")?.lastUsedAt ?? "");
      expect(Date.now() - used).toBeLessThan(60_000);
      expect(devServerExit({ treeExists: true, crashed: false, clients: 0, startedAt: 0, awakeSince: 0, lastUsedAt: used }, used + IDLE_STOP_MS - 1)).toBeNull();
    } finally {
      try { process.kill(-record.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }, 60_000);

  test("a server with no client past the window stops; one with an open connection stays", async () => {
    const idle = await start(47420);
    const held = await start(47430);
    const socket = net.connect({ host: "127.0.0.1", port: held.record.port });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    try {
      // The first pass sees the connection and stamps it; nothing is old enough yet.
      expect(clientCount(idle.record.pid)).toBe(0);
      expect(clientCount(held.record.pid)).toBe(1);
      expect(await reapDevServers({ orphans: false })).toEqual([]);
      expect(readRecord(held.checkout, "web")?.lastUsedAt).toBeDefined();
      // Awake the whole time: sweeps ran without a gap since before both started.
      const later = Date.now() + IDLE_STOP_MS + 60_000;
      fs.writeFileSync(sweepFile(), JSON.stringify({ at: later - 60_000, awakeSince: 0 }));
      const lines = await reapDevServers({ orphans: false, now: later });
      expect(lines).toEqual([expect.stringContaining(`${idle.checkout}: no client for 2h`)]);
      await pollUntil(() => !groupAlive(idle.record.pid), "the idle server's group to exit");
      expect(groupAlive(held.record.pid)).toBe(true);
    } finally {
      socket.destroy();
      for (const pgid of [idle.record.pid, held.record.pid]) try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
    }
  }, 60_000);
});

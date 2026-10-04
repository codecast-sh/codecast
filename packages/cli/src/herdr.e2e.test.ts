// herdr end to end: the `cast herd` mirror and message delivery into an agent
// running in a herdr pane, against a real herdr server in a private config dir
// and the test run's private tmux server (bunfig preload). Skipped where herdr
// is not installed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { herdrAlive, herdrBin, herdrRequest, herdrSnapshot, herdrSocketPath } from "./herdr.js";
import { HerdFocus, herdMembers, syncHerd, syncHerdStatus } from "./herdMirror.js";
import { claimHerdViewer } from "./herdViewer.js";
import { execFileAsync } from "./proc.js";
import { listCodecastPanesAsync, tmuxRunAsync } from "./tmux.js";

const bin = herdrBin();
const SESSION = "e2e";
// Short on purpose: macOS caps a Unix socket path at 104 bytes, and herdr
// nests its sockets three levels under the config dir.
const dir = mkdtempSync("/tmp/herdr-e2e-");
const prevXdg = process.env.XDG_CONFIG_HOME;
let socketPath = "";

const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    last = await read();
  }
  return last;
};

const readPane = async (paneId: string) =>
  (await herdrRequest<{ read: { text: string } }>(socketPath, "pane.read", { pane_id: paneId, source: "recent_unwrapped", lines: 40 })).read.text;

describe.skipIf(!bin || process.platform === "win32")("herdr", () => {
  beforeAll(async () => {
    process.env.XDG_CONFIG_HOME = dir;
    socketPath = herdrSocketPath(SESSION);
    const env = { ...process.env };
    delete env.TMUX;
    spawn(bin!, ["--session", SESSION, "server"], { detached: true, stdio: "ignore", env }).unref();
    expect(await until(() => herdrAlive(socketPath, 3000), Boolean, 20_000)).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await herdrRequest(socketPath, "server.stop").catch(() => {});
    // The server writes its session file as it exits; remove the dir after.
    await until(() => herdrAlive(socketPath, 500), (alive) => !alive, 10_000);
    await new Promise((r) => setTimeout(r, 500));
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
  });

  test("the herd mirrors a stamped tmux session with codecast's state, and drops it when it ends", async () => {
    const name = "cc-claude-herde2e";
    await tmuxRunAsync(["new-session", "-d", "-s", name, "-c", dir, "while true; do echo herd-e2e-alive; sleep 1; done"]);
    for (const [opt, value] of [["@codecast_session_id", "e2e-s1"], ["@codecast_conversation_id", "jx7e2e0000"], ["@codecast_project_path", dir], ["@codecast_agent_type", "codex"]]) {
      await tmuxRunAsync(["set-option", "-t", name, opt, value]);
    }
    const members = async (status: string) =>
      herdMembers((await listCodecastPanesAsync()).filter((p) => p.tmux === name), { status: () => status, title: () => "Mirror me" });

    expect((await syncHerd(socketPath, await members("permission_blocked"))).map((op) => op.kind)).toEqual(["open"]);
    expect(await syncHerd(socketPath, await members("permission_blocked"))).toEqual([]);

    const pane = (await herdrSnapshot(socketPath)).panes.find((p) => p.tokens?.codecast_session === "e2e-s1")!;
    expect(pane).toMatchObject({ agent: "codex", agent_status: "blocked", title: "Mirror me · jx7e2e0" });
    await herdrRequest(socketPath, "pane.focus", { pane_id: pane.pane_id });
    await new HerdFocus().sync(socketPath, await members("permission_blocked"));
    expect(await until(() => readPane(pane.pane_id), (t) => t.includes("herd-e2e-alive"))).toContain("herd-e2e-alive");

    await syncHerd(socketPath, await members("working"));
    const working = (await herdrSnapshot(socketPath)).panes.find((p) => p.pane_id === pane.pane_id);
    expect(working?.agent_status).toBe("working");

    await tmuxRunAsync(["kill-session", "-t", name]);
    await syncHerd(socketPath, []);
    const gone = await until(() => herdrSnapshot(socketPath), (s) => !s.panes.some((p) => p.pane_id === pane.pane_id));
    expect(gone.panes.some((p) => p.tokens?.codecast_session === "e2e-s1")).toBe(false);
  }, 60_000);

  test("only the focused mirror attaches, switching detaches it, and cleanup preserves agents", async () => {
    const names = ["cc-claude-focus-a", "cc-claude-focus-b"];
    const members = names.map((tmux, i) => ({ tmux, sessionId: `focus-${i}`, projectPath: dir, agent: "claude", state: null, title: tmux, tabLabel: tmux }));
    for (const name of names) await tmuxRunAsync(["new-session", "-d", "-s", name, "-x", "180", "-y", "50", "sleep 120"]);
    const controls = names.map((name) => {
      const client = spawn("tmux", ["-C", "attach-session", "-t", `=${name}`], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env } });
      client.stdin!.write("refresh-client -C 180,50\n");
      return client;
    });
    const clients = async () => (await tmuxRunAsync(["list-clients", "-F", "#{client_control_mode}|#{session_name}"])).stdout.trim().split("\n").filter((row) => row.startsWith("0|")).map((row) => row.slice(2));
    try {
      await syncHerd(socketPath, members);
      expect(await clients()).toEqual([]);
      const panes = (await herdrSnapshot(socketPath)).panes.filter((p) => p.tokens?.codecast_session?.startsWith("focus-"));
      const focus = new HerdFocus();
      for (const i of [0, 1, 0]) {
        const pane = panes.find((p) => p.tokens?.codecast_session === `focus-${i}`)!;
        await herdrRequest(socketPath, "pane.focus", { pane_id: pane.pane_id });
        await focus.sync(socketPath, members);
        expect(await until(clients, (c) => c.length === 1 && c[0] === names[i])).toEqual([names[i]]);
        await focus.sync(socketPath, members);
        expect(await clients()).toEqual([names[i]]);
        const size = await tmuxRunAsync(["display-message", "-p", "-t", `${names[i]}:0.0`, "#{pane_width}x#{pane_height}"]);
        expect(size.stdout.trim()).toBe("180x50");
      }
      await syncHerdStatus(socketPath, members);
      expect((await herdrSnapshot(socketPath)).panes.some((p) => p.tokens?.codecast_session?.startsWith("focus-"))).toBe(false);
      const release = await claimHerdViewer(socketPath);
      try {
        await syncHerdStatus(socketPath, members);
        expect((await herdrSnapshot(socketPath)).panes.some((p) => p.tokens?.codecast_session?.startsWith("focus-"))).toBe(false);
      } finally {
        await release();
      }
      expect(await until(clients, (c) => c.length === 0)).toEqual([]);
      for (const name of names) expect((await tmuxRunAsync(["has-session", "-t", name])).status).toBe(0);
    } finally {
      await syncHerd(socketPath, []);
      for (const client of controls) client.kill();
      for (const name of names) await tmuxRunAsync(["kill-session", "-t", name]);
    }
  }, 60_000);

  test("closing cast herd removes viewers and leaves the underlying agent running", async () => {
    const name = "cc-claude-lifecycle";
    const host = "herd-viewer-host";
    const viewerSocket = herdrSocketPath("codecast");
    const script = join(dir, "viewer.ts");
    writeFileSync(script, `import { runHerdCommand } from ${JSON.stringify(new URL("./herdCommand.ts", import.meta.url).pathname)}; await runHerdCommand(null);`);
    await tmuxRunAsync(["new-session", "-d", "-s", name, "sleep 120"]);
    await tmuxRunAsync(["set-option", "-t", name, "@codecast_session_id", "lifecycle-s1"]);
    await tmuxRunAsync(["set-option", "-t", name, "@codecast_project_path", dir]);
    try {
      await tmuxRunAsync(["new-session", "-d", "-s", host, `env XDG_CONFIG_HOME=${dir} TMUX_TMPDIR=${process.env.TMUX_TMPDIR} ${process.execPath} ${script}`]);
      expect(await until(() => Promise.resolve(existsSync(`${viewerSocket}.viewer`)), Boolean, 20_000)).toBe(true);
      const panes = await until(() => herdrSnapshot(viewerSocket), (s) => s.panes.some((p) => p.tokens?.codecast_session === "lifecycle-s1"));
      const pane = panes.panes.find((p) => p.tokens?.codecast_session === "lifecycle-s1")!;
      await herdrRequest(viewerSocket, "pane.focus", { pane_id: pane.pane_id });
      const clients = async () => (await tmuxRunAsync(["list-clients", "-t", name, "-F", "#{client_pid}"])).stdout.trim();
      expect(await until(clients, Boolean)).not.toBe("");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const cpu = await execFileAsync("ps", ["-p", await clients(), "-o", "%cpu="], { encoding: "utf8", timeout: 3000 });
      console.log(`focused tmux viewer CPU: ${String(cpu.stdout).trim()}%`);
      await tmuxRunAsync(["send-keys", "-t", host, "C-b", "q"]);
      expect(await until(clients, (s) => s === "")).toBe("");
      const closed = await until(() => herdrSnapshot(viewerSocket), (s) => !s.panes.some((p) => p.tokens?.codecast_session));
      expect(closed.panes.some((p) => p.tokens?.codecast_session)).toBe(false);
      expect(existsSync(`${viewerSocket}.viewer`)).toBe(false);
      expect((await tmuxRunAsync(["has-session", "-t", name])).status).toBe(0);
    } finally {
      await herdrRequest(viewerSocket, "server.stop").catch(() => {});
      await tmuxRunAsync(["kill-session", "-t", host]);
      await tmuxRunAsync(["kill-session", "-t", name]);
    }
  }, 60_000);

  test("delivery reaches an agent in a herdr pane: one bracketed paste, one Enter", async () => {
    const { injectViaTerminal } = await import("./daemon.js");
    // A stand-in agent: turns bracketed paste on and prints every read it gets.
    const agent = join(dir, "agent.py");
    writeFileSync(agent, [
      "import os, sys, tty",
      "tty.setraw(0)",
      "sys.stdout.write('\\x1b[?2004hready\\r\\n'); sys.stdout.flush()",
      "while True:",
      "    data = os.read(0, 4096)",
      "    if not data: break",
      "    sys.stdout.write('GOT ' + repr(data) + '\\r\\n'); sys.stdout.flush()",
    ].join("\n"));
    const ws = await herdrRequest<Record<string, any>>(socketPath, "workspace.create", { cwd: dir, focus: false });
    const paneId = ws.root_pane.pane_id as string;
    await herdrRequest(socketPath, "pane.send_text", { pane_id: paneId, text: `exec python3 ${agent}\r` });
    await until(() => readPane(paneId), (t) => t.includes("ready"));

    const info = await herdrRequest<{ process_info: { foreground_processes: Array<{ pid: number }> } }>(socketPath, "pane.process_info", { pane_id: paneId });
    const pid = info.process_info.foreground_processes[0].pid;
    const tty = String((await execFileAsync("ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf-8" })).stdout).trim();

    await injectViaTerminal(tty, "hello herd\nsecond line", "herdr", { agentType: "claude" });
    const text = await until(() => readPane(paneId), (t) => (t.match(/GOT b'\\r'/g) ?? []).length >= 1);
    expect(text).toContain("GOT b'\\x1b[200~hello herd\\nsecond line\\x1b[201~'");
    expect(text.match(/GOT b'\\r'/g)).toHaveLength(1);
  }, 60_000);
});

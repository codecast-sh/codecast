// herdr end to end: the `cast herd` mirror and message delivery into an agent
// running in a herdr pane, against a real herdr server in a private config dir
// and the test run's private tmux server (bunfig preload). Skipped where herdr
// is not installed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrAlive, herdrBin, herdrRequest, herdrSnapshot, herdrSocketPath } from "./herdr.js";
import { herdMembers, syncHerd } from "./herdMirror.js";
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
    expect(await until(() => readPane(pane.pane_id), (t) => t.includes("herd-e2e-alive"))).toContain("herd-e2e-alive");

    await syncHerd(socketPath, await members("working"));
    const working = (await herdrSnapshot(socketPath)).panes.find((p) => p.pane_id === pane.pane_id);
    expect(working?.agent_status).toBe("working");

    await tmuxRunAsync(["kill-session", "-t", name]);
    const gone = await until(() => herdrSnapshot(socketPath), (s) => !s.panes.some((p) => p.pane_id === pane.pane_id));
    expect(gone.panes.some((p) => p.tokens?.codecast_session === "e2e-s1")).toBe(false);
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

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { listCodecastPanesComplete } from "./herdCommand.js";
import { HerdFocus, HerdTitles, herdMembers, planHerd, type HerdMember } from "./herdMirror.js";
import type { HerdrPane, HerdrSnapshot } from "./herdr.js";
import type { CodecastPane } from "./tmux.js";
import { sessionSocketName, tmuxSocketDir } from "./tmuxRoute.js";

const pane = (over: Partial<CodecastPane>): CodecastPane => ({
  tmux: "cc-claude-abc",
  sessionId: "s1",
  createdSec: 1,
  activitySec: 1,
  conversationId: "jx7abcdefghij",
  agentType: "claude",
  projectPath: "/src/app",
  ...over,
});

const member = (over: Partial<HerdMember> = {}): HerdMember => ({
  sessionId: "s1",
  tmux: "cc-claude-abc",
  projectPath: "/src/app",
  agent: "claude",
  state: "working",
  title: "Fix auth · jx7abcd",
  tabLabel: "Fix auth",
  ...over,
});

const herdrPane = (over: Partial<HerdrPane> = {}): HerdrPane => ({
  pane_id: "w1:p1",
  tab_id: "w1:t1",
  workspace_id: "w1",
  agent: "claude",
  agent_status: "working",
  title: "Fix auth · jx7abcd",
  tokens: { codecast_session: "s1" },
  ...over,
});

const snap = (panes: HerdrPane[]): HerdrSnapshot => ({ workspaces: [], tabs: [], panes });

describe("herdMembers", () => {
  const lookup = { status: () => "permission_blocked", title: () => "Fix auth" };

  test("only panes codecast stamped join the herd", () => {
    const members = herdMembers([pane({}), pane({ tmux: "codex-shell", sessionId: null })], lookup);
    expect(members.map((m) => m.tmux)).toEqual(["cc-claude-abc"]);
  });

  test("title carries the short id, state maps to herdr's vocabulary", () => {
    const [m] = herdMembers([pane({})], lookup);
    expect(m.title).toBe("Fix auth · jx7abcd");
    expect(m.state).toBe("blocked");
    expect(m.agent).toBe("claude");
  });

  test("an unknown status is unknown, but a caller with no status source leaves state alone", () => {
    expect(herdMembers([pane({})], { status: () => undefined, title: () => "t" })[0].state).toBe("unknown");
    expect(herdMembers([pane({})], { status: () => null, title: () => "t" })[0].state).toBeNull();
  });

  test("a long title is cut for the tab, kept whole for the pane", () => {
    const long = "A very long session title that keeps going and going";
    const [m] = herdMembers([pane({})], { status: () => "idle", title: () => long });
    expect(m.tabLabel.length).toBe(28);
    expect(m.title.startsWith(long)).toBe(true);
  });
});

describe("planHerd", () => {
  test("a session with no pane is opened", () => {
    expect(planHerd([member()], snap([]))).toEqual([{ kind: "open", member: member() }]);
  });

  test("a pane already in step needs nothing", () => {
    expect(planHerd([member()], snap([herdrPane()]))).toEqual([]);
  });

  test("herdr's done badge is idle, not a change", () => {
    expect(planHerd([member({ state: "idle" })], snap([herdrPane({ agent_status: "done" })]))).toEqual([]);
  });

  test("state and title changes are reported separately", () => {
    const ops = planHerd([member({ state: "blocked" })], snap([herdrPane()]));
    expect(ops).toEqual([{ kind: "report", paneId: "w1:p1", member: member({ state: "blocked" }), state: true, title: false }]);
    const renamed = planHerd([member({ title: "New · jx7abcd" })], snap([herdrPane()]));
    expect(renamed[0]).toMatchObject({ kind: "report", state: false, title: true });
  });

  test("an unknown state never overwrites the pane's", () => {
    expect(planHerd([member({ state: null })], snap([herdrPane({ agent_status: "blocked" })]))).toEqual([]);
  });

  test("a pane whose session ended is closed, and so is a duplicate", () => {
    const ops = planHerd([member()], snap([
      herdrPane(),
      herdrPane({ pane_id: "w1:p2" }),
      herdrPane({ pane_id: "w1:p3", tokens: { codecast_session: "gone" } }),
    ]));
    expect(ops).toEqual([{ kind: "close", paneId: "w1:p2" }, { kind: "close", paneId: "w1:p3" }]);
  });

  test("panes codecast did not open are left alone", () => {
    expect(planHerd([], snap([herdrPane({ tokens: {} })]))).toEqual([]);
  });
});

describe("HerdTitles", () => {
  test("fetches only sessions it has not seen, until the interval passes", async () => {
    const asked: string[][] = [];
    const titles = new HerdTitles(async (ids) => {
      asked.push(ids);
      return new Map(ids.map((id) => [id, `title ${id}`]));
    }, 60_000);
    await titles.refresh(["a", "b"]);
    await titles.refresh(["a", "b", "c"]);
    expect(asked).toEqual([["a", "b"], ["c"]]);
    expect(titles.get("c")).toBe("title c");
  });

  test("a failed fetch keeps the last title", async () => {
    let fail = false;
    const titles = new HerdTitles(async (ids) => {
      if (fail) throw new Error("offline");
      return new Map(ids.map((id) => [id, "first"]));
    }, 0);
    await titles.refresh(["a"]);
    fail = true;
    await titles.refresh(["a"]);
    expect(titles.get("a")).toBe("first");
  });

  test("a failed fetch waits out the interval instead of retrying every pass", async () => {
    let calls = 0;
    const titles = new HerdTitles(async () => {
      calls++;
      throw new Error("offline");
    }, 60_000);
    await titles.refresh(["a"]);
    await titles.refresh(["a"]);
    expect(calls).toBe(1);
  });
});

describe("HerdFocus", () => {
  const session = "cc-claude-focusunit";
  const socket = sessionSocketName(session);
  const tty = "/dev/ttys900";
  const SHELL = 100;
  const focusMember = member({ tmux: session, sessionId: "s1" });
  let dir = "";
  let server: net.Server;
  let herdrSocket = "";
  let herd: { focused: string; foreground: number; sent: string[]; holdSend: boolean };
  let clients: string[];
  let calls: string[][];
  const responds = (id: string, result: unknown) => JSON.stringify({ id, result }) + "\n";
  const tmux = (async (args: string[]) => {
    calls.push(args);
    onTmux();
    return { status: 0, stdout: `${clients.join("\n")}\n`, stderr: "" };
  }) as never;
  let onTmux = () => {};

  beforeAll(async () => {
    dir = fs.mkdtempSync("/tmp/hf-");
    fs.mkdirSync(tmuxSocketDir(), { recursive: true });
    fs.writeFileSync(path.join(tmuxSocketDir(), socket), "");
    herdrSocket = path.join(dir, "s.sock");
    server = net.createServer((conn) => {
      conn.on("data", (raw) => {
        const { id, method, params } = JSON.parse(String(raw));
        if (method === "session.snapshot") {
          const panes = [{ pane_id: "p1", tokens: { codecast_session: "s1" } }, { pane_id: "p2", tokens: {} }];
          conn.write(responds(id, { snapshot: { panes, workspaces: [], focused_pane_id: herd.focused } }));
        } else if (method === "pane.process_info") {
          conn.write(responds(id, { process_info: { tty, shell_pid: SHELL, foreground_process_group_id: herd.foreground } }));
        } else if (method === "pane.send_text") {
          herd.sent.push(params.text);
          if (!herd.holdSend) conn.write(responds(id, {}));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(herdrSocket, resolve));
  });

  afterAll(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(tmuxSocketDir(), socket), { force: true });
  });

  const reset = () => {
    herd = { focused: "p1", foreground: SHELL, sent: [], holdSend: false };
    clients = [];
    calls = [];
    onTmux = () => {};
  };
  afterEach(reset);
  const detaches = () => calls.filter((c) => c.includes("detach-client"));

  test("attaches and detaches on the session's own server", async () => {
    reset();
    onTmux = () => { if (herd.sent.length) clients = [tty]; };
    const focus = new HerdFocus(tmux);
    await focus.sync(herdrSocket, [focusMember]);
    expect(herd.sent).toEqual([`env -u TMUX tmux '-L' '${socket}' 'attach-session' '-f' 'ignore-size' '-t' '=${session}'\r`]);
    herd.focused = "p2";
    await focus.sync(herdrSocket, [focusMember]);
    expect(detaches()).toEqual([["-L", socket, "detach-client", "-t", tty]]);
  });

  test("a pane already holding a client is adopted, and nothing is typed into it", async () => {
    reset();
    herd.foreground = 200;
    clients = [tty];
    const focus = new HerdFocus(tmux);
    await focus.sync(herdrSocket, [focusMember]);
    expect(herd.sent).toEqual([]);
    herd.focused = "p2";
    await focus.sync(herdrSocket, [focusMember]);
    expect(detaches()).toEqual([["-L", socket, "detach-client", "-t", tty]]);
  });

  test("nothing is typed while another program holds the terminal", async () => {
    reset();
    herd.foreground = 200;
    await new HerdFocus(tmux).sync(herdrSocket, [focusMember]);
    expect(herd.sent).toEqual([]);
  });

  test("a line whose reply came late is not typed again until the shell has had time, and then it is", async () => {
    reset();
    herd.holdSend = true;
    const focus = new HerdFocus(tmux);
    await expect(focus.sync(herdrSocket, [focusMember])).rejects.toThrow("timed out");
    await focus.sync(herdrSocket, [focusMember]);
    expect(herd.sent).toHaveLength(1);
    herd.holdSend = false;
    onTmux = () => { clients = [tty]; };
    const later = Date.now() + 61_000;
    const clock = spyOn(Date, "now").mockImplementation(() => later);
    try {
      await focus.sync(herdrSocket, [focusMember]);
      expect(herd.sent).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  }, 10_000);

  test("an attach never confirmed is typed again only after the shell has had time to read it", async () => {
    reset();
    let now = 1_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    onTmux = () => { now += 11_000; };
    try {
      const focus = new HerdFocus(tmux);
      await expect(focus.sync(herdrSocket, [focusMember])).rejects.toThrow("did not attach");
      await focus.sync(herdrSocket, [focusMember]);
      expect(herd.sent).toHaveLength(1);
      now += 61_000;
      await expect(focus.sync(herdrSocket, [focusMember])).rejects.toThrow("did not attach");
      expect(herd.sent).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("listCodecastPanesComplete", () => {
  const failed = (async () => ({ status: null, stdout: "", stderr: "" })) as never;
  const server = { pid: 2, ppid: 1, uid: process.getuid?.(), command: "/opt/bin/tmux -L cast-cc-claude-a new-session -d" };

  test("a failed listing with a server alive is incomplete, not empty", async () => {
    await expect(listCodecastPanesComplete(failed, async () => [server] as never)).rejects.toThrow("incomplete");
  });

  test("a server Linux has retitled still counts as alive", async () => {
    await expect(listCodecastPanesComplete(failed, async () => [{ ...server, command: "tmux: server (/tmp/tmux-1000/default)" }] as never)).rejects.toThrow("incomplete");
  });

  test("a process table that came back empty proves nothing", async () => {
    await expect(listCodecastPanesComplete(failed, async () => [])).rejects.toThrow("incomplete");
  });

  test("a failed listing with no server alive means nothing is running", async () => {
    expect(await listCodecastPanesComplete(failed, async () => [{ ...server, command: "/bin/zsh" }] as never)).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { HerdTitles, herdMembers, planHerd, type HerdMember } from "./herdMirror.js";
import type { HerdrPane, HerdrSnapshot } from "./herdr.js";
import type { CodecastPane } from "./tmux.js";

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

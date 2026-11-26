// The Close button's tooltip, mounted on the real store: it reads the trigger
// roster and the session's own facts when it opens, and says the brief's line
// for that session.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/inbox" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { SessionCloseTip } = await import("./SessionCloseTip");
type InboxSession = import("../../store/inboxStore").InboxSession;

const NOW = Date.now();
const settled = { _id: "c1", message_count: 12, agent_status: "idle", updated_at: NOW - 60 * 60_000, last_heartbeat: NOW - 1000 } as unknown as InboxSession;
const armed = (id: string, conv: string) => ({ _id: id, title: id, prompt: id, status: "scheduled", schedule_type: "once", originating_conversation_id: conv });

const before = (useInboxStore.getState() as any).agentTasks;
afterEach(() => { useInboxStore.setState({ agentTasks: before } as any); });

async function tip(session: InboxSession): Promise<string> {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => { root.render(<SessionCloseTip session={session} />); });
  const text = host.textContent ?? "";
  await act(async () => { root.unmount(); });
  return text;
}

describe("SessionCloseTip", () => {
  test("a running session", async () => {
    expect(await tip({ ...settled, agent_status: "working", updated_at: NOW - 1000 } as InboxSession)).toBe("Close: hides it, back when it's done or asks");
  });

  async function withKids(kids: Record<string, Record<string, unknown>>, run: () => Promise<void>) {
    const sessions = useInboxStore.getState().sessions;
    const rows = Object.fromEntries(Object.entries(kids).map(([id, k]) => [id, { ...settled, _id: id, session_id: id, is_subagent: true, parent_conversation_id: "c1", ...k }]));
    useInboxStore.setState({ sessions: { ...sessions, ...rows } } as any);
    try { await run(); } finally { useInboxStore.setState({ sessions } as any); }
  }

  test("an idle lead whose subagent is mid-turn", async () => {
    await withKids({ "agent-a0a0a0737562": { agent_status: "working", updated_at: NOW - 1000 } }, async () => {
      expect(await tip(settled)).toBe("Close: hides it, back when it's done or asks");
    });
  });

  test("an idle lead whose spawned child is mid-turn stops alone: the child keeps running", async () => {
    await withKids({ "ca19ce3d-spawned": { agent_status: "working", updated_at: NOW - 1000 } }, async () => {
      expect(await tip(settled)).toBe("Close: stops it, clears it until it asks");
    });
  });

  test("an idle lead with finished subagents names them, skipping a closed one and a spawned child", async () => {
    await withKids({
      "agent-a0a0a031": {}, "agent-a0a0a032": {},
      "agent-a0a0a0636c6f736564": { inbox_dismissed_at: 5, inbox_closed_at: 5 },
      "ca19ce3d-spawned": {},
    }, async () => {
      expect(await tip(settled)).toBe("Close: stops it and the 2 agents under it, clears them until it asks");
    });
  });

  test("a session with armed triggers counts only its own", async () => {
    useInboxStore.setState({ agentTasks: { t1: armed("t1", "c1"), t2: armed("t2", "c1"), t3: armed("t3", "other") } } as any);
    expect(await tip(settled)).toBe("Close: stops it, runs its 2 triggers out of sight, back when it's done or asks");
  });

  test("a role's own session with none", async () => {
    expect(await tip({ ...settled, standing_role_id: "r1" } as InboxSession)).toBe("Close: stops it, back when it asks");
  });

  test("a session waiting on its workflow run", async () => {
    expect(await tip({ ...settled, workflow_run_id: "w1", workflow_run_status: "running" } as InboxSession)).toBe("Close: stops it, its run goes on, back when it's done or asks");
  });

  test("an ordinary finished session", async () => {
    expect(await tip(settled)).toBe("Close: stops it, clears it until it asks");
  });
});

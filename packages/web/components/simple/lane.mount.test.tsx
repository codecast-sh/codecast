// The simple lane's home and approvals, mounted on a seeded store: the
// three bands render from the store alone, an approval shows its draft and
// answers through the store's decision action, and nothing on screen uses a
// developer word.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/simple", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "HTMLInputElement", "HTMLTextAreaElement", "sessionStorage", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// After the DOM globals: react-dom reads them when it loads.
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Route, Routes } = await import("react-router");

const convex = await import("convex/react");
const starts: any[] = [];
mock.module("convex/react", () => ({
  ...convex,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => null,
  useAction: () => async () => ({ ok: false }),
  useConvex: () => ({ query: async () => undefined, watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined }) }),
}));

const { useInboxStore } = await import("../../store/inboxStore");
const { syncMetaKey } = await import("../../hooks/reconcileCrawl");
const { inboxCrawlWsKey } = await import("../../hooks/useSyncInboxSessions");
const { default: SimpleHome } = await import("../../app/simple/page");
const { default: SimpleApprovals } = await import("../../app/simple/approvals/page");
const { default: SimpleConversation } = await import("../../app/simple/c/[id]/page");
const { LANE_COPY } = await import("./lane");

const BANNED = /\b(agent|session|model|token|repo|repository|device)s?\b/i;
const NOW = Date.now();
const row = (id: string, extra: Record<string, unknown>) => ({
  _id: id, session_id: id, agent_type: "codecast", updated_at: NOW - 60_000, message_count: 2,
  is_idle: true, has_pending: false, last_user_message: null, ...extra,
});

let root: Root;
const container = () => document.getElementById("root")!;

// Store collections reach their readers a tick after a write, and under load
// that tick can be late: wait for the screen to show it rather than a fixed delay.
async function settle(ready: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!ready() && Date.now() < until) {
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

// The lane's writes are store actions; their server half is the dispatch
// side effect, captured here. A start is the store's createSession.
const dispatchOwner = {};

beforeAll(() => {
  useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
    if (action !== "createSession") return null;
    starts.push(args[0]);
    return "k".repeat(32);
  }, { owner: dispatchOwner });
  useInboxStore.setState({ currentUser: { _id: "u_me", name: "Ashot Petrosian" } } as any);
  const s = useInboxStore.getState();
  s.syncRecord("sessions", "c_wait", row("c_wait", { title: "Reply to Dana about Thursday" }));
  s.syncRecord("sessions", "c_work", row("c_work", { title: "Find flights to Lisbon", agent_status: "working" }));
  s.syncRecord("sessions", "c_done", row("c_done", { title: "Summarize the school newsletter", idle_summary: "Three dates to remember" }));
  s.syncRecord("sessions", "c_dev", row("c_dev", { title: "Refactor the parser", agent_type: "claude_code" }));
  s.syncRecord("sessionDecisions", "d1", {
    _id: "d1", conversation_id: "c_wait", session_id: "c_wait", question: "Send this reply to Dana?",
    context_md: "Hi Dana,\n\nThursday at 3 works for me. See you then.\n\nBest", blocking: true, status: "pending", created_at: NOW - 30_000,
    options: [{ label: "Approve" }, { label: "Always allow" }, { label: "Decline" }],
  } as any);
  root = createRoot(container());
});

afterAll(() => {
  useInboxStore.getState()._clearDispatch(dispatchOwner);
  act(() => root.unmount());
});

describe("simple lane", () => {
  test("home shows the bands and the approval with its draft", async () => {
    await act(async () => {
      root.render(<MemoryRouter initialEntries={["/simple"]}><Routes><Route path="/simple" element={<SimpleHome />} /></Routes></MemoryRouter>);
    });
    const text = container().textContent ?? "";
    expect(text).toMatch(/^Good (morning|afternoon|evening), Ashot|^Hello, Ashot/);
    expect(text).toContain(LANE_COPY.home.waiting);
    expect(text).toContain("Send this reply to Dana?");
    expect(text).toContain("Thursday at 3 works for me");
    expect(text).toContain(LANE_COPY.home.happening);
    expect(text).toContain("Find flights to Lisbon");
    expect(text).toContain(LANE_COPY.home.done);
    expect(text).toContain("Summarize the school newsletter");
    expect(text).not.toContain("Refactor the parser");
    expect(text).not.toMatch(BANNED);
  });

  test("an answer goes through the decision action and the card leaves", async () => {
    const approve = [...container().querySelectorAll("button")].find((b) => b.textContent === "Approve")!;
    await act(async () => { approve.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    expect(useInboxStore.getState().sessionDecisions.d1.status).toBe("answered");
    expect(useInboxStore.getState().sessionDecisions.d1.answer_index).toBe(0);
    expect(container().textContent).not.toContain("Send this reply to Dana?");
  });

  test("approvals is empty and says so plainly, but only once the list is known", async () => {
    await act(async () => {
      root.render(<MemoryRouter key="approvals" initialEntries={["/simple/approvals"]}><Routes><Route path="/simple/approvals" element={<SimpleApprovals />} /></Routes></MemoryRouter>);
    });
    // A cold cache: nothing has been read yet, so it must not claim "caught up".
    expect(container().textContent).not.toContain(LANE_COPY.approvals.empty);
    expect(container().textContent).toContain(LANE_COPY.approvals.loading);
    await act(async () => {
      useInboxStore.setState((st: any) => ({
        clientStateInitialized: true,
        syncMeta: { ...st.syncMeta, [syncMetaKey("sessions", inboxCrawlWsKey("u_me"))]: { backfilledAt: NOW } },
      }));
    });
    expect(container().textContent).toContain(LANE_COPY.approvals.empty);
    expect(container().textContent).not.toMatch(BANNED);
  });

  test("a card that needs more than one tap sends the person into the conversation", async () => {
    await act(async () => {
      useInboxStore.getState().syncRecord("sessionDecisions", "d3", {
        _id: "d3", conversation_id: "c_wait", session_id: "c_wait", question: "Which of these should I answer first?",
        kind: "multi", blocking: true, status: "pending", created_at: NOW - 10_000,
        options: [{ label: "Dana" }, { label: "Sam" }, { label: "The school" }],
      } as any);
    });
    await settle(() => (container().textContent ?? "").includes("Which of these should I answer first?"));
    const text = container().textContent ?? "";
    expect(text).toContain("Which of these should I answer first?");
    expect(text).toContain(LANE_COPY.approval.answerThere);
    expect([...container().querySelectorAll("button")].some((b) => b.textContent === "Sam")).toBe(false);
    const link = [...container().querySelectorAll("a")].find((a) => a.textContent === LANE_COPY.approval.answerThere)!;
    expect(link.getAttribute("href")).toBe("/simple/c/c_wait");
    await act(async () => { useInboxStore.getState().answerDecision("d3", { text: "dismissed in test" } as any); });
  });

  test("the composer starts a hosted conversation optimistically", async () => {
    await act(async () => {
      root.render(<MemoryRouter key="compose" initialEntries={["/simple"]}><Routes><Route path="/simple" element={<SimpleHome />} /><Route path="/simple/c/:id" element={<div id="thread" />} /></Routes></MemoryRouter>);
    });
    const box = container().querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, "What needs a reply from me this week?");
      box.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const send = container().querySelector<HTMLButtonElement>("button[aria-label='Send']")!;
    expect(send.disabled).toBe(false);
    await act(async () => { send.click(); });
    await settle(() => !!container().querySelector("#thread") && starts.length > 0);
    expect(container().querySelector("#thread")).not.toBeNull();
    expect(starts).toHaveLength(1);
    expect(starts[0].agent_type).toBe("codecast");
    expect(starts[0].first_message).toBe("What needs a reply from me this week?");
    expect(typeof starts[0].first_message_client_id).toBe("string");
    expect(starts[0].first_message_client_id.length).toBeGreaterThan(0);
    const stub = starts[0].session_id;
    expect(useInboxStore.getState().sessions[stub]?.agent_type ?? useInboxStore.getState().sessions["k".repeat(32)]?.agent_type).toBe("codecast");
  });

  test("a conversation folds its steps and shows the approval it waits on", async () => {
    const id = "j".repeat(32);
    useInboxStore.getState().syncRecord("sessions", id, row(id, { title: "Thursday with Dana" }) as any);
    useInboxStore.setState((st: any) => ({
      messages: {
        ...st.messages,
        [id]: [
          { _id: "m1", role: "user", content: "Can you answer Dana about Thursday?", timestamp: NOW - 5000 },
          { _id: "m2", role: "assistant", content: "", timestamp: NOW - 4000, tool_calls: [{ id: "t1", name: "search_mail", input: { q: "from:dana" } }, { id: "t2", name: "draft_reply", input: { to: "dana@x.org" } }] },
          { _id: "m3", role: "user", timestamp: NOW - 3500, tool_results: [{ tool_use_id: "t1", content: [1, 2, 3] }, { tool_use_id: "t2", content: "ok" }] },
          { _id: "m4", role: "assistant", content: "I drafted a reply. Want me to send it?", timestamp: NOW - 3000 },
        ],
      },
    }));
    useInboxStore.getState().syncRecord("sessionDecisions", "d2", {
      _id: "d2", conversation_id: id, session_id: id, question: "Send this reply to Dana?",
      context_md: "Thursday at 3 works.", blocking: true, status: "pending", created_at: NOW - 2000,
      options: [{ label: "Approve" }, { label: "Always allow" }, { label: "Decline" }],
    } as any);
    await act(async () => {
      root.render(<MemoryRouter key="thread" initialEntries={[`/simple/c/${id}`]}><Routes><Route path="/simple/c/:id" element={<SimpleConversation />} /></Routes></MemoryRouter>);
    });
    const text = container().textContent ?? "";
    expect(text).toContain("Can you answer Dana about Thursday?");
    expect(text).toContain("Read 3 emails from Dana");
    expect(text).toContain("Drafted a reply to Dana");
    expect(text).toContain("I drafted a reply. Want me to send it?");
    expect(text).toContain("Send this reply to Dana?");
    expect(text).toContain("Thursday at 3 works.");
    expect(text).not.toMatch(BANNED);

    const box = container().querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Make it a bit warmer");
      box.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => { container().querySelector<HTMLButtonElement>("button[aria-label='Send']")!.click(); });
    const pending = useInboxStore.getState().pendingMessages[id] ?? [];
    expect(pending.some((m: any) => m.content === "Make it a bit warmer")).toBe(true);
    expect(container().textContent).toContain("Make it a bit warmer");
  });

  test("a failed send offers to try again and stops looking busy", async () => {
    const id = "f".repeat(32);
    useInboxStore.getState().syncRecord("sessions", id, row(id, { title: "Lunch with Sam" }) as any);
    const s = useInboxStore.getState();
    const clientId = s.addOptimisticMessage(id, "Find a time for lunch with Sam");
    s.markOptimisticAsFailed(id, clientId);
    await act(async () => {
      root.render(<MemoryRouter key="failed" initialEntries={[`/simple/c/${id}`]}><Routes><Route path="/simple/c/:id" element={<SimpleConversation />} /></Routes></MemoryRouter>);
    });
    expect(container().textContent).toContain(LANE_COPY.transcript.didntSend.trim());
    expect(container().querySelector("[role='status']")).toBeNull();
    expect(container().querySelector(".sl-you.is-pending")).toBeNull();
  });
});

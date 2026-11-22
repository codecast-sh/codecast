// "Dismiss all N" (the old-sessions prompt in the inbox panel) clears dozens of
// sessions in one press. The press opens the shared confirm review
// (components/consequential) and dismisses nothing by itself; the review's
// confirm dismisses exactly the counted set in one dispatch, as one undoable
// gesture whose toast offers Undo; the undo sends the clears back for exactly
// those rows (ct-98161). The server half is convex/dismissStale.exactSet.test.ts.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";

const toasts: Array<{ title: string; opts: any }> = [];
const realSonner = await import("sonner");
const fakeToast = Object.assign((title: string, opts: any = {}) => {
  toasts.push({ title, opts });
  return title;
}, realSonner.toast, { success: (title: string, opts: any = {}) => { toasts.push({ title, opts }); return title; } });
mock.module("sonner", () => ({ ...realSonner, toast: fakeToast }));

const { JSDOM } = await import("jsdom");
const d = new JSDOM('<div id="root"></div>', { url: "https://local.codecast.sh/", pretendToBeVisual: true });
const w = d.window as any;
const restoreGlobals = replaceGlobals({
  window: w, document: w.document, navigator: w.navigator, IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle.bind(w),
  DocumentFragment: w.DocumentFragment, KeyboardEvent: w.KeyboardEvent, Event: w.Event, CustomEvent: w.CustomEvent, NodeFilter: w.NodeFilter,
  localStorage: w.localStorage, requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
});
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { _resetUndoStacks, getUndoHistory } = await import("@platform/engine");
const { useInboxStore } = await import("../../store/inboxStore");
const { performUndo } = await import("../../store/undoStack");
const { StaleSessionsPrompt, staleSessionsOf } = await import("../../components/inbox/StaleSessionsPrompt");

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const cutoff = now - 30 * DAY;
const id = (n: number) => String(n).padStart(32, "s");
const row = (n: number, extra: Record<string, unknown> = {}) =>
  ({ _id: id(n), session_id: `sess-${n}`, title: `Old ${n}`, updated_at: cutoff - n * DAY, agent_type: "claude_code", message_count: 1, is_idle: true, has_pending: false, ...extra }) as any;

// Twelve old rows; row 1 is the one on screen, row 2 is pinned, row 13 is fresh.
const rows = [...Array.from({ length: 12 }, (_, i) => row(i + 1)), row(13, { updated_at: now })];
rows[1] = row(2, { is_pinned: true });
const OPEN = id(1);

let sent: Array<{ action: string; args: any[]; patches: any; result: any }> = [];
const owner = Symbol("dismiss-stale");
const root = createRoot(w.document.getElementById("root"));
const q = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
const click = (sel: string) => React.act(async () => q(sel)!.click());
const dismissed = () => Object.values<any>(useInboxStore.getState().sessions).filter((s) => !!s.inbox_dismissed_at).map((s) => s._id).sort();

beforeEach(() => {
  _resetUndoStacks();
  sent = [];
  toasts.length = 0;
  useInboxStore.setState({
    sessions: Object.fromEntries(rows.map((r) => [r._id, { ...r }])),
    conversations: Object.fromEntries(rows.map((r) => [r._id, { _id: r._id, title: r.title }])),
    pending: {},
    clientState: {},
  } as any);
  useInboxStore.getState()._setDispatch(async (action: string, args: any[], patches: any, result: any) => {
    sent.push({ action, args, patches, result });
    return null;
  }, { owner });
});
afterEach(() => useInboxStore.getState()._clearDispatch(owner));
afterAll(async () => {
  await React.act(async () => root.unmount());
  restoreGlobals();
});

describe("Dismiss all old sessions", () => {
  test("the counted set leaves out the open session, pinned and fresh rows", () => {
    const set = staleSessionsOf(Object.values(useInboxStore.getState().sessions) as any, OPEN, cutoff).map((s) => s._id);
    expect(set).not.toContain(OPEN);
    expect(set.sort()).toEqual(Array.from({ length: 10 }, (_, i) => id(i + 3)).sort());
  });

  test("the button opens the review and dismisses nothing; the review's confirm dismisses exactly the counted set, with Undo", async () => {
    const stale = staleSessionsOf(Object.values(useInboxStore.getState().sessions) as any, OPEN, cutoff);
    const ids = stale.map((s) => s._id).sort();
    let snoozed = 0;
    await React.act(async () => root.render(React.createElement(StaleSessionsPrompt, { sessions: stale, since: cutoff, onSnooze: () => snoozed++, list: () => null })));
    expect(q("[data-stale-dismiss-all]")!.textContent).toBe("Dismiss all 10");

    await click("[data-stale-dismiss-all]");
    expect({ dismissed: dismissed(), sent: sent.length }).toEqual({ dismissed: [], sent: 0 });
    expect(q('[data-switch-figure="leave the inbox"]')!.textContent).toBe("10");

    await click("[data-switch-confirm]");
    expect(dismissed()).toEqual(ids);
    // One dispatch, carrying exactly the counted ids and the stamp the rows got.
    expect(sent.map((s) => s.action)).toEqual(["markSessionsDismissed"]);
    expect([...sent[0]!.args[0]].sort()).toEqual(ids);
    expect(useInboxStore.getState().sessions[ids[0]!]!.inbox_dismissed_at).toBe(sent[0]!.result);
    expect(snoozed).toBe(1);

    // In the store's own history, and its toast offers Undo with the same count.
    expect(getUndoHistory().items.map((i) => i.label)).toEqual(["Dismissed 10 old sessions (still searchable)"]);
    expect(toasts.map((t) => [t.title, t.opts.action?.label])).toEqual([["Dismissed 10 old sessions", "Undo"]]);

    // The toast's Undo brings back exactly those rows and sends their clears.
    sent = [];
    toasts[0]!.opts.action.onClick();
    expect(dismissed()).toEqual([]);
    expect(sent.map((s) => s.action)).toEqual(["applyUndoPatches"]);
    const undo = sent[0]!.patches.conversations;
    expect(Object.keys(undo).sort()).toEqual(ids);
    for (const fields of Object.values<any>(undo)) expect(fields).toEqual({ inbox_dismissed_at: null });
  });

  test("the app's own undo takes the sweep back too", async () => {
    const stale = staleSessionsOf(Object.values(useInboxStore.getState().sessions) as any, OPEN, cutoff);
    await React.act(async () => root.render(React.createElement(StaleSessionsPrompt, { sessions: stale, since: cutoff, onSnooze: () => {}, list: () => null })));
    await click("[data-stale-dismiss-all]");
    await click("[data-switch-confirm]");
    expect(dismissed().length).toBe(10);
    performUndo();
    expect(dismissed()).toEqual([]);
  });
});

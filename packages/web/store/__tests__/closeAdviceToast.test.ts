import { afterAll, beforeAll, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { toast } from "sonner";
import { _resetUndoStacks, getUndoHistory, setUndoNotifier } from "@platform/engine";
import { AFTER_CLOSE_CALL_MS, type AfterCloseResult } from "@codecast/shared/contracts/closeKind";
import { placeInboxRows, useInboxStore } from "../inboxStore";
import { CLOSE_ADVICE_CLASS, CODECAST_UNDO_NOTIFIER, closeAdviceTakesTriggers, UNDO_RECEIPT_CLASS, UNDO_RECEIPT_MS, undoEntry, undoEntryToastId } from "../undoStack";
import { animatedCloseSessions, animatedHideSessions, killWithCloseAdvice } from "../undoActions";
import { bindCloseAdviceCall, CLOSE_ADVICE_CARD_MS, CLOSE_ADVICE_HOLD_MS, type PendingCloseAdvice } from "../../lib/closeAdviceBar";
import * as undoTimeline from "../../lib/undoTimelineOpen";
import { composerToasterLiftNow } from "../../lib/composerToasterLift";

// A Close or Kill asks close advice beside the gesture; the gesture's own
// receipt (unchanged while the verdict is pending, only held longer) turns
// into a card when a closed session asked the person something.
const ME = "u".repeat(32);
const TEAM = "t".repeat(32);
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

type Shown = { id?: unknown; title?: unknown; description?: any; className?: string; duration?: number; onAutoClose?: (t: any) => void; onDismiss?: (t: any) => void; action?: { label?: unknown; onClick?: (e: any) => void }; cancel?: { label?: unknown; onClick?: (e: any) => void } };
let mark = 0;
/** The newest toast of an entry: its receipt, or the card raised in its place. */
const latest = (id: string) => (toast.getHistory() as Shown[]).slice(mark).filter((t) => t.id === id || String(t.id).startsWith(`${id}:`)).at(-1);
const entryToast = () => latest(undoEntryToastId(getUndoHistory().items[0]!.id));
const text = (node: any): string => (node == null || typeof node === "boolean" ? "" : typeof node === "string" ? node : Array.isArray(node) ? node.map(text).filter(Boolean).join("|") : text(node.props?.children));

let calls: string[][] = [];
let gestures: string[] = [];
let answer: (results: AfterCloseResult[] | null) => void = () => {};
/** Every call's own answer, in call order. */
let answers: Array<(results: AfterCloseResult[] | null) => void> = [];
const flush = () => new Promise((r) => setTimeout(r, 0));

// A quiet session its agent pinned done: the inbox files it under Done.
const T = Date.now() - 60_000;
const doneRow = (id: string, title: string, extra: any = {}) => ({
  _id: id, title, updated_at: T, user_id: ME, team_id: TEAM, message_count: 3, thread_state_status: "done", thread_state_at: T + 1, last_turn_at: T - 10, ...extra,
});

function seed(opts: { feature?: boolean; rows?: Record<string, any> } = {}) {
  const row = (id: string, title: string, extra: any = {}) => doneRow(id, title, extra);
  const rows = opts.rows ?? { [A]: row(A, "Owners redesign"), [B]: row(B, "Eval audit"), [C]: row(C, "Stripe SDK") };
  useInboxStore.setState({
    pending: {},
    currentSessionId: null,
    clientState: { ui: { active_team_id: TEAM } },
    currentUser: { _id: ME },
    teams: [{ _id: TEAM, features: { close_advice: opts.feature ?? true } }],
    sessions: rows,
    conversations: Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, { ...r }])),
  } as any);
}

const hadRaf = "requestAnimationFrame" in globalThis;
let dismissed: ReturnType<typeof spyOn>;
beforeAll(() => {
  if (!hadRaf) (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => { cb(0); return 0; };
  dismissed = spyOn(toast, "dismiss");
});
afterAll(() => {
  if (!hadRaf) delete (globalThis as any).requestAnimationFrame;
  dismissed.mockRestore();
  bindCloseAdviceCall(null);
});

beforeEach(() => {
  setUndoNotifier(CODECAST_UNDO_NOTIFIER);
  _resetUndoStacks();
  undoTimeline.close();
  dismissed.mockClear();
  mark = toast.getHistory().length;
  calls = [];
  gestures = [];
  answers = [];
  bindCloseAdviceCall((sessions, gesture) => {
    calls.push(sessions);
    gestures.push(gesture);
    return new Promise((resolve) => {
      answer = (results) => resolve({ results: results ?? [] });
      answers.push(answer);
    });
  });
  seed();
});

describe("asking close advice", () => {
  test("a Close of rows outside Needs You asks once; the receipt is today's, held longer", async () => {
    await animatedCloseSessions([A, B]);
    expect(calls).toEqual([[A, B]]);
    const shown = entryToast()!;
    expect(shown.title).toBe("Closed 2 sessions");
    expect(shown.className).toBe(UNDO_RECEIPT_CLASS);
    expect(shown.action?.label).toBe("Undo");
    expect(shown.duration).toBe(UNDO_RECEIPT_MS + CLOSE_ADVICE_HOLD_MS);
  });

  test("a row in Needs You is never sent, nor one the person filed Done", async () => {
    seed({
      rows: {
        // Filed under Needs You (the person put it there).
        [A]: doneRow(A, "Asks", { thread_state_status: null, inbox_rest: "needs_input", inbox_rest_at: T + 5 }),
        // The person filed it Done themselves.
        [B]: doneRow(B, "Filed", { inbox_rest: "done", inbox_rest_at: T + 5 }),
        [C]: doneRow(C, "Quiet"),
      },
    });
    await animatedCloseSessions([A, B, C]);
    expect(calls).toEqual([[C]]);
  });

  test("a row the inbox files under Working is never sent: it has asked nothing yet", async () => {
    const working = { thread_state_status: null, is_idle: false, agent_status: "working", status: "active", updated_at: Date.now() - 1000, last_turn_at: undefined };
    seed({ rows: { [A]: doneRow(A, "Running", working), [C]: doneRow(C, "Quiet") } });
    expect(placeInboxRows(useInboxStore.getState() as any, {}).placements.get(A)?.bucket).toBe("working");
    await animatedCloseSessions([A, C]);
    expect(calls).toEqual([[C]]);
  });

  test("a teammate's session is never sent", async () => {
    seed({ rows: { [A]: doneRow(A, "Theirs", { user_id: "x".repeat(32) }) } });
    await animatedCloseSessions([A]);
    expect(calls).toEqual([]);
    expect(entryToast()?.duration).toBe(UNDO_RECEIPT_MS);
  });

  test("with the feature off nothing is asked and the receipt is today's", async () => {
    seed({ feature: false });
    await animatedCloseSessions([A]);
    expect(calls).toEqual([]);
    expect(entryToast()?.duration).toBe(UNDO_RECEIPT_MS);
  });
});

describe("the verdict on the bar", () => {
  test("one Close that asked becomes a card: title, reason, Undo and Open", async () => {
    await animatedCloseSessions([A]);
    answer([{ session: A, verdict: "needs_you", reason: "Decide whether to file both follow-ups as tasks" }]);
    await flush();
    const card = entryToast()!;
    expect(card.title).toBe("Closed “Owners redesign”");
    expect(card.className).toBe(CLOSE_ADVICE_CLASS);
    expect(text(card.description)).toBe("Decide whether to file both follow-ups as tasks");
    expect(card.cancel?.label).toBe("Undo");
    expect(card.action?.label).toBe("Open");
  });

  test("Open brings the session back and opens it, with no Undid notice", async () => {
    await animatedCloseSessions([A]);
    answer([{ session: A, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    const before = toast.getHistory().length;
    entryToast()!.action!.onClick!({ preventDefault() {} });
    const s = useInboxStore.getState() as any;
    expect(s.sessions[A].inbox_dismissed_at ?? null).toBe(null);
    expect(s.currentSessionId).toBe(A);
    expect((toast.getHistory() as Shown[]).slice(before).some((t) => String(t.title).startsWith("Undid"))).toBe(false);
    // Open opens it; it files nothing.
    expect(s.sessions[A].inbox_rest ?? null).toBe(null);
  });

  test("Open and Keep K after a Kill say which triggers the kill canceled came back", async () => {
    const canceled = (id: string, owner: string, title: string) => ({ _id: id, title, status: "completed", canceled_on_kill_at: T, originating_conversation_id: owner });
    useInboxStore.setState({ agentTasks: { t1: canceled("t1", A, "Nightly"), t2: canceled("t2", C, "Hourly") } } as any);
    const rearmed = (from: number) => (toast.getHistory() as Shown[]).slice(from).map((t) => String(t.title)).filter((t) => t.startsWith("Re-armed"));
    await animatedHideSessions([A], "kill");
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    let before = toast.getHistory().length;
    entryToast()!.action!.onClick!({ preventDefault() {} });
    expect(rearmed(before)).toEqual(["Re-armed trigger \"Nightly\" — its kill canceled it"]);
    useInboxStore.setState({ agentTasks: { t1: canceled("t1", A, "Nightly"), t2: canceled("t2", C, "Hourly") } } as any);
    await animatedHideSessions([A, B, C], "kill");
    answer([{ session: A, verdict: "needs_you", reason: "Reply" }, { session: C, verdict: "needs_you", reason: "Pick" }]);
    await flush();
    before = toast.getHistory().length;
    entryToast()!.action!.onClick!({ preventDefault() {} });
    expect(rearmed(before)).toEqual(["Re-armed 2 triggers the kill canceled"]);
  });

  test("a Kill that asked says Killed", async () => {
    await animatedHideSessions([A], "kill");
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    expect(entryToast()?.title).toBe("Killed “Owners redesign”");
  });

  test("a Kill's card keeps the receipt's note that the agent stays stopped on undo", async () => {
    await animatedHideSessions([A], "kill");
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    expect(text(entryToast()!.description)).toBe("Pick a sort order|Agent stays stopped on undo");
  });

  test("a bulk Kill's card says the agents stay stopped", async () => {
    await animatedHideSessions([A, B], "kill");
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }, { session: B, verdict: "needs_you", reason: "Reopen Chrome" }]);
    await flush();
    expect(text(entryToast()!.description)).toBe("2 asked you something|Agents stay stopped on undo");
  });

  test("a Close's card carries no stopped note", async () => {
    await animatedCloseSessions([A]);
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    expect(text(entryToast()!.description)).toBe("Pick a sort order");
  });

  test("the dock's Kill asks close advice too, and its card says Killed", async () => {
    killWithCloseAdvice(A);
    expect(calls).toEqual([[A]]);
    expect(gestures).toEqual(["kill"]);
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    expect(entryToast()?.title).toBe("Killed “Owners redesign”");
  });

  test("a close verdict leaves today's receipt, back on its own clock", async () => {
    await animatedCloseSessions([A]);
    answer([{ session: A, verdict: "close" }]);
    await flush();
    const shown = entryToast()!;
    expect(shown.className).toBe(UNDO_RECEIPT_CLASS);
    expect(shown.title).toBe("Closed “Owners redesign”");
    expect(shown.duration).toBeLessThanOrEqual(UNDO_RECEIPT_MS);
  });

  test("an error leaves today's receipt", async () => {
    await animatedCloseSessions([A]);
    answer(null);
    await flush();
    expect(entryToast()?.className).toBe(UNDO_RECEIPT_CLASS);
  });

  test("a verdict after the bar was undone lands nowhere", async () => {
    await animatedCloseSessions([A]);
    const entry = getUndoHistory().items[0]!.id;
    entryToast()!.action!.onClick!({ preventDefault() {} });
    answer([{ session: A, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    expect(latest(undoEntryToastId(entry))?.className).toBe(UNDO_RECEIPT_CLASS);
  });

  test("bulk: Closed N sessions, K asked you something; Keep K brings back only those", async () => {
    await animatedCloseSessions([A, B, C]);
    answer([
      { session: A, verdict: "needs_you", reason: "Reply" },
      { session: B, verdict: "close" },
      { session: C, verdict: "needs_you", reason: "Pick" },
    ]);
    await flush();
    const card = entryToast()!;
    expect(card.title).toBe("Closed 3 sessions");
    expect(text(card.description)).toBe("2 asked you something");
    expect(card.action?.label).toBe("Keep 2");
    card.action!.onClick!({ preventDefault() {} });
    const s = useInboxStore.getState().sessions as any;
    expect(s[A].inbox_dismissed_at ?? null).toBe(null);
    expect(s[C].inbox_dismissed_at ?? null).toBe(null);
    expect(s[B].inbox_dismissed_at).toBeTruthy();
    // They land in Needs You, so the person sees which ones asked.
    const bucket = (id: string) => placeInboxRows(useInboxStore.getState() as any, {}).placements.get(id)?.bucket;
    expect([s[A].inbox_rest, s[C].inbox_rest]).toEqual(["needs_input", "needs_input"]);
    expect([bucket(A), bucket(C)]).toEqual(["needs_input", "needs_input"]);
    expect(s[B].inbox_rest ?? null).toBe(null);
    // One undo takes the whole Keep back.
    expect(getUndoHistory().items[0]!.label).toBe("Kept 2 sessions");
  });

  test("the server is told the gesture: a Close is close, a Kill is kill", async () => {
    await animatedCloseSessions([A]);
    await animatedHideSessions([B], "kill");
    expect(gestures).toEqual(["close", "kill"]);
  });

  test("bulk with one that asked: the single card naming it", async () => {
    await animatedCloseSessions([A, B, C]);
    answer([{ session: B, verdict: "needs_you", reason: "Reopen Chrome" }]);
    await flush();
    const card = entryToast()!;
    expect(card.title).toBe("Closed “Eval audit” and 2 more");
    expect(card.action?.label).toBe("Open");
  });

  test("a Kill that canceled triggers shows one toast: the ask, then the triggers line", async () => {
    const { advice } = await animatedHideSessions([A], "kill");
    // The kill's triggers notice arrives first and shows on its own…
    expect(closeAdviceTakesTriggers(advice, "Also canceled trigger \"Nightly\"", "kill-triggers-t")).toBe(false);
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    // …then the card takes its line and takes it down.
    expect(text(entryToast()!.description)).toBe("Pick a sort order|Also canceled trigger \"Nightly\"|Agent stays stopped on undo");
    expect(dismissed).toHaveBeenCalledWith("kill-triggers-t");
  });

  test("a triggers line that comes after the card joins it", async () => {
    const { advice } = await animatedHideSessions([A], "kill");
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    expect(closeAdviceTakesTriggers(advice, "Also canceled 2 triggers bound to this session", "kill-triggers-u")).toBe(true);
    expect(text(entryToast()!.description)).toBe("Pick a sort order|Also canceled 2 triggers bound to this session|Agent stays stopped on undo");
  });

  test("a later Kill of a session an earlier Close closed shows its triggers on their own, never on that card", async () => {
    await animatedCloseSessions([A]);
    const closed = getUndoHistory().items[0]!.id;
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    // Killed from the Closed shelf: the person filed it, so nothing is asked.
    const { ids, advice } = await animatedHideSessions([A], "kill");
    expect(ids).toEqual([A]);
    expect(advice).toBe(null);
    expect(closeAdviceTakesTriggers(advice, "Also canceled trigger \"Nightly\"", "kill-triggers-shelf")).toBe(false);
    expect(text(latest(undoEntryToastId(closed))!.description)).toBe("Pick a sort order");
  });
});

// sonner takes a toast down on its own buttons without calling onDismiss, and
// the Close entry stays on the undo stack after Open or Keep: the card's own
// press has to let go of everything it held.
describe("after the card's answers", () => {
  const had = { window: (globalThis as any).window, document: (globalThis as any).document };
  // A phone-width window with a composer whose top is 760px down.
  beforeEach(() => {
    const composer = { closest: () => ({ getBoundingClientRect: () => ({ top: 760 }) }) };
    (globalThis as any).window = { innerWidth: 402, innerHeight: 874 };
    (globalThis as any).document = { querySelector: (sel: string) => (sel === "[data-composer-field]" ? composer : null) };
  });
  afterAll(() => {
    (globalThis as any).window = had.window;
    (globalThis as any).document = had.document;
  });

  /** The Kill's own close advice, for its triggers line. */
  let killAdvice: PendingCloseAdvice | null = null;
  const card = async (ids: string[], asked: AfterCloseResult[], verb: "close" | "kill" = "close") => {
    if (verb === "close") await animatedCloseSessions(ids);
    else killAdvice = (await animatedHideSessions(ids, "kill")).advice;
    expect(composerToasterLiftNow()).toBe(874 - 760 + 8);
    answer(asked);
    await flush();
    return entryToast()!;
  };

  test("Open lets go: the lift drops and a later Kill's triggers notice shows on its own", async () => {
    const shown = await card([A], [{ session: A, verdict: "needs_you", reason: "Reply" }], "kill");
    shown.action!.onClick!({ preventDefault() {} });
    expect(composerToasterLiftNow()).toBeNull();
    expect(closeAdviceTakesTriggers(killAdvice, "Also canceled trigger \"Nightly\"", "kill-triggers-later")).toBe(false);
  });

  test("Keep K lets go the same way", async () => {
    const shown = await card([A, B, C], [
      { session: A, verdict: "needs_you", reason: "Reply" },
      { session: C, verdict: "needs_you", reason: "Pick" },
    ], "kill");
    expect(shown.action?.label).toBe("Keep 2");
    shown.action!.onClick!({ preventDefault() {} });
    expect(composerToasterLiftNow()).toBeNull();
    expect(closeAdviceTakesTriggers(killAdvice, "Also canceled 2 triggers bound to this session", "kill-triggers-later")).toBe(false);
  });

  test("two overlapping gestures: the lift holds while either toast is up", async () => {
    await animatedCloseSessions([A]);
    const first = getUndoHistory().items[0]!.id;
    await animatedCloseSessions([B]);
    const lifted = 874 - 760 + 8;
    expect(composerToasterLiftNow()).toBe(lifted);
    // B asked: its card is up.
    answers[1]!([{ session: B, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    // A asked nothing; its receipt drains and comes down.
    answers[0]!([{ session: A, verdict: "close" }]);
    await flush();
    latest(undoEntryToastId(first))!.onAutoClose?.({} as any);
    expect(composerToasterLiftNow()).toBe(lifted);
    // B's card comes down: the toaster goes back to its place.
    entryToast()!.onDismiss?.({} as any);
    expect(composerToasterLiftNow()).toBeNull();
  });

  test("the card's Undo lets go too", async () => {
    const shown = await card([A], [{ session: A, verdict: "needs_you", reason: "Reply" }], "kill");
    shown.cancel!.onClick!({ preventDefault() {} });
    expect(composerToasterLiftNow()).toBeNull();
    expect(closeAdviceTakesTriggers(killAdvice, "x", "kill-triggers-later")).toBe(false);
  });
});

describe("while the interactive undo timeline is open", () => {
  test("no receipt; a needs-you verdict still shows the card", async () => {
    undoTimeline.open("interactive");
    await animatedCloseSessions([A]);
    expect(entryToast()).toBeUndefined();
    answer([{ session: A, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    const card = entryToast()!;
    expect(card.className).toBe(CLOSE_ADVICE_CLASS);
    expect(card.title).toBe("Closed “Owners redesign”");
    expect(card.cancel?.label).toBe("Undo");
  });

  test("a Kill's triggers notice made behind the timeline joins the card, which takes the notice down: one toast", async () => {
    undoTimeline.open("interactive");
    const { advice } = await animatedHideSessions([A], "kill");
    // The pending advice is tracked from the gesture, so it takes the line.
    expect(closeAdviceTakesTriggers(advice, "Also canceled trigger \"Nightly\"", "kill-triggers-behind")).toBe(false);
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    expect(text(entryToast()!.description)).toBe("Pick a sort order|Also canceled trigger \"Nightly\"|Agent stays stopped on undo");
    expect(dismissed).toHaveBeenCalledWith("kill-triggers-behind");
  });

  test("a close verdict stays silent", async () => {
    undoTimeline.open("interactive");
    await animatedCloseSessions([A]);
    answer([{ session: A, verdict: "close" }]);
    await flush();
    expect(entryToast()).toBeUndefined();
  });
});

test("the server stops each advice call seconds before the receipt stops waiting for it", () => {
  expect(AFTER_CLOSE_CALL_MS + 3000).toBeLessThanOrEqual(UNDO_RECEIPT_MS + CLOSE_ADVICE_HOLD_MS);
});

describe("the timeline opening over a needs-you card", () => {
  for (const mode of ["interactive", "peek"] as const) {
    test(`${mode}: the card stays up, and still takes its Kill's triggers line`, async () => {
      const { advice } = await animatedHideSessions([A], "kill");
      answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
      await flush();
      const entry = latest(undoEntryToastId(getUndoHistory().items[0]!.id))!;
      expect(entry.className).toBe(CLOSE_ADVICE_CLASS);
      dismissed.mockClear();
      undoTimeline.open(mode);
      expect(dismissed).not.toHaveBeenCalledWith(entry.id);
      expect(closeAdviceTakesTriggers(advice, "Also canceled trigger \"Nightly\"", "kill-triggers-open")).toBe(true);
      // Undone from the timeline, the card comes down with its entry.
      undoEntry(getUndoHistory().items[0]!.id);
      expect(dismissed).toHaveBeenCalledWith(entry.id);
    });
  }
});

describe("the timeline opening after a gesture, before its verdict", () => {
  for (const mode of ["interactive", "peek"] as const) {
    test(`${mode}: the receipt comes down, and a needs-you verdict still shows the card`, async () => {
      await animatedCloseSessions([A]);
      const receipt = entryToast()!;
      undoTimeline.open(mode);
      // sonner calls onDismiss for a toast taken down in code.
      receipt.onDismiss?.({} as any);
      undoTimeline.close();
      answer([{ session: A, verdict: "needs_you", reason: "Reply" }]);
      await flush();
      const card = entryToast()!;
      expect(card.className).toBe(CLOSE_ADVICE_CLASS);
      expect(card.title).toBe("Closed “Owners redesign”");
    });
  }

  test("a Kill's triggers line that came before the timeline opened joins the card", async () => {
    const { advice } = await animatedHideSessions([A], "kill");
    expect(closeAdviceTakesTriggers(advice, "Also canceled trigger \"Nightly\"", "kill-triggers-peek")).toBe(false);
    const receipt = entryToast()!;
    undoTimeline.open("peek");
    receipt.onDismiss?.({} as any);
    answer([{ session: A, verdict: "needs_you", reason: "Pick" }]);
    await flush();
    expect(text(entryToast()!.description)).toBe("Pick|Also canceled trigger \"Nightly\"|Agent stays stopped on undo");
    expect(dismissed).toHaveBeenCalledWith("kill-triggers-peek");
  });

  test("a receipt the person dismissed still lands nowhere", async () => {
    await animatedCloseSessions([A]);
    entryToast()!.onDismiss?.({} as any);
    answer([{ session: A, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    expect(entryToast()?.className).toBe(UNDO_RECEIPT_CLASS);
  });

  test("an entry undone from the timeline before its verdict shows no card", async () => {
    await animatedCloseSessions([A]);
    const receipt = entryToast()!;
    undoTimeline.open("interactive");
    receipt.onDismiss?.({} as any);
    // The timeline's row Undo.
    undoEntry(getUndoHistory().items[0]!.id);
    answer([{ session: A, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    expect((toast.getHistory() as Shown[]).slice(mark).some((t) => t.className === CLOSE_ADVICE_CLASS)).toBe(false);
  });
});

describe("a verdict that lands after the receipt's usual life", () => {
  test("hands the receipt back to sonner's timer rather than taking it down", async () => {
    await animatedCloseSessions([A]);
    const entry = getUndoHistory().items[0]!.id;
    const realNow = Date.now;
    const late = realNow() + UNDO_RECEIPT_MS + 1000;
    Date.now = () => late;
    try {
      answer([{ session: A, verdict: "close" }]);
      await flush();
    } finally {
      Date.now = realNow;
    }
    const shown = latest(undoEntryToastId(entry))!;
    expect(shown.className).toBe(UNDO_RECEIPT_CLASS);
    expect(shown.duration).toBe(1);
    expect(dismissed).not.toHaveBeenCalledWith(undoEntryToastId(entry));
  });
});

// sonner keeps an updated toast where it was in the stack, and the collapsed
// stack hides every toast but the front one: a card raised as an update of an
// older receipt would sit unseen behind a newer toast.
describe("the card is a toast of its own, in front", () => {
  const front = () => (toast.getHistory() as Shown[]).at(-1)!;

  test("Close A, Close B, A's verdict lands: A's card is the front toast and A's receipt is retired", async () => {
    await animatedCloseSessions([A]);
    const receiptA = undoEntryToastId(getUndoHistory().items[0]!.id);
    await animatedCloseSessions([B]);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    expect(front().title).toBe("Closed “Owners redesign”");
    expect(front().className).toBe(CLOSE_ADVICE_CLASS);
    expect(front().id).not.toBe(receiptA);
    expect(dismissed).toHaveBeenCalledWith(receiptA);
  });

  test("a receipt the timeline took down just before the verdict: the card still shows, under an id never dismissed", async () => {
    await animatedCloseSessions([A]);
    undoTimeline.open("peek");
    undoTimeline.close();
    answer([{ session: A, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    const card = front();
    expect(card.className).toBe(CLOSE_ADVICE_CLASS);
    expect(dismissed.mock.calls.map((c) => c[0])).not.toContain(card.id);
  });

  test("a triggers line that comes later updates the same card, and the card's Undo still takes the Close back", async () => {
    const { advice } = await animatedHideSessions([A], "kill");
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    const id = front().id;
    expect(closeAdviceTakesTriggers(advice, "Also canceled trigger \"Nightly\"", "kill-triggers-v")).toBe(true);
    expect(front().id).toBe(id);
    front().cancel!.onClick!({ preventDefault() {} });
    expect((useInboxStore.getState().sessions as any)[A].inbox_dismissed_at ?? null).toBe(null);
  });

  test("Close A, A's card is up, then Close B: A's card is raised again in front, whole, and B's own card takes the front when it asks", async () => {
    await animatedCloseSessions([A]);
    const entryA = getUndoHistory().items[0]!.id;
    const receiptB = () => undoEntryToastId(getUndoHistory().items[0]!.id);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    const first = front();
    expect(first.className).toBe(CLOSE_ADVICE_CLASS);
    jest.useFakeTimers();
    try {
      // Eight seconds into A's card, the person closes B.
      jest.advanceTimersByTime(8000);
      await animatedCloseSessions([B]);
    } finally {
      jest.useRealTimers();
    }
    const raised = front();
    expect(raised.title).toBe("Closed “Owners redesign”");
    expect(raised.className).toBe(CLOSE_ADVICE_CLASS);
    expect(raised.duration).toBe(CLOSE_ADVICE_CARD_MS);
    expect(raised.id).not.toBe(first.id);
    expect(dismissed).toHaveBeenCalledWith(first.id);
    // B's receipt is up behind it, with its own Undo.
    expect(latest(receiptB())!.action?.label).toBe("Undo");
    // sonner calls onDismiss for the retired copy: that is not A's card going.
    first.onDismiss?.({} as any);
    answers[1]!([{ session: B, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    expect(front().title).toBe("Closed “Eval audit”");
    // A later notice goes behind both cards, the newest gesture's in front.
    const before = toast.getHistory().length;
    CODECAST_UNDO_NOTIFIER.notify!("Copied");
    const after = (toast.getHistory() as Shown[]).slice(before).map((t) => t.title);
    expect(after).toEqual(["Copied", "Closed “Owners redesign”", "Closed “Eval audit”"]);
    front().cancel!.onClick!({ preventDefault() {} });
    expect((useInboxStore.getState().sessions as any)[B].inbox_dismissed_at ?? null).toBe(null);
    latest(undoEntryToastId(entryA))!.cancel!.onClick!({ preventDefault() {} });
    expect((useInboxStore.getState().sessions as any)[A].inbox_dismissed_at ?? null).toBe(null);
  });
});

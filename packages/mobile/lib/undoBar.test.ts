import { afterAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory, resetUndoHistory } from "@platform/engine";
import { placeInboxRows, useInboxStore } from "@codecast/web/store/inboxStore";
import type { AfterCloseResult } from "@codecast/shared/contracts/closeKind";
import { bindCloseAdviceCall, CLOSE_ADVICE_CARD_MS, CLOSE_ADVICE_HOLD_MS } from "@codecast/web/lib/closeAdviceBar";
import { bindUndoBarOpen, closeWithAdvice, dismissUndoBar, holdKill, leaveUndoBar, setAppActive, showNotice, UNDO_BAR_EXIT_MS, UNDO_BAR_MS, useUndoBar, type UndoBarItem } from "./undoBar";

const A = "a".repeat(32);
const B = "b".repeat(32);
const row = (id: string) => (useInboxStore.getState().sessions as any)[id];
const bar = () => useUndoBar.getState().item;
/** The app leaves the foreground and comes back (UndoBarHost's AppState listener). */
const awayAndBack = () => { setAppActive(false); setAppActive(true); };

beforeEach(() => {
  // The account boundary drops whatever a test left on the bar or queued.
  resetUndoHistory();
  setAppActive(true);
  _resetUndoStacks();
  useUndoBar.setState({ item: null, heldKillId: null });
  useInboxStore.setState({
    pending: {}, currentSessionId: null, clientState: {},
    sessions: { [A]: { _id: A, title: "First", updated_at: 1 }, [B]: { _id: B, title: "Second", updated_at: 1 } },
    conversations: { [A]: { _id: A, title: "First" }, [B]: { _id: B, title: "Second" } },
  } as any);
});

test("a stash shows its own Undo, which puts the row back", () => {
  useInboxStore.getState().stashSession(A);
  expect(row(A).inbox_stashed_at).toBeTruthy();
  expect(bar()?.title).toBe("Stashed “First”");
  bar()!.onUndo!();
  expect(row(A).inbox_stashed_at ?? null).toBe(null);
  // The engine announces the undo on the same bar, with nothing to undo.
  expect(bar()?.title).toContain("Stashed “First”");
  expect(bar()?.onUndo).toBeUndefined();
});

test("a held kill touches nothing until it runs, and Undo drops it", () => {
  holdKill(A);
  expect(bar()?.title).toBe("Killing “First”");
  expect(bar()?.durationMs).toBe(UNDO_BAR_MS);
  expect(useUndoBar.getState().heldKillId).toBe(A);
  expect(row(A).inbox_dismissed_at ?? null).toBe(null);
  bar()!.onUndo!();
  expect(bar()).toBe(null);
  expect(useUndoBar.getState().heldKillId).toBe(null);
  awayAndBack();
  expect(row(A).inbox_dismissed_at ?? null).toBe(null);
});

test("a held kill runs when the bar drains, without a second Undo bar", () => {
  holdKill(A);
  dismissUndoBar(bar()!.key);
  expect(row(A).inbox_dismissed_at).toBeTruthy();
  expect(bar()).toBe(null);
  expect(getUndoHistory().items).toHaveLength(0);
});

test("a held kill runs at the end of its window, and the bar stays for its own exit", () => {
  jest.useFakeTimers();
  try {
    holdKill(A);
    const key = bar()!.key;
    jest.advanceTimersByTime(UNDO_BAR_MS - 1);
    expect(row(A).inbox_dismissed_at ?? null).toBe(null);
    jest.advanceTimersByTime(1);
    expect(row(A).inbox_dismissed_at).toBeTruthy();
    expect(useUndoBar.getState().heldKillId).toBe(null);
    // The bar's drain (components/UndoBar leave) takes it down, after its exit.
    expect(bar()?.key).toBe(key);
    leaveUndoBar(key);
    expect(bar()?.key).toBe(key);
    dismissUndoBar(key);
    expect(bar()).toBe(null);
    expect(getUndoHistory().items).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});

test("a new bar runs the held kill first", () => {
  holdKill(A);
  useInboxStore.getState().stashSession(B);
  expect(row(A).inbox_dismissed_at).toBeTruthy();
  expect(useUndoBar.getState().heldKillId).toBe(null);
  expect(bar()?.title).toBe("Stashed “Second”");
});

test("a stale key does not take down a newer bar", () => {
  useInboxStore.getState().stashSession(A);
  const first = bar()!.key;
  useInboxStore.getState().stashSession(B);
  dismissUndoBar(first);
  expect(bar()?.title).toBe("Stashed “Second”");
});

test("a close runs at once and shows Closed with its own Undo, which puts the row back", () => {
  useInboxStore.getState().closeSession(A);
  expect(row(A).inbox_dismissed_at).toBeTruthy();
  expect(useUndoBar.getState().heldKillId).toBe(null);
  expect(bar()?.title).toBe("Closed “First”");
  expect(bar()?.note).toBeUndefined();
  bar()!.onUndo!();
  expect(row(A).inbox_dismissed_at ?? null).toBe(null);
});

test("a close runs a held kill first", () => {
  holdKill(A);
  useInboxStore.getState().closeSession(B);
  expect(row(A).inbox_dismissed_at).toBeTruthy();
  expect(bar()?.title).toBe("Closed “Second”");
});

// ── Close advice (web lib/closeAdviceBar): a Close or Kill asks beside the
// gesture whether a closed session asked the person something; the bar is
// today's while the verdict is pending, and a needs-you verdict makes it a card.
describe("close advice on the bar", () => {
  const ME = "u".repeat(32);
  const TEAM = "t".repeat(32);
  const C = "c".repeat(32);
  const T = Date.now() - 60_000;
  // A quiet session its agent pinned done: the inbox files it under Done.
  const doneRow = (id: string, title: string, extra: any = {}) => ({
    _id: id, title, updated_at: T, user_id: ME, team_id: TEAM, message_count: 3, thread_state_status: "done", thread_state_at: T + 1, last_turn_at: T - 10, ...extra,
  });
  let calls: string[][] = [];
  let gestures: string[] = [];
  let answer: (results: AfterCloseResult[] | null) => void = () => {};
  /** Every call's own answer, in call order. */
  let answers: Array<(results: AfterCloseResult[] | null) => void> = [];
  let opened: Array<[string, string | undefined]> = [];
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function seed(opts: { feature?: boolean; rows?: Record<string, any> } = {}) {
    const rows = opts.rows ?? { [A]: doneRow(A, "Owners redesign"), [B]: doneRow(B, "Eval audit"), [C]: doneRow(C, "Stripe SDK") };
    useInboxStore.setState({
      pending: {}, currentSessionId: null,
      clientState: { ui: { active_team_id: TEAM } },
      currentUser: { _id: ME },
      teams: [{ _id: TEAM, features: { close_advice: opts.feature ?? true } }],
      sessions: rows,
      conversations: Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, { ...r }])),
      messages: { [A]: [{ _id: "m1" }, { _id: "m2" }] },
    } as any);
  }

  beforeEach(() => {
    calls = [];
    gestures = [];
    opened = [];
    answers = [];
    bindCloseAdviceCall((sessions, gesture) => {
      calls.push(sessions);
      gestures.push(gesture);
      return new Promise((resolve) => {
        answer = (results) => resolve({ results: results ?? [] });
        answers.push(answer);
      });
    });
    bindUndoBarOpen((id, messageId) => { opened.push([id, messageId]); });
    seed();
  });
  afterAll(() => {
    bindCloseAdviceCall(null);
    bindUndoBarOpen(null);
  });

  test("a Close asks once; the bar is today's, held longer", () => {
    closeWithAdvice(A);
    expect(calls).toEqual([[A]]);
    expect(bar()?.title).toBe("Closed “Owners redesign”");
    expect(bar()?.ask).toBeUndefined();
    expect(bar()?.action).toBeUndefined();
    expect(bar()?.durationMs).toBe(UNDO_BAR_MS + CLOSE_ADVICE_HOLD_MS);
  });

  test("a row in Needs You is never asked about, and its bar is today's", () => {
    seed({ rows: { [A]: doneRow(A, "Asks", { thread_state_status: null, inbox_rest: "needs_input", inbox_rest_at: T + 5 }) } });
    closeWithAdvice(A);
    expect(calls).toEqual([]);
    expect(bar()?.durationMs).toBe(UNDO_BAR_MS);
  });

  test("with the feature off nothing is asked", () => {
    seed({ feature: false });
    closeWithAdvice(A);
    holdKill(B);
    expect(calls).toEqual([]);
    expect(bar()?.durationMs).toBe(UNDO_BAR_MS);
  });

  test("a needs-you verdict makes the card: title, the ask, Undo and Open", async () => {
    closeWithAdvice(A);
    const key = bar()!.key;
    answer([{ session: A, verdict: "needs_you", reason: "Decide whether to file both follow-ups as tasks" }]);
    await flush();
    const card = bar()!;
    expect(card.key).toBe(key);
    expect(card.life).toBeGreaterThan(0);
    expect(card.title).toBe("Closed “Owners redesign”");
    expect(card.ask).toBe("Decide whether to file both follow-ups as tasks");
    expect(card.action?.label).toBe("Open");
    expect(card.onUndo).toBeDefined();
    expect(card.durationMs).toBe(CLOSE_ADVICE_CARD_MS);
  });

  test("Open brings the session back and opens its screen at the last message, with no Undid", async () => {
    closeWithAdvice(A);
    answer([{ session: A, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    bar()!.action!.onPress();
    expect(row(A).inbox_dismissed_at ?? null).toBe(null);
    expect(opened).toEqual([[A, "m2"]]);
    expect(bar()?.title.startsWith("Undid")).toBe(false);
    // Open opens it; it files nothing.
    expect(row(A).inbox_rest ?? null).toBe(null);
  });

  test("Undo on the card takes the Close back", async () => {
    closeWithAdvice(A);
    answer([{ session: A, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    bar()!.onUndo!();
    expect(row(A).inbox_dismissed_at ?? null).toBe(null);
    expect(opened).toEqual([]);
  });

  test("a close verdict or an error leaves today's bar, back on its own clock", async () => {
    closeWithAdvice(A);
    answer([{ session: A, verdict: "close" }]);
    await flush();
    expect(bar()?.title).toBe("Closed “Owners redesign”");
    expect(bar()?.ask).toBeUndefined();
    expect(bar()!.durationMs).toBeLessThanOrEqual(UNDO_BAR_MS);
    closeWithAdvice(B);
    answer(null);
    await flush();
    expect(bar()?.title).toBe("Closed “Eval audit”");
    expect(bar()?.ask).toBeUndefined();
  });

  test("a verdict after the bar went lands nowhere", async () => {
    closeWithAdvice(A);
    dismissUndoBar(bar()!.key);
    answer([{ session: A, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    expect(bar()).toBe(null);
  });

  test("a held kill that asked says Killed; Open drops the kill and opens it", async () => {
    holdKill(A);
    expect(calls).toEqual([[A]]);
    expect(bar()?.title).toBe("Killing “Owners redesign”");
    expect(bar()?.durationMs).toBe(UNDO_BAR_MS + CLOSE_ADVICE_HOLD_MS);
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    expect(bar()?.title).toBe("Killed “Owners redesign”");
    expect(bar()?.ask).toBe("Pick a sort order");
    expect(useUndoBar.getState().heldKillId).toBe(A);
    bar()!.action!.onPress();
    expect(useUndoBar.getState().heldKillId).toBe(null);
    awayAndBack();
    expect(row(A).inbox_dismissed_at ?? null).toBe(null);
    expect(opened).toEqual([[A, "m2"]]);
  });

  test("a held kill whose card drains runs the kill", async () => {
    holdKill(A);
    answer([{ session: A, verdict: "needs_you", reason: "Pick" }]);
    await flush();
    dismissUndoBar(bar()!.key);
    expect(row(A).inbox_dismissed_at).toBeTruthy();
  });

  test("the server is told the gesture: Close is close; a held Kill is kill", () => {
    closeWithAdvice(A);
    holdKill(B);
    expect(gestures).toEqual(["close", "kill"]);
  });

  // One bar: a later gesture's bar takes the place of one still waiting on its verdict.
  test("three quick Closes, the first asked: its card shows once the last bar goes, and Undo takes that Close back", async () => {
    closeWithAdvice(A);
    closeWithAdvice(B);
    closeWithAdvice(C);
    expect(bar()?.title).toBe("Closed “Stripe SDK”");
    answers[1]!([{ session: B, verdict: "close" }]);
    answers[2]!([{ session: C, verdict: "close" }]);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    // C's bar keeps its own undo window.
    expect(bar()?.title).toBe("Closed “Stripe SDK”");
    dismissUndoBar(bar()!.key);
    expect(bar()?.title).toBe("Closed “Owners redesign”");
    expect(bar()?.ask).toBe("Pick a sort order");
    expect(bar()?.action?.label).toBe("Open");
    bar()!.onUndo!();
    expect(row(A).inbox_dismissed_at ?? null).toBe(null);
    expect(row(B).inbox_dismissed_at).toBeTruthy();
    expect(row(C).inbox_dismissed_at).toBeTruthy();
  });

  test("an earlier gesture's card waits for the card showing now, then shows; Open acts on it", async () => {
    closeWithAdvice(A);
    closeWithAdvice(B);
    answers[1]!([{ session: B, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    expect(bar()?.title).toBe("Closed “Eval audit”");
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick" }]);
    await flush();
    expect(bar()?.title).toBe("Closed “Eval audit”");
    dismissUndoBar(bar()!.key);
    expect(bar()?.title).toBe("Closed “Owners redesign”");
    bar()!.action!.onPress();
    expect(row(A).inbox_dismissed_at ?? null).toBe(null);
    expect(row(B).inbox_dismissed_at).toBeTruthy();
    expect(opened).toEqual([[A, "m2"]]);
  });

  test("a held Kill a later bar ran early still gets its card; Open brings it back and opens it", async () => {
    holdKill(A);
    closeWithAdvice(B);
    expect(row(A).inbox_dismissed_at).toBeTruthy();
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    dismissUndoBar(bar()!.key);
    expect(bar()?.title).toBe("Killed “Owners redesign”");
    bar()!.action!.onPress();
    expect(row(A).inbox_dismissed_at ?? null).toBe(null);
    expect(opened).toEqual([[A, "m2"]]);
  });

  test("Undo on a held Kill's late card brings the session back", async () => {
    holdKill(A);
    closeWithAdvice(B);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick" }]);
    await flush();
    dismissUndoBar(bar()!.key);
    bar()!.onUndo!();
    expect(row(A).inbox_dismissed_at ?? null).toBe(null);
    expect(row(B).inbox_dismissed_at).toBeTruthy();
  });

  test("a late card never takes the place of a later held Kill's bar: the kill stays held, the card shows when that bar goes", async () => {
    closeWithAdvice(A);
    holdKill(B);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    expect(bar()?.title).toBe("Killing “Eval audit”");
    expect(useUndoBar.getState().heldKillId).toBe(B);
    expect(row(B).inbox_dismissed_at ?? null).toBe(null);
    // B's Undo still drops its kill.
    const killing = bar()!;
    killing.onUndo!();
    dismissUndoBar(killing.key);
    expect(row(B).inbox_dismissed_at ?? null).toBe(null);
    expect(bar()?.title).toBe("Closed “Owners redesign”");
    expect(bar()?.ask).toBe("Pick a sort order");
  });

  test("a late card waits behind a later held Kill's bar until it drains, then shows; the kill ran", async () => {
    closeWithAdvice(A);
    holdKill(B);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick" }]);
    await flush();
    dismissUndoBar(bar()!.key);
    expect(row(B).inbox_dismissed_at).toBeTruthy();
    expect(bar()?.title).toBe("Closed “Owners redesign”");
  });

  test("a card queued behind a held Kill waits while the app is away; leaving runs that kill, coming back shows the card", async () => {
    closeWithAdvice(A);
    holdKill(B);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    setAppActive(false);
    expect(row(B).inbox_dismissed_at).toBeTruthy();
    expect(bar()).toBe(null);
    setAppActive(true);
    expect(bar()?.title).toBe("Closed “Owners redesign”");
    expect(bar()?.ask).toBe("Pick a sort order");
  });

  test("a notice that takes a card's place puts it back: the card shows again when the notice goes", async () => {
    closeWithAdvice(A);
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    showNotice("Copied");
    expect(bar()?.title).toBe("Copied");
    dismissUndoBar(bar()!.key);
    expect(bar()?.ask).toBe("Pick a sort order");
    expect(bar()?.durationMs).toBe(CLOSE_ADVICE_CARD_MS);
  });

  test("an undone card never comes back after the Undid notice its Undo raised", async () => {
    closeWithAdvice(A);
    answer([{ session: A, verdict: "needs_you", reason: "Reply" }]);
    await flush();
    bar()!.onUndo!();
    expect(bar()?.title.startsWith("Undid")).toBe(true);
    dismissUndoBar(bar()!.key);
    expect(bar()).toBe(null);
  });

  /** The bar's own countdown (components/UndoBar): each life of a bar drains
   *  after its durationMs, then takes it down. Fake timers throughout. */
  async function withBarClock(run: (settle: () => Promise<void>) => Promise<void>) {
    jest.useFakeTimers();
    let drain: ReturnType<typeof setTimeout> | null = null;
    let seen = "";
    const unsub = useUndoBar.subscribe(({ item }) => {
      const life = item ? `${item.key}:${item.life}` : "";
      if (life === seen) return;
      seen = life;
      if (drain) clearTimeout(drain);
      drain = item ? setTimeout(() => dismissUndoBar(item.key), item.durationMs) : null;
    });
    try {
      await run(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    } finally {
      unsub();
      if (drain) clearTimeout(drain);
      jest.useRealTimers();
    }
  }

  /** The card for A is on the bar now: it stays exactly its whole life, then goes. */
  const lastsItsWholeLife = (ask: string) => {
    expect(bar()?.ask).toBe(ask);
    jest.advanceTimersByTime(CLOSE_ADVICE_CARD_MS - 1);
    expect(bar()?.ask).toBe(ask);
    jest.advanceTimersByTime(1);
    expect(bar()).toBe(null);
  };

  test("a card a later Close's bar covers comes back with its whole life once that bar goes", () => withBarClock(async (settle) => {
    closeWithAdvice(A);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await settle();
    jest.advanceTimersByTime(8000);
    // The person swipes B closed while A's card is up.
    closeWithAdvice(B);
    expect(bar()?.title).toBe("Closed “Eval audit”");
    answers[1]!([{ session: B, verdict: "close" }]);
    await settle();
    jest.advanceTimersByTime(UNDO_BAR_MS);
    expect(bar()?.title).toBe("Closed “Owners redesign”");
    lastsItsWholeLife("Pick a sort order");
  }));

  test("a card on screen when the app goes inactive shows again, whole, when it is active", () => withBarClock(async (settle) => {
    closeWithAdvice(A);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await settle();
    jest.advanceTimersByTime(8000);
    setAppActive(false);
    expect(bar()).toBe(null);
    jest.advanceTimersByTime(60_000);
    setAppActive(true);
    expect(bar()?.title).toBe("Closed “Owners redesign”");
    lastsItsWholeLife("Pick a sort order");
  }));

  test("a verdict that lands while the app is away waits for it, then shows whole", () => withBarClock(async (settle) => {
    closeWithAdvice(A);
    setAppActive(false);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await settle();
    expect(bar()).toBe(null);
    jest.advanceTimersByTime(60_000);
    setAppActive(true);
    lastsItsWholeLife("Pick a sort order");
  }));

  test("a held Kill's card when the app goes inactive: the kill runs, the card comes back, and its Undo brings the session back", async () => {
    holdKill(A);
    answer([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    setAppActive(false);
    expect(row(A).inbox_dismissed_at).toBeTruthy();
    expect(bar()).toBe(null);
    setAppActive(true);
    expect(bar()?.title).toBe("Killed “Owners redesign”");
    bar()!.onUndo!();
    expect(row(A).inbox_dismissed_at ?? null).toBe(null);
  });

  test("a card queued behind another card gets its own whole life once it shows", () => withBarClock(async (settle) => {
      closeWithAdvice(A);
      jest.advanceTimersByTime(1000);
      closeWithAdvice(B);
      answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
      answers[1]!([{ session: B, verdict: "needs_you", reason: "Reply" }]);
      await settle();
      expect(bar()?.title).toBe("Closed “Eval audit”");
      expect(bar()?.ask).toBe("Reply");
      jest.advanceTimersByTime(CLOSE_ADVICE_CARD_MS - 1);
      expect(bar()?.ask).toBe("Reply");
      jest.advanceTimersByTime(1);
      expect(bar()?.title).toBe("Closed “Owners redesign”");
      expect(bar()?.ask).toBe("Pick a sort order");
      lastsItsWholeLife("Pick a sort order");
  }));

  /** The bar's countdown as components/UndoBar runs it: each life drains
   *  after its durationMs, then the bar leaves (leaveUndoBar) and comes down
   *  UNDO_BAR_EXIT_MS later. A swipe starts the same leave. */
  async function withLeavingBar(run: (settle: () => Promise<void>, swipe: () => void) => Promise<void>) {
    jest.useFakeTimers();
    let drain: ReturnType<typeof setTimeout> | null = null;
    let seen = "";
    const leave = (key: number) => {
      leaveUndoBar(key);
      setTimeout(() => dismissUndoBar(key), UNDO_BAR_EXIT_MS);
    };
    const unsub = useUndoBar.subscribe(({ item }) => {
      const life = item ? `${item.key}:${item.life}` : "";
      if (life === seen) return;
      seen = life;
      if (drain) clearTimeout(drain);
      drain = item ? setTimeout(() => leave(item.key), item.durationMs) : null;
    });
    try {
      await run(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }, () => leave(bar()!.key));
    } finally {
      unsub();
      if (drain) clearTimeout(drain);
      jest.useRealTimers();
    }
  }

  /** Every bar that shows over the next `ms`. */
  const barsShownFor = (ms: number): UndoBarItem[] => {
    const shown: UndoBarItem[] = [];
    const unsub = useUndoBar.subscribe(({ item }) => { if (item) shown.push(item); });
    jest.advanceTimersByTime(ms);
    unsub();
    return shown;
  };

  test("a card whose life ran out never comes back when a bar shows during its exit", () => withLeavingBar(async (settle) => {
    closeWithAdvice(A);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await settle();
    jest.advanceTimersByTime(CLOSE_ADVICE_CARD_MS);
    // Its exit is running: a notice shows inside it.
    jest.advanceTimersByTime(UNDO_BAR_EXIT_MS - 1);
    showNotice("Copied");
    expect(barsShownFor(60_000).map((b) => b.ask)).not.toContain("Pick a sort order");
    expect(bar()).toBe(null);
  }));

  test("a held Kill's card whose life ran out runs the kill, stays for its exit, and never comes back", () => withLeavingBar(async (settle) => {
    holdKill(A);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await settle();
    jest.advanceTimersByTime(CLOSE_ADVICE_CARD_MS);
    expect(row(A).inbox_dismissed_at).toBeTruthy();
    expect(bar()?.ask).toBe("Pick a sort order");
    // Its exit is running: a notice shows inside it.
    jest.advanceTimersByTime(UNDO_BAR_EXIT_MS - 1);
    showNotice("Copied");
    expect(barsShownFor(60_000).map((b) => b.ask)).not.toContain("Pick a sort order");
    expect(bar()).toBe(null);
  }));

  test("a swiped card never comes back when a bar shows during its exit", () => withLeavingBar(async (settle, swipe) => {
    closeWithAdvice(A);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await settle();
    jest.advanceTimersByTime(3000);
    swipe();
    closeWithAdvice(B);
    expect(bar()?.title).toBe("Closed “Eval audit”");
    answers[1]!([{ session: B, verdict: "close" }]);
    await settle();
    expect(barsShownFor(60_000).map((b) => b.ask)).not.toContain("Pick a sort order");
    expect(bar()).toBe(null);
  }));

  test("a queued card whose Close was taken back meanwhile never shows", async () => {
    closeWithAdvice(A);
    const first = bar()!;
    holdKill(B);
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick a sort order" }]);
    await flush();
    // Undo raises its "Undid" notice, which runs the held kill.
    first.onUndo!();
    expect(row(B).inbox_dismissed_at).toBeTruthy();
    dismissUndoBar(bar()!.key);
    expect(bar()).toBe(null);
  });

  test("an earlier gesture taken back before its verdict shows no card", async () => {
    closeWithAdvice(A);
    const first = bar()!;
    closeWithAdvice(B);
    first.onUndo!();
    answers[0]!([{ session: A, verdict: "needs_you", reason: "Pick" }]);
    await flush();
    expect(bar()?.ask).toBeUndefined();
  });

});

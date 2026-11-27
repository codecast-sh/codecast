// A drag that reorders priorities paints the new order at once and holds it
// until the server has the move. A list push computed before the move landed
// (the backend can take seconds) must not put the old order back, and the
// move's acknowledgement settles its locks on whatever the server answers
// next, so a place the server computed differently (a renumber over rows this
// window does not hold) lands instead of freezing.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { effectivePriorityOrder } from "@codecast/shared/contracts/priorities";
import { useInboxStore } from "../inboxStore";
import { makeDispatchBinding } from "../../lib/dispatchBinding";

const ME = "u_me";
const WS = "team:t1";
const owner = {};
const st = () => useInboxStore.getState() as any;
const tick = () => new Promise((r) => setTimeout(r, 0));

const row = (n: number, person_pos: number) => ({
  _id: `p${n}`, short_id: `pri-${n}`, title: `P${n}`, status: "active", person_pos, ai_rank: null, last_active_at: 1,
  user_id: ME, workspace: WS, mine: true, steps: [], counts: { critical_done: 0, critical_total: 0 }, sessions: [],
});
const SERVER = [row(1, 1), row(2, 2), row(3, 3)];
const order = () => effectivePriorityOrder(Object.values(st().priorities) as any[]).map((r: any) => r.short_id).join(",");
const push = (rows: unknown[]) => st().syncTable("priorities", rows);
const priorityLocks = () => Object.keys(st().pending).filter((k) => k.startsWith("priorities:"));

let calls: Array<{ action: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
const answer = async (i: number, ok = true) => {
  if (ok) calls[i].resolve(null); else calls[i].reject(new Error("Uncaught Error: pri-3 is done; only active priorities are ranked"));
  for (let n = 0; n < 5; n++) await tick();
};

beforeEach(() => {
  calls = [];
  useInboxStore.setState({ currentUser: { _id: ME, name: "Me" } as any, pending: {}, priorities: {} } as any);
  st()._setDispatch(makeDispatchBinding((a) => new Promise((resolve, reject) => { calls.push({ action: a.action, resolve, reject }); })), { owner });
  push(SERVER);
});
afterEach(() => st()._clearDispatch(owner));

test("a push from before the move landed does not put the old order back", async () => {
  expect(order()).toBe("pri-1,pri-2,pri-3");
  st().movePriority("pri-3", 1);
  expect(order()).toBe("pri-3,pri-1,pri-2");
  await tick();
  // The list re-ran for something else before the server had the move.
  push(SERVER);
  expect(order()).toBe("pri-3,pri-1,pri-2");
  // The echo: the server placed it where the paint did.
  push([row(1, 1), row(2, 2), row(3, 0)]);
  await answer(0);
  expect(order()).toBe("pri-3,pri-1,pri-2");
  expect(priorityLocks()).toEqual([]);
});

test("after the acknowledgement, the server's own place lands even when it differs from the paint", async () => {
  st().movePriority("pri-3", 1);
  await tick();
  push(SERVER);
  await answer(0);
  expect(order()).toBe("pri-3,pri-1,pri-2");
  // The server renumbered over rows this window does not hold: its values differ from the paint.
  push([row(1, 2), row(2, 3), row(3, 1)]);
  expect(priorityLocks()).toEqual([]);
  expect(st().priorities.p3.person_pos).toBe(1);
  expect(st().priorities.p1.person_pos).toBe(2);
  expect(order()).toBe("pri-3,pri-1,pri-2");
});

test("a move made in a sibling window settles this window's mirrored lock on the sibling's acknowledgement", () => {
  const key = "priorities:p3:person_pos";
  useInboxStore.setState({ pending: { [key]: { type: "field", value: 0, ts: Date.now() - 10 } } } as any);
  push([row(1, 1), row(2, 2), row(3, 0)].map((r) => (r._id === "p3" ? { ...r, person_pos: 3 } : r)));
  expect(st().priorities.p3.person_pos).toBe(0);
  st().applyGestureBridge({ kind: "settle", locks: [{ key, value: 0 }], lockIds: ["sibling-lock"], sentAt: Date.now(), ts: Date.now() });
  push([row(1, 2), row(2, 3), row(3, 1)]);
  expect(priorityLocks()).toEqual([]);
  expect(st().priorities.p3.person_pos).toBe(1);
});

test("a refused move puts the old order back and holds nothing", async () => {
  st().movePriority("pri-3", 1).catch(() => {});
  await tick();
  await answer(0, false);
  for (let i = 0; i < 50 && priorityLocks().length; i++) await tick();
  expect(priorityLocks()).toEqual([]);
  expect(order()).toBe("pri-1,pri-2,pri-3");
});

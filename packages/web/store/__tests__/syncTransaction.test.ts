// N incoming applies, one subscriber visit (ct-49548).
//
// The contract these pin: state commits synchronously on every apply — a caller
// that reads getState() straight after syncTable still sees its own write — and
// only the notification is folded into the 33 ms window. A write from outside a
// transaction never waits behind the fold.
import { afterEach, expect, test } from "bun:test";
import { useInboxStore, type InboxSession } from "../inboxStore";
import {
  SYNC_PUBLISH_WINDOW_MS,
  flushSyncPublishes,
  resetSyncTransactionForTests,
  syncTransaction,
} from "../syncTransaction";

const id = (n: number) => `${n}`.padStart(32, "s");
const session = (n: number, patch: Partial<InboxSession> = {}): InboxSession => ({
  _id: id(n),
  session_id: `sync-txn-${n}`,
  user_id: "me",
  status: "active",
  updated_at: 1_000 + n,
  message_count: n,
  is_idle: true,
  agent_status: "done",
  title: `Row ${n}`,
  ...patch,
});

function reset() {
  useInboxStore.setState({ sessions: {}, conversations: {}, pending: {}, currentUser: { _id: "me" } } as any);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => resetSyncTransactionForTests());

test("a burst of feeder applies costs one subscriber visit, not one per apply", async () => {
  reset();
  let visits = 0;
  const stop = useInboxStore.subscribe(() => { visits++; });

  const store = useInboxStore.getState();
  store.syncTable("sessions", [session(1)]);
  store.syncTable("sessions", [session(2)]);
  store.syncTable("sessions", [session(3)]);
  store.syncTable("teamUnreadCount", 4, { kind: "scalar" });

  // Every apply is already in the store; only the notification is held.
  expect(Object.keys(useInboxStore.getState().sessions)).toHaveLength(3);
  expect(visits).toBe(0);

  await sleep(SYNC_PUBLISH_WINDOW_MS * 3);
  expect(visits).toBe(1);
  stop();
});

test("the folded visit reports the newest state against the state before the window", async () => {
  reset();
  const seen: Array<{ rows: number; before: number }> = [];
  const stop = useInboxStore.subscribe((state: any, previous: any) => {
    seen.push({ rows: Object.keys(state.sessions).length, before: Object.keys(previous.sessions).length });
  });

  const store = useInboxStore.getState();
  store.syncTable("sessions", [session(1)]);
  store.syncTable("sessions", [session(2)]);
  await sleep(SYNC_PUBLISH_WINDOW_MS * 3);

  expect(seen).toEqual([{ rows: 2, before: 0 }]);
  stop();
});

test("a write from outside a transaction publishes at once, carrying the held backlog", () => {
  reset();
  let visits = 0;
  let rowsAtVisit = 0;
  const stop = useInboxStore.subscribe((state: any) => {
    visits++;
    rowsAtVisit = Object.keys(state.sessions).length;
  });

  useInboxStore.getState().syncTable("sessions", [session(1)]);
  expect(visits).toBe(0);

  // A gesture: it must not wait out the window, and it must not publish a view
  // that hides the incoming row already committed underneath it.
  useInboxStore.setState({ currentUser: { _id: "me", name: "gesture" } } as any);
  expect(visits).toBe(1);
  expect(rowsAtVisit).toBe(1);
  stop();
});

test("nested transactions join the open window instead of publishing on exit", async () => {
  reset();
  let visits = 0;
  const stop = useInboxStore.subscribe(() => { visits++; });

  syncTransaction(() => {
    useInboxStore.getState().syncTable("sessions", [session(1)]);
    syncTransaction(() => {
      useInboxStore.getState().syncTable("sessions", [session(2)]);
    });
    expect(visits).toBe(0);
  });
  expect(visits).toBe(0);

  await sleep(SYNC_PUBLISH_WINDOW_MS * 3);
  expect(visits).toBe(1);
  stop();
});

test("a transaction that throws leaves the fold closed", () => {
  reset();
  expect(() => syncTransaction(() => { throw new Error("boom"); })).toThrow("boom");

  let visits = 0;
  const stop = useInboxStore.subscribe(() => { visits++; });
  useInboxStore.setState({ currentUser: { _id: "me", name: "after" } } as any);
  expect(visits).toBe(1);
  stop();
});

test("flushSyncPublishes visits subscribers with the whole window at once", () => {
  reset();
  let visits = 0;
  const stop = useInboxStore.subscribe(() => { visits++; });

  const store = useInboxStore.getState();
  store.syncTable("sessions", [session(1)]);
  store.syncTable("sessions", [session(2)]);
  flushSyncPublishes();
  expect(visits).toBe(1);

  // Nothing held: a second flush is a no-op, never a phantom visit.
  flushSyncPublishes();
  expect(visits).toBe(1);
  stop();
});

test("a page written one record at a time costs one subscriber visit (ct-49746)", async () => {
  reset();
  let visits = 0;
  const stop = useInboxStore.subscribe(() => { visits++; });

  // The shape useSyncDocs and useSyncTasks have: one syncRecord per row.
  const store = useInboxStore.getState();
  for (let n = 1; n <= 5; n++) store.syncRecord("sessions", id(n), session(n));

  // Every row is readable straight away; only the notification is held.
  expect(Object.keys(useInboxStore.getState().sessions)).toHaveLength(5);
  expect(visits).toBe(0);

  await sleep(SYNC_PUBLISH_WINDOW_MS * 3);
  expect(visits).toBe(1);
  stop();
});

test("syncRecord joins the window syncTable opened", async () => {
  reset();
  let visits = 0;
  let rowsAtVisit = 0;
  const stop = useInboxStore.subscribe((state: any) => {
    visits++;
    rowsAtVisit = Object.keys(state.sessions).length;
  });

  const store = useInboxStore.getState();
  store.syncTable("sessions", [session(1), session(2)]);
  store.syncRecord("sessions", id(3), session(3));

  await sleep(SYNC_PUBLISH_WINDOW_MS * 3);
  expect(visits).toBe(1);
  expect(rowsAtVisit).toBe(3);
  stop();
});

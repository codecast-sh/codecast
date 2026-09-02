// Ported from codecast packages/electron/notificationRouter.test.js. Run: bun test
const { test } = require("bun:test");
const assert = require("node:assert/strict");
const {
  classifyRoute, sameEntity, pickWindow, chooseLeader, RecentKeys, createNotificationRouter,
} = require("./notificationRouter");

const main = (over = {}) => ({
  id: 1,
  isMain: true,
  focused: false,
  lastFocusedAt: 10,
  active: "/inbox",
  open: [{ id: "t1", path: "/inbox" }],
  inCall: false,
  ...over,
});
const tabWin = (id, active, over = {}) => ({
  id,
  isMain: false,
  focused: false,
  lastFocusedAt: 20,
  active,
  open: [{ id: `w${id}`, path: active }],
  inCall: false,
  ...over,
});

test("classifyRoute names the page family and entity", () => {
  assert.deepEqual(classifyRoute("/chat/ch1?m=msg9"), { area: "chat", id: "ch1" });
  assert.deepEqual(classifyRoute("/conversation/c1"), { area: "conversation", id: "c1" });
  assert.deepEqual(classifyRoute("/inbox"), { area: "conversation", id: null });
  assert.deepEqual(classifyRoute("/inbox?s=c1"), { area: "conversation", id: "c1" });
  assert.equal(sameEntity("/inbox?s=c1", "/conversation/c1"), true, "inbox tab showing c1 IS c1");
  assert.deepEqual(classifyRoute("/tasks/ct1"), { area: "task", id: "ct1" });
  assert.deepEqual(classifyRoute("/calls"), { area: "call", id: null });
  assert.deepEqual(classifyRoute("/settings/team"), { area: null, id: null });
  assert.equal(sameEntity("/chat/a?m=1", "/chat/a"), true);
  assert.equal(sameEntity("/chat/a", "/chat/b"), false);
  assert.equal(sameEntity("/inbox", "/inbox"), false, "no entity, no exact match");
});

test("a DM lands in the window that already shows that DM", () => {
  const w = [main(), tabWin(2, "/chat/general"), tabWin(3, "/chat/dm-sam")];
  const pick = pickWindow(w, { route: "/chat/dm-sam?m=42" });
  assert.equal(pick.window.id, 3);
  assert.equal(pick.tabId, null);
});

test("a chat banner prefers a window on chat over the main window", () => {
  const w = [main(), tabWin(2, "/chat/general"), tabWin(3, "/tasks")];
  assert.equal(pickWindow(w, { route: "/chat/dm-sam" }).window.id, 2);
});

test("an open (inactive) tab showing the entity beats an area match elsewhere", () => {
  const w = [
    main({ active: "/inbox", open: [{ id: "t1", path: "/inbox" }, { id: "t2", path: "/chat/dm-sam" }] }),
    tabWin(2, "/chat/general"),
  ];
  const pick = pickWindow(w, { route: "/chat/dm-sam?m=1" });
  assert.equal(pick.window.id, 1);
  assert.equal(pick.tabId, "t2", "renderer must switch to the tab first");
});

test("a task banner switches to an open Tasks tab instead of retargeting the inbox tab", () => {
  const w = [main({ active: "/conversation/c1", open: [{ id: "t1", path: "/inbox?s=c1" }, { id: "t2", path: "/tasks" }] })];
  assert.equal(pickWindow(w, { route: "/tasks/ct-1" }).tabId, "t2");
  // Active tab already in the area: navigate in place.
  const w2 = [main({ active: "/tasks", open: [{ id: "t1", path: "/inbox" }, { id: "t2", path: "/tasks" }] })];
  assert.equal(pickWindow(w2, { route: "/tasks/ct-1" }).tabId, null);
});

test("no tabId when the active surface already shows the entity", () => {
  const w = [main({ active: "/chat/dm-sam", open: [{ id: "t1", path: "/chat/dm-sam" }] })];
  assert.equal(pickWindow(w, { route: "/chat/dm-sam?m=1" }).tabId, null);
});

test("a call banner goes to the window hosting the call, else the calls page", () => {
  const w = [main(), tabWin(2, "/calls"), tabWin(3, "/chat/x", { inCall: true })];
  assert.equal(pickWindow(w, { route: null, kind: "call" }).window.id, 3);
  const w2 = [main(), tabWin(2, "/calls"), tabWin(3, "/chat/x")];
  assert.equal(pickWindow(w2, { route: null, kind: "call" }).window.id, 2);
});

test("a session banner prefers the inbox (main) over an unrelated detached window", () => {
  const w = [main(), tabWin(2, "/tasks")];
  assert.equal(pickWindow(w, { route: "/conversation/c9" }).window.id, 1);
  const w2 = [main(), tabWin(2, "/conversation/c9")];
  assert.equal(pickWindow(w2, { route: "/conversation/c9" }).window.id, 2);
});

test("unknown routes fall back to the main window; ties fall to most recently focused", () => {
  const w = [main(), tabWin(2, "/tasks")];
  assert.equal(pickWindow(w, { route: "/settings/team" }).window.id, 1);
  const noMain = [tabWin(2, "/tasks", { lastFocusedAt: 5 }), tabWin(3, "/docs", { lastFocusedAt: 9 })];
  assert.equal(pickWindow(noMain, { route: "/settings/team" }).window.id, 3);
  assert.equal(pickWindow([], { route: "/x" }), null);
});

test("leader: focused window, else main, else most recently focused", () => {
  assert.equal(chooseLeader([main(), tabWin(2, "/chat/a", { focused: true })]).id, 2);
  assert.equal(chooseLeader([main(), tabWin(2, "/chat/a")]).id, 1);
  assert.equal(chooseLeader([tabWin(2, "/a", { lastFocusedAt: 1 }), tabWin(3, "/b", { lastFocusedAt: 2 })]).id, 3);
  assert.equal(chooseLeader([]), null);
});

test("RecentKeys collapses duplicates inside the TTL and forgets after it", () => {
  let t = 0;
  const keys = new RecentKeys(1000, () => t);
  assert.equal(keys.claim("n1"), true);
  assert.equal(keys.claim("n1"), false);
  t = 1500;
  assert.equal(keys.claim("n1"), true);
  assert.equal(RecentKeys.keyFor({ title: "a", body: "b", data: { key: "k" } }), "k");
  assert.equal(RecentKeys.keyFor({ title: "a", body: "b", data: { route: "/r" } }), "a|b|/r");
});

// --- windowBonus and preferredLeader ----------------------------------------
// The seam for a window that owns the ringer. Codecast's buddy list is the
// case: it answers every call and walkie banner wherever the user is looking,
// and it plays the sounds whether or not it is focused.

const peopleRouter = createNotificationRouter({
  windowBonus: (win, target) => {
    const kind = (target && target.kind) || null;
    return win.isPeople && (kind === "call" || kind === "walkie") ? 110 : null;
  },
  preferredLeader: (windows) => windows.find((w) => w.isPeople) || null,
});

const peopleWin = (over = {}) => ({
  id: 9,
  isMain: false,
  isPeople: true,
  focused: false,
  lastFocusedAt: 5,
  active: "/people",
  open: [],
  inCall: false,
  ...over,
});

test("preferredLeader takes the sounds while its window exists", () => {
  assert.equal(peopleRouter.chooseLeader([main({ focused: true }), peopleWin()]).id, 9, "even over the focused window");
  assert.equal(peopleRouter.chooseLeader([main(), peopleWin()]).id, 9, "even over the main window");
  assert.equal(
    peopleRouter.chooseLeader([main(), tabWin(2, "/chat/a", { focused: true })]).id,
    2,
    "no such window: the focused-window rule stands",
  );
  assert.equal(peopleRouter.chooseLeader([]), null, "no windows at all");
});

test("windowBonus wins over every route rule, keyed on the banner kind", () => {
  const windows = [main({ active: "/conversation/c1" }), tabWin(2, "/calls"), peopleWin()];
  assert.equal(peopleRouter.pickWindow(windows, { route: "/calls", kind: "call" }).window.id, 9);
  // The banner's own route names the DM it came from; the kind still wins.
  assert.equal(peopleRouter.pickWindow(windows, { route: "/conversation/c1", kind: "walkie" }).window.id, 9);
  // A kind the bonus does not claim keeps its usual home.
  assert.equal(peopleRouter.pickWindow(windows, { route: "/conversation/c1" }).window.id, 1);
  // With no such window a call still lands where the call is hosted.
  assert.equal(
    peopleRouter.pickWindow([main(), tabWin(2, "/calls", { inCall: true })], { route: null, kind: "call" }).window.id,
    2,
  );
});

test("both hooks default to absent, leaving the plain rules untouched", () => {
  const plain = createNotificationRouter();
  const windows = [main({ active: "/conversation/c1" }), tabWin(2, "/calls"), peopleWin()];
  assert.equal(plain.pickWindow(windows, { route: "/calls", kind: "call" }).window.id, 2, "isPeople means nothing here");
  assert.equal(plain.chooseLeader([main({ focused: true }), peopleWin()]).id, 1);
  // A bonus that declines every window changes nothing either.
  const declines = createNotificationRouter({ windowBonus: () => null, preferredLeader: () => null });
  assert.equal(declines.pickWindow(windows, { route: "/calls", kind: "call" }).window.id, 2);
  assert.equal(declines.chooseLeader([main({ focused: true }), peopleWin()]).id, 1);
});

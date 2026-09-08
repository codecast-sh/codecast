// Run: node --test packages/electron/notificationRouter.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyRoute, sameEntity, pickWindow, chooseLeader, RecentKeys, BannerGate, bannerRank,
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

// --- The people window: the phone -------------------------------------------
// While it exists it plays every notification sound and catches every call and
// walkie banner, wherever the user happens to be looking.

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

test("the people window leads the sounds while it exists", () => {
  assert.equal(chooseLeader([main({ focused: true }), peopleWin()]).id, 9, "even over the focused window");
  assert.equal(chooseLeader([main(), peopleWin()]).id, 9, "even over the main window");
  assert.equal(chooseLeader([main(), tabWin(2, "/chat/a", { focused: true })]).id, 2, "no people window: old rule");
});

test("call and walkie banners land in the people window", () => {
  const windows = [main({ active: "/conversation/c1" }), tabWin(2, "/calls"), peopleWin()];
  assert.equal(pickWindow(windows, { route: "/calls", kind: "call" }).window.id, 9);
  // The banner's own route names the DM it came from; the kind still wins.
  assert.equal(pickWindow(windows, { route: "/conversation/c1", kind: "walkie" }).window.id, 9);
  // Anything else keeps its usual home.
  assert.equal(pickWindow(windows, { route: "/conversation/c1" }).window.id, 1);
  // With no people window a call still lands where the call is hosted.
  assert.equal(
    pickWindow([main(), tabWin(2, "/calls", { inCall: true })], { route: null, kind: "call" }).window.id,
    2,
  );
});

// --- BannerGate: whether a banner goes up at all (ct-49551) ------------------
// A manual scheduler, so the 250 ms grace runs without real time.

function fakeClock() {
  let t = 0;
  const timers = new Map();
  let next = 1;
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    // Move time forward and run everything due, oldest first.
    async advance(ms) {
      t += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= t) {
          timers.delete(id);
          timer.fn();
        }
      }
      await Promise.resolve();
    },
  };
}

function gateRig(over = {}) {
  const clock = fakeClock();
  const shown = [];
  const gate = new BannerGate({
    deliver: (p) => shown.push(p),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...over,
  });
  return { clock, shown, gate };
}

let bannerSeq = 0;
const banner = (over = {}) => ({ title: "t", body: "b", data: { key: `k${++bannerSeq}`, ...over } });

test("a focused window silences only the conversation it shows", async () => {
  const { gate, shown } = gateRig();
  const windows = [main({ focused: true, active: "/conversation/c1" })];
  // The thing on screen: the toast and the bell already say it.
  assert.deepEqual(
    gate.admit(windows, banner({ conversationId: "c1", kind: "session_idle" })),
    { shown: false, reason: "focused-active" },
  );
  // Another conversation, same focused app: the old rule swallowed this.
  assert.equal((await gate.admit(windows, banner({ conversationId: "c2", kind: "session_idle" }))).shown, true);
  // A focused window on a list page names no entity, so nothing is on screen.
  assert.equal(
    (await gate.admit([main({ focused: true, active: "/inbox" })], banner({ conversationId: "c3", kind: "session_idle" }))).shown,
    true,
  );
  // An unfocused window never silences a banner, whatever it shows.
  assert.equal(
    (await gate.admit([main({ active: "/conversation/c4" })], banner({ conversationId: "c4", kind: "session_idle" }))).shown,
    true,
  );
  assert.equal(shown.length, 3);
});

test("a ring goes up over the conversation it is about", async () => {
  const { gate } = gateRig();
  const windows = [main({ focused: true, active: "/conversation/c1" })];
  assert.equal((await gate.admit(windows, banner({ conversationId: "c1", force: true }))).shown, true);
  // Two windows reporting the same ring still make one banner.
  const payload = banner({ conversationId: "c1", force: true });
  assert.equal((await gate.admit(windows, payload)).shown, true);
  assert.deepEqual(gate.admit(windows, payload), { shown: false, reason: "duplicate" });
});

test("one conversation banners once per 5 s burst", async () => {
  const { gate, clock, shown } = gateRig();
  const windows = [main()];
  assert.equal((await gate.admit(windows, banner({ conversationId: "c1", kind: "session_idle" }))).shown, true);
  await clock.advance(1000);
  // Answered at once: a banner the cooldown will drop must not sit out the
  // grace first.
  assert.deepEqual(
    gate.admit(windows, banner({ conversationId: "c1", kind: "session_error" })),
    { shown: false, reason: "cooldown" },
  );
  // A different conversation is a different burst.
  assert.equal((await gate.admit(windows, banner({ conversationId: "c2", kind: "session_idle" }))).shown, true);
  await clock.advance(5000);
  assert.equal((await gate.admit(windows, banner({ conversationId: "c1", kind: "session_idle" }))).shown, true);
  assert.equal(shown.length, 3);
});

test("the cooldown remembers at most 50 conversations", async () => {
  const { gate, shown } = gateRig();
  for (let i = 0; i < 60; i++) {
    await gate.admit([main()], banner({ conversationId: `c${i}`, kind: "session_idle" }));
  }
  assert.equal(shown.length, 60);
  assert.equal(gate.cooldown.seen.size, 50);
  // The oldest keys went first; the newest are still held.
  assert.equal(gate.cooldown.seen.has("conversation:c0"), false);
  assert.equal(gate.cooldown.seen.has("conversation:c59"), true);
});

test("a completion arriving with a permission request is the one that fires", async () => {
  const { gate, clock, shown } = gateRig();
  const windows = [main()];
  const request = gate.admit(windows, banner({ conversationId: "c1", kind: "permission_request" }));
  assert.ok(request instanceof Promise, "the request waits out the grace");
  // The completion lands inside the grace: it goes up now and takes the burst.
  assert.equal(gate.admit(windows, banner({ conversationId: "c1", kind: "session_idle" })).shown, true);
  assert.deepEqual(await request, { shown: false, reason: "superseded" });
  await clock.advance(500);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].data.kind, "session_idle");
});

test("a permission request alone still banners, once the grace passes", async () => {
  const { gate, clock, shown } = gateRig();
  const windows = [main()];
  const request = gate.admit(windows, banner({ conversationId: "c1", kind: "permission_request" }));
  assert.equal(shown.length, 0, "nothing fires during the grace");
  // A second request in the same burst rides the one already waiting.
  assert.deepEqual(
    gate.admit(windows, banner({ conversationId: "c1", kind: "permission_request" })),
    { shown: false, reason: "burst" },
  );
  await clock.advance(250);
  assert.deepEqual(await request, { shown: true });
  assert.equal(shown.length, 1);
});

test("a request that follows a fired completion is held by the cooldown", async () => {
  const { gate, clock, shown } = gateRig();
  const windows = [main()];
  assert.equal(gate.admit(windows, banner({ conversationId: "c1", kind: "session_idle" })).shown, true);
  assert.deepEqual(
    gate.admit(windows, banner({ conversationId: "c1", kind: "permission_request" })),
    { shown: false, reason: "cooldown" },
  );
  await clock.advance(250);
  assert.equal(shown.length, 1);
});

test("banners with no conversation keep the plain duplicate rule", async () => {
  const { gate, shown } = gateRig();
  const windows = [main()];
  // Chat, task and doc rows carry no conversation: no cooldown, no grace.
  assert.equal((await gate.admit(windows, banner({ route: "/chat/general" }))).shown, true);
  const second = banner({ route: "/chat/general" });
  assert.equal((await gate.admit(windows, second)).shown, true);
  assert.deepEqual(gate.admit(windows, second), { shown: false, reason: "duplicate" });
  assert.equal(shown.length, 2);
  // A focused window reading that channel still silences it.
  assert.deepEqual(
    gate.admit([main({ focused: true, active: "/chat/general" })], banner({ route: "/chat/general?m=9" })),
    { shown: false, reason: "focused-active" },
  );
});

test("bannerRank puts a completion above everything else", () => {
  assert.equal(bannerRank("session_idle"), 1);
  assert.equal(bannerRank("permission_request"), 0);
  assert.equal(bannerRank(undefined), 0);
});

// Run: node --test packages/electron/meetingDetector.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_MEETING_DETECT,
  mergeMeetingDetect,
  meetingAppList,
  meetingAppName,
  matchProcess,
  detectMeetingApps,
  startedApps,
  decideOffer,
} = require("./meetingDetector");

// A slice of real `ps -Ao comm=` output from a mac, kept verbatim in shape:
// full paths, helper processes, and the FaceTime XPC services that run whether
// or not FaceTime has ever been opened.
const PS_QUIET = `
/usr/sbin/distnoted
/System/Library/PrivateFrameworks/TelephonyUtilities.framework/XPCServices/com.apple.FaceTime.FTConversationService.xpc/Contents/MacOS/com.apple.FaceTime.FTConversationService
/System/Library/PrivateFrameworks/FaceTimeMessageStore.framework/facetimemessagestored
/Applications/Slack.app/Contents/MacOS/Slack
/Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer)
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
`;

const PS_ZOOM = `${PS_QUIET}
/Applications/zoom.us.app/Contents/MacOS/zoom.us
/Applications/zoom.us.app/Contents/Frameworks/aomhost.app/Contents/MacOS/aomhost
`;

// ---------------------------------------------------------------------------
// The table match
// ---------------------------------------------------------------------------

test("an idle mac with no meeting app running detects nothing", () => {
  assert.deepEqual(detectMeetingApps(PS_QUIET), []);
});

// The bug this test exists for: FaceTime's XPC services are resident on every
// mac. A substring match on the word would report a meeting forever.
test("FaceTime's always-resident XPC services are not FaceTime running", () => {
  assert.equal(
    matchProcess(
      "/System/Library/PrivateFrameworks/TelephonyUtilities.framework/XPCServices/com.apple.FaceTime.FTConversationService.xpc/Contents/MacOS/com.apple.FaceTime.FTConversationService",
    ),
    null,
  );
  assert.equal(
    matchProcess("/System/Library/PrivateFrameworks/FaceTimeMessageStore.framework/facetimemessagestored"),
    null,
  );
});

test("the FaceTime app itself does count", () => {
  assert.equal(matchProcess("/System/Applications/FaceTime.app/Contents/MacOS/FaceTime"), "facetime");
});

test("Zoom is one app however many processes it spawns", () => {
  assert.deepEqual(detectMeetingApps(PS_ZOOM), ["zoom"]);
});

test("Teams matches the current binary and the classic bundle", () => {
  assert.equal(matchProcess("/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams"), "teams");
  assert.equal(
    matchProcess("/Applications/Microsoft Teams classic.app/Contents/MacOS/Microsoft Teams"),
    "teams",
  );
});

test("Webex matches both the meetings app and the desktop app", () => {
  assert.equal(matchProcess("/Applications/Webex.app/Contents/MacOS/Webex"), "webex");
  assert.equal(
    matchProcess("/Applications/Cisco Webex Meetings.app/Contents/MacOS/Cisco Webex Meetings"),
    "webex",
  );
});

// A helper lives at <App>.app/Contents/Frameworks/<X>.app/Contents/MacOS/<X>,
// so the bundle rule must not match through the second .app.
test("a lookalike path outside the app's own MacOS directory does not match", () => {
  assert.equal(matchProcess("/Applications/zoom.us.app/Contents/Frameworks/libssl.dylib"), null);
  assert.equal(matchProcess("/Users/me/Downloads/zoom.us.app.zip"), null);
  assert.equal(matchProcess("/Users/me/notes/teams-meeting-agenda.txt"), null);
});

test("blank lines and junk are not processes", () => {
  assert.equal(matchProcess(""), null);
  assert.equal(matchProcess("   "), null);
  assert.equal(matchProcess(null), null);
  assert.deepEqual(detectMeetingApps(""), []);
  assert.deepEqual(detectMeetingApps(undefined), []);
});

// ---------------------------------------------------------------------------
// The fire-once debounce
// ---------------------------------------------------------------------------

// The reason this rule exists, from a real machine: FaceTime.app was already
// running, with nobody on a call. A first observation is a baseline.
test("the first observation offers nothing, however much is already running", () => {
  assert.deepEqual(startedApps(null, ["facetime", "zoom"]), []);
  assert.deepEqual(startedApps(undefined, ["zoom"]), []);
});

test("an app fires when it enters the set", () => {
  assert.deepEqual(startedApps([], ["zoom"]), ["zoom"]);
});

test("an app that stays open fires once, not once per tick", () => {
  // The real sequence: a baseline tick with nothing running, then Zoom opens
  // and stays open for the next hour of ticks.
  let prev = null;
  const fired = [];
  for (const observed of [[], ["zoom"], ["zoom"], ["zoom"], ["zoom"]]) {
    fired.push(...startedApps(prev, observed));
    prev = observed;
  }
  assert.deepEqual(fired, ["zoom"]);
});

// The same sequence with Zoom ALREADY open at the baseline: it never fires, and
// no later tick changes its mind.
test("an app open before the baseline never fires while it stays open", () => {
  let prev = null;
  const fired = [];
  for (const observed of [["zoom"], ["zoom"], ["zoom"]]) {
    fired.push(...startedApps(prev, observed));
    prev = observed;
  }
  assert.deepEqual(fired, []);
});

test("quitting and reopening fires again — that is a second meeting", () => {
  let prev = [];
  const fired = [];
  for (const observed of [["zoom"], [], ["zoom"]]) {
    fired.push(...startedApps(prev, observed));
    prev = observed;
  }
  assert.deepEqual(fired, ["zoom", "zoom"]);
});

test("two apps starting on the same tick both fire", () => {
  assert.deepEqual(startedApps([], ["teams", "zoom"]), ["teams", "zoom"]);
});

test("one app starting beside one already running fires only the new one", () => {
  assert.deepEqual(startedApps(["zoom"], ["teams", "zoom"]), ["teams"]);
});

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

test("nothing persisted → ask, with an empty never-list", () => {
  assert.deepEqual(mergeMeetingDetect(undefined), DEFAULT_MEETING_DETECT);
  assert.deepEqual(mergeMeetingDetect({}), DEFAULT_MEETING_DETECT);
});

test("a corrupt settings file falls back to the default rather than to off", () => {
  assert.equal(mergeMeetingDetect({ mode: "sometimes" }).mode, "ask");
  assert.equal(mergeMeetingDetect({ mode: 3 }).mode, "ask");
  assert.deepEqual(mergeMeetingDetect({ never: "zoom" }).never, []);
});

test("a never-list entry for a retired app is dropped", () => {
  assert.deepEqual(mergeMeetingDetect({ never: ["zoom", "hangouts", "zoom"] }).never, ["zoom"]);
});

test("off refuses every app, including one never refused by hand", () => {
  assert.equal(decideOffer({ mode: "off" }, "zoom"), "skip");
  assert.equal(decideOffer({ mode: "off", never: [] }, "teams"), "skip");
});

test("ask offers, auto starts", () => {
  assert.equal(decideOffer({ mode: "ask" }, "zoom"), "ask");
  assert.equal(decideOffer({ mode: "auto" }, "zoom"), "auto");
});

test('"never for this app" is per app, and survives auto', () => {
  assert.equal(decideOffer({ mode: "ask", never: ["zoom"] }, "zoom"), "skip");
  assert.equal(decideOffer({ mode: "ask", never: ["zoom"] }, "teams"), "ask");
  assert.equal(decideOffer({ mode: "auto", never: ["zoom"] }, "zoom"), "skip");
});

test("the app table the settings UI reads names every app the matcher knows", () => {
  const ids = meetingAppList().map((a) => a.id);
  assert.deepEqual(ids.sort(), ["facetime", "teams", "webex", "zoom"]);
  assert.equal(meetingAppName("zoom"), "Zoom");
  assert.equal(meetingAppName("teams"), "Microsoft Teams");
  // An id with no row still renders as something rather than as undefined.
  assert.equal(meetingAppName("gone"), "gone");
});

// ---------------------------------------------------------------------------
// The whole chain, as main.js composes it.
//
// This drives the pure pieces in the exact order meetingTick / offerToRecord
// call them, over a sequence of `ps` snapshots. It proves the POLICY end to
// end — what fires and what does not. Addressing needs no policy any more:
// every offer goes to the dedicated meeting-offer window, which reveals
// itself (without focus) when its renderer has content to show. It does not
// prove main.js's own plumbing (the timer, the spawn, the send), which needs
// the shell; ct-46038's live run covers that.
// ---------------------------------------------------------------------------

const ps = (...paths) => paths.join("\n");
const ZOOM = "/Applications/zoom.us.app/Contents/MacOS/zoom.us";
const TEAMS = "/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams";
const IDLE = "/usr/sbin/distnoted";

// One tick: what main.js does between reading ps and sending the event.
function tick(state, psOutput, settings) {
  const observed = detectMeetingApps(psOutput);
  const started = startedApps(state.running, observed);
  state.running = observed;
  const sent = [];
  for (const id of started) {
    const decision = decideOffer(settings, id);
    if (decision === "skip") continue;
    sent.push({ app: id, decision });
  }
  return sent;
}

test("trace: an idle machine, then Zoom opens, then a second meeting app", () => {
  const state = { running: null };
  const settings = { mode: "ask", never: [] };

  assert.deepEqual(tick(state, ps(IDLE), settings), [], "baseline is silent");
  assert.deepEqual(
    tick(state, ps(IDLE, ZOOM), settings),
    [{ app: "zoom", decision: "ask" }],
    "Zoom opening asks",
  );
  assert.deepEqual(tick(state, ps(IDLE, ZOOM), settings), [], "and does not ask again");
  assert.deepEqual(
    tick(state, ps(IDLE, ZOOM, TEAMS), settings),
    [{ app: "teams", decision: "ask" }],
    "a second app asks for itself only",
  );
});

test("trace: auto records without asking, off never even looks", () => {
  const auto = { running: null };
  assert.deepEqual(tick(auto, ps(IDLE), { mode: "auto" }), []);
  assert.deepEqual(tick(auto, ps(IDLE, ZOOM), { mode: "auto" }), [
    { app: "zoom", decision: "auto" },
  ]);

  // main.js does not even run the timer when the mode is off; this is the
  // second gate, so a stale tick in flight across a setting change is silent.
  const off = { running: null };
  assert.deepEqual(tick(off, ps(IDLE), { mode: "off" }), []);
  assert.deepEqual(tick(off, ps(IDLE, ZOOM), { mode: "off" }), []);
});

test("trace: never for Zoom is silent while Teams still asks", () => {
  const state = { running: null };
  const settings = { mode: "ask", never: ["zoom"] };
  assert.deepEqual(tick(state, ps(IDLE), settings), []);
  assert.deepEqual(
    tick(state, ps(IDLE, ZOOM, TEAMS), settings),
    [{ app: "teams", decision: "ask" }],
    "Zoom is refused, Teams is not",
  );
});

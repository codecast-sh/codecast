// Pure logic for meeting detection: which running processes are a meeting app,
// which of them just started, and what the setting says to do about it. No
// electron and no child_process here — main.js owns the one `ps` spawn and the
// timer, so this file is unit tested with node --test (meetingDetector.test.js).
//
// WHAT THIS READS, AND WHAT IT DOES NOT. The names of running programs, and
// nothing else. No window titles, no window contents, no accessibility API, no
// calendar. The setting's copy says exactly this, and this file is what makes
// that sentence true.

// The table. `binaries` are matched as an EXACT executable name; `bundles` are
// matched as `/<Bundle>.app/Contents/MacOS/` inside the full path. Both are
// deliberately narrow, because the cost of a false positive is a popup during
// somebody's focused afternoon.
//
// Two things a looser match would get wrong, both observed on a real machine:
// `com.apple.FaceTime.FTConversationService` runs resident under
// PrivateFrameworks whether or not FaceTime has ever been opened, so a
// substring match on "FaceTime" fires forever on a machine that does not use
// it; and every Electron meeting app spawns helpers at
// `<App>.app/Contents/Frameworks/<App> Helper.app/Contents/MacOS/…`, which the
// bundle rule steps over because the helper's own `.app` sits between the
// bundle and its MacOS directory.
const MEETING_APPS = [
  {
    id: "zoom",
    name: "Zoom",
    binaries: ["zoom.us", "ZoomPhone"],
    bundles: ["zoom.us.app"],
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    // MSTeams is the current binary; the two older names are the classic app,
    // which plenty of machines still run.
    binaries: ["MSTeams", "Microsoft Teams", "Teams"],
    bundles: [
      "Microsoft Teams.app",
      "Microsoft Teams (work or school).app",
      "Microsoft Teams classic.app",
    ],
  },
  {
    id: "webex",
    name: "Webex",
    binaries: ["Webex", "Cisco Webex Meetings", "Meeting Center"],
    bundles: ["Webex.app", "Cisco Webex Meetings.app"],
  },
  {
    id: "facetime",
    name: "FaceTime",
    binaries: ["FaceTime"],
    bundles: ["FaceTime.app"],
  },
];

const MEETING_MODES = ["off", "ask", "auto"];
const DEFAULT_MEETING_DETECT = { mode: "ask", never: [] };

// Persisted `meetingDetect` from settings.json (may be undefined or anything at
// all — a file a person can edit) → the effective setting. An unknown mode
// falls back to the default rather than disabling detection silently, and the
// never-list is filtered to apps that still exist in the table so a retired
// entry cannot linger as a permanent refusal.
function mergeMeetingDetect(persisted) {
  const mode = MEETING_MODES.includes(persisted?.mode) ? persisted.mode : DEFAULT_MEETING_DETECT.mode;
  const never = Array.isArray(persisted?.never)
    ? persisted.never.filter((id) => MEETING_APPS.some((a) => a.id === id))
    : [];
  return { mode, never: [...new Set(never)].sort() };
}

/** The table as the settings UI needs it, so the web never carries a second
 *  copy of these names. */
function meetingAppList() {
  return MEETING_APPS.map(({ id, name }) => ({ id, name }));
}

function meetingAppName(id) {
  return MEETING_APPS.find((a) => a.id === id)?.name ?? id;
}

// One line of `ps -Ao comm=` (a full executable path) → an app id, or null.
function matchProcess(line) {
  const cmd = String(line || "").trim();
  if (!cmd) return null;
  const base = cmd.slice(cmd.lastIndexOf("/") + 1);
  for (const app of MEETING_APPS) {
    if (app.binaries.includes(base)) return app.id;
    for (const bundle of app.bundles) {
      if (cmd.includes(`/${bundle}/Contents/MacOS/`)) return app.id;
    }
  }
  return null;
}

/** Whole `ps -Ao comm=` output → the meeting apps running now, sorted so two
 *  observations of the same machine compare as equal. */
function detectMeetingApps(psOutput) {
  const found = new Set();
  for (const line of String(psOutput || "").split("\n")) {
    const id = matchProcess(line);
    if (id) found.add(id);
  }
  return [...found].sort();
}

/**
 * The debounce, and it is the whole of it: a meeting starts when an app ENTERS
 * the running set, so an app that stays open fires once per launch and not
 * once per tick.
 *
 * `prev` of null means this is the first observation — the baseline. It fires
 * nothing, which is what keeps turning the setting on (or launching Codecast)
 * from popping a card about the Zoom that has been open since breakfast.
 */
function startedApps(prev, next) {
  if (prev === null || prev === undefined) return [];
  const before = new Set(prev);
  return next.filter((id) => !before.has(id));
}

/**
 * What to do about an app that just started. "skip" covers both refusals — the
 * setting is off, or this app was answered "never" — so a caller has one
 * branch to write and cannot forget the second.
 */
function decideOffer(settings, appId) {
  const { mode, never } = mergeMeetingDetect(settings);
  if (mode === "off") return "skip";
  if (never.includes(appId)) return "skip";
  return mode === "auto" ? "auto" : "ask";
}

module.exports = {
  MEETING_APPS,
  MEETING_MODES,
  DEFAULT_MEETING_DETECT,
  mergeMeetingDetect,
  meetingAppList,
  meetingAppName,
  matchProcess,
  detectMeetingApps,
  startedApps,
  decideOffer,
};

// Pure policy for native notifications when the desktop runs several windows
// (the main window, detached tab windows, the people window). No Electron here — main.js
// feeds it plain window descriptors so it can be unit tested with node --test.
//
// Three decisions live here:
//   1. classifyRoute / pickWindow — which window a banner click should land in.
//   2. chooseLeader — the ONE window allowed to play notification sounds.
//   3. RecentKeys — a short memory of shown banners so N renderers reporting
//      the same server row produce one banner, not N.
//
// A window descriptor:
//   { id, isMain, isPeople, focused, lastFocusedAt, active, open, inCall }
//   active:   the path this window shows now (main: its active tab; detached: its URL)
//   open:     [{ id, path }] every surface the window could switch to (main: its tabs)
//   inCall:   this renderer hosts a connected huddle
//   isPeople: the people window — the floating buddy list. It IS the phone: it
//             carries the roster, the call and walkie pumps and their sounds.
// A target:
//   { route, kind } — route is the banner's click path (may be null); kind is a
//   hint for routeless banners ("call" for a ring).

// Areas group routes that live on the same page family. Two paths in the same
// area are "near" each other: a chat banner prefers a window already on chat.
const AREA_PREFIXES = [
  ["chat", ["/chat"]],
  ["conversation", ["/conversation", "/inbox"]],
  ["task", ["/tasks"]],
  ["doc", ["/docs"]],
  ["plan", ["/plans"]],
  ["call", ["/calls"]],
];

function stripPath(p) {
  return typeof p === "string" ? p.split("?")[0].split("#")[0] : "";
}

function areaOf(path) {
  const clean = stripPath(path);
  for (const [area, prefixes] of AREA_PREFIXES) {
    for (const prefix of prefixes) {
      if (clean === prefix || clean.startsWith(prefix + "/")) return area;
    }
  }
  return null;
}

// { area, id } for a route. `id` is the entity the page is about, when the
// path names one (/chat/<channel>, /conversation/<id>, /tasks/<id>...).
function classifyRoute(route) {
  const clean = stripPath(route);
  const area = areaOf(clean);
  if (!area) return { area: null, id: null };
  const seg = clean.split("/").filter(Boolean);
  // /conversation/<id>, /chat/<id>, /tasks/<id>... name their entity in the
  // path. An inbox tab names the conversation it shows as /inbox?s=<id> (the
  // form the tab store stamps on background tabs); a bare /inbox names none.
  if (seg[0] === "inbox") {
    const m = typeof route === "string" ? route.match(/[?&]s=([^&#]+)/) : null;
    return { area, id: m ? decodeURIComponent(m[1]) : null };
  }
  return { area, id: seg[1] || null };
}

// Same page family and the same entity (when both name one).
function sameEntity(a, b) {
  const ca = classifyRoute(a);
  const cb = classifyRoute(b);
  return !!ca.area && ca.area === cb.area && !!ca.id && ca.id === cb.id;
}

// Rank windows for a click target. Highest score wins; ties go to the main
// window, then to whichever window the user focused most recently.
//
//   people window, call or walkie target 110
//   exact entity on the active surface   100
//   in-call window, call target          100
//   exact entity on an open tab           80
//   same area on the active surface       60
//   same area on an open tab              40
//   main window (the default home)        20
//   anything else                         10
function scoreWindow(win, target) {
  const route = target && target.route;
  const cls = classifyRoute(route);
  const kind = (target && target.kind) || null;
  const area = cls.area || kind || null;
  const openPaths = (win.open || []).map((t) => t.path);

  // The people window answers every ring. Keyed on the banner's KIND, not its
  // route, because a call or walkie banner usually carries the DM route it came
  // from — which would otherwise send the click to whichever window shows that
  // conversation, away from the window hosting the audio.
  if (win.isPeople && (kind === "call" || kind === "walkie")) return 110;
  if (route && win.active && sameEntity(win.active, route)) return 100;
  if (area === "call" && win.inCall) return 100;
  if (route && openPaths.some((p) => sameEntity(p, route))) return 80;
  if (area && areaOf(win.active) === area) return 60;
  if (area && openPaths.some((p) => areaOf(p) === area)) return 40;
  return win.isMain ? 20 : 10;
}

// Returns { window, tabId } — tabId names the open (non-active) tab the
// renderer should switch to before navigating: the tab already on the target
// entity, else a tab in the target's area when the active tab is not (a task
// banner opens in the Tasks tab, not over the inbox). Null when no windows.
function pickWindow(windows, target) {
  let best = null;
  let bestScore = -1;
  for (const win of windows) {
    const score = scoreWindow(win, target);
    if (
      score > bestScore ||
      (score === bestScore && best && tieBreak(win, best) > 0)
    ) {
      best = win;
      bestScore = score;
    }
  }
  if (!best) return null;
  const route = target && target.route;
  let tabId = null;
  if (route && !(best.active && sameEntity(best.active, route))) {
    const open = (best.open || []).filter((t) => t.id);
    const area = classifyRoute(route).area;
    const hit =
      open.find((t) => sameEntity(t.path, route)) ||
      (area && areaOf(best.active) !== area ? open.find((t) => areaOf(t.path) === area) : null);
    if (hit) tabId = hit.id;
  }
  return { window: best, tabId };
}

function tieBreak(a, b) {
  if (!!a.isMain !== !!b.isMain) return a.isMain ? 1 : -1;
  return (a.lastFocusedAt || 0) - (b.lastFocusedAt || 0);
}

// The one window that plays notification sounds. While a people window exists
// it is the leader, focused or not: it is the phone, it mounts the call and
// walkie pumps, and its sounds are the ones that must never be missed. With no
// people window the old rule stands: the focused window (sound comes from where
// the user is), else the main window, else the window focused most recently.
// Null when there are no windows.
//
// THE CALL PANEL DOES NOT TAKE LEADERSHIP, and that is a decision rather than
// an omission. The two kinds of sound come apart cleanly:
//
//   The call's OWN sounds — someone joining or leaving the room — are not
//   gated on the leader at all (lib/sounds soundCallJoin/soundCallLeave check
//   only whether sounds are on). They fire in the renderer holding the room,
//   which IS the panel. So the panel already sounds its own call, with no rule
//   needed, and giving it leadership would change nothing about them.
//
//   What the leader gates is ANNOUNCEMENTS — a ring, a knock, a walkie burst,
//   a message. Those are things arriving from outside the call, and the window
//   that should announce them is the phone: the buddy list if there is one,
//   else wherever the person is looking. Handing them to the panel would move
//   the ringer into a window that appears when a call starts and disappears
//   when it ends — a phone that comes and goes with the conversation.
//
// So the panel is an ordinary window here. It is in `appWindows` because
// `anyInCall` is computed from these descriptors and that is what tells every
// other window to show "in a huddle in another window", and because a focused
// panel with no buddy list open should sound what it is looking at — which the
// existing focused-window rule already gives it.
function chooseLeader(windows) {
  if (!windows.length) return null;
  const people = windows.find((w) => w.isPeople);
  if (people) return people;
  const focused = windows.find((w) => w.focused);
  if (focused) return focused;
  const main = windows.find((w) => w.isMain);
  if (main) return main;
  return windows.reduce((a, b) => (tieBreak(b, a) > 0 ? b : a));
}

// Remembers banner keys for a while so duplicate reports collapse. Callers
// without a stable key get one from the banner's text and click target: two
// windows reporting the same server row send byte-identical text.
class RecentKeys {
  constructor(ttlMs = 60_000, now = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.seen = new Map();
  }
  static keyFor(payload) {
    if (payload && payload.data && payload.data.key) return String(payload.data.key);
    const route = payload && payload.data && payload.data.route;
    return `${payload && payload.title}|${payload && payload.body}|${route || ""}`;
  }
  // True the first time a key is seen inside the TTL window.
  claim(key) {
    const t = this.now();
    for (const [k, at] of this.seen) if (t - at > this.ttlMs) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, t);
    return true;
  }
}

module.exports = { areaOf, classifyRoute, sameEntity, scoreWindow, pickWindow, chooseLeader, RecentKeys };

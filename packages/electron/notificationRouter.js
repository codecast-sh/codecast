// Which window a notification's click lands in, which window plays the sound,
// and which duplicate reports collapse into one banner. No Electron here —
// main.js feeds it plain window descriptors.
//
// The routing itself is @platform/desktop's now. Its default route table IS
// this one (the package was lifted from this file), so `areas` and
// `entityQueryParams` are left alone; what codecast adds on top is the people
// window, which the package knows nothing about and takes as two hooks.
//
// Window descriptors main.js supplies:
//   { id, isMain, isPeople, isCallPanel, focused, lastFocusedAt, active, open, inCall }
//   active:   the path this window shows now (main: its active tab; detached: its URL)
//   open:     [{ id, path }] every surface the window could switch to (main: its tabs)
//   inCall:   this renderer hosts a connected huddle
//   isPeople: the people window — the floating buddy list. It IS the phone: it
//             carries the roster, the call and walkie pumps and their sounds.
//
// Exports areaOf, classifyRoute, sameEntity, scoreWindow, pickWindow,
// chooseLeader and RecentKeys unchanged, plus BannerGate — codecast's own
// decision about WHETHER a banner goes up at all (see the block below it).

const { createNotificationRouter } = require("@platform/desktop").notificationRouter;

const router = createNotificationRouter({
  // The people window answers every ring. Keyed on the banner's KIND, not its
  // route, because a call or walkie banner usually carries the DM route it came
  // from — which would otherwise send the click to whichever window shows that
  // conversation, away from the window hosting the audio.
  windowBonus: (win, target) => {
    const kind = (target && target.kind) || null;
    return win.isPeople && (kind === "call" || kind === "walkie") ? 110 : null;
  },

  // While a people window exists it plays the notification sounds, focused or
  // not: it is the phone, it mounts the call and walkie pumps, and its sounds
  // are the ones that must never be missed. With no people window the package's
  // rule stands: the focused window, else the main window, else the window
  // focused most recently.
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
  preferredLeader: (windows) => windows.find((w) => w.isPeople) || null,
});

// ---------------------------------------------------------------------------
// BannerGate — whether an OS banner goes up (ct-49551). Pure: main.js hands it
// window descriptors and a payload, it answers and calls `deliver`.
//
// Three rules, all borrowed from Orca (src/main/ipc/notifications.ts,
// notification-burst-cooldown.ts, agent-task-complete-policy.ts):
//
//   1. Focused AND on screen. The old rule dropped every banner while ANY app
//      window held focus, so a session finishing in a tab you were not looking
//      at said nothing at all. Suppress only when a focused window already
//      shows the very thing the banner is about — there the toast and the bell
//      say it, and a banner on top is noise.
//   2. Per-conversation cooldown, 5 s. A session that flips ready → needs
//      permission → ready inside a few seconds is one episode, not three
//      banners. Bounded to 50 keys so a long-lived shell cannot grow a key per
//      conversation forever.
//   3. Completion grace, 250 ms. A permission request and a completion for one
//      conversation arrive together; hold the request that long so the
//      completion — which says what actually happened — is the one that fires.
// ---------------------------------------------------------------------------

const BANNER_COOLDOWN_MS = 5_000;
const BANNER_COOLDOWN_KEYS = 50;
const BANNER_GRACE_MS = 250;

// `session_idle` is codecast's completion: the daemon writes it when a
// session's turn settles. It outranks a permission request for the same
// conversation, which only says the agent stopped.
const COMPLETION_KINDS = new Set(["session_idle"]);

function bannerRank(kind) {
  return COMPLETION_KINDS.has(String(kind || "")) ? 1 : 0;
}

// Why: RecentKeys forgets only on TTL, so a shell that runs for days keeps a
// key per conversation it ever notified about. The cap bounds it, oldest first.
class BurstCooldown extends router.RecentKeys {
  constructor(ttlMs = BANNER_COOLDOWN_MS, now = undefined, maxKeys = BANNER_COOLDOWN_KEYS) {
    super(ttlMs, now || (() => Date.now()));
    this.maxKeys = maxKeys;
  }
  claim(key) {
    const ok = super.claim(key);
    // Map iterates in insertion order, so the front is the least recent.
    while (this.seen.size > this.maxKeys) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    return ok;
  }
  // Still inside the cooldown, asked WITHOUT reserving — a banner that will be
  // dropped anyway must not sit out the grace first to be told so.
  cooling(key) {
    const at = this.seen.get(key);
    return at !== undefined && this.now() - at <= this.ttlMs;
  }
}

// True when a window the user is looking at already shows what the banner is
// about. `sameEntity` needs an entity on both sides, so a routeless banner — or
// a window sitting on a bare list page — is never "the active view".
function showsBannerEntity(windows, route) {
  if (!route) return false;
  return (windows || []).some((w) => w && w.focused && router.sameEntity(w.active, route));
}

class BannerGate {
  constructor({
    deliver,
    now = () => Date.now(),
    cooldownMs = BANNER_COOLDOWN_MS,
    cooldownKeys = BANNER_COOLDOWN_KEYS,
    graceMs = BANNER_GRACE_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.deliverBanner = deliver;
    this.graceMs = graceMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.recent = new router.RecentKeys(60_000, now);
    this.cooldown = new BurstCooldown(cooldownMs, now, cooldownKeys);
    this.held = new Map(); // conversation key → { timer, resolve }
  }

  // { shown, reason } — a promise while a banner waits out the grace.
  admit(windows, payload) {
    const data = (payload && payload.data) || {};
    const force = data.force === true;
    const route = data.route || (data.conversationId ? `/conversation/${data.conversationId}` : null);
    // A ring is for a person who is not looking, and "the app is in front" does
    // not mean they are. It skips every rule below except the duplicate collapse.
    if (!force && showsBannerEntity(windows, route)) return { shown: false, reason: "focused-active" };
    if (!this.recent.claim(router.RecentKeys.keyFor(payload))) return { shown: false, reason: "duplicate" };

    // The burst rules are per conversation. A chat, task or doc banner carries
    // no conversation and is deduped by its row id alone, as it always was.
    const key = data.conversationId ? `conversation:${data.conversationId}` : null;
    if (force || !key) return this.#fire(payload, null);

    if (bannerRank(data.kind) > 0) {
      this.#release(key, { shown: false, reason: "superseded" });
      return this.#fire(payload, key);
    }
    if (this.held.has(key)) return { shown: false, reason: "burst" };
    if (this.cooldown.cooling(key)) return { shown: false, reason: "cooldown" };
    return new Promise((resolve) => {
      const timer = this.setTimer(() => {
        this.held.delete(key);
        resolve(this.#fire(payload, key));
      }, this.graceMs);
      this.held.set(key, { timer, resolve });
    });
  }

  // Drop whatever is waiting out the grace for this conversation.
  #release(key, result) {
    const held = this.held.get(key);
    if (!held) return;
    this.held.delete(key);
    this.clearTimer(held.timer);
    held.resolve(result);
  }

  #fire(payload, key) {
    if (key && !this.cooldown.claim(key)) return { shown: false, reason: "cooldown" };
    this.deliverBanner(payload);
    return { shown: true };
  }
}

module.exports = { ...router, BannerGate, bannerRank };

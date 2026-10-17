// The menu bar's accelerators, following the person's own key bindings.
//
// A few menu items repeat a web shortcut as a native accelerator (Settings,
// New Session, Back, Forward, Undo, Redo), and on a Mac the menu takes its key
// before the page. So when the person rebinds one of those actions in the web
// app, the page sends what changed (desktopMenuKeys in
// shared/contracts/keyBindings.ts) and the menu rebuilds from it: a rebound
// item shows and answers to its new chord, and an item whose chord the person
// gave to another action lets it go. With no rebinding the menu keeps its own
// defaults.

const MENU_ACTIONS = new Set(["ui.openSettings", "session.create", "nav.back", "nav.forward", "ui.undo", "ui.redo"]);
const ACCELERATOR = /^[A-Za-z0-9+,./;'[\]\\`=-]{1,40}$/;

/** One accelerator in a comparable form: modifiers named and sorted. */
function normalize(accelerator, isMac) {
  const parts = String(accelerator).split("+");
  const key = parts.pop().toLowerCase();
  const mods = parts.map((p) => {
    const m = p.toLowerCase();
    if (m === "cmdorctrl" || m === "commandorcontrol") return isMac ? "command" : "control";
    if (m === "cmd") return "command";
    if (m === "ctrl") return "control";
    if (m === "option") return "alt";
    return m;
  });
  return [...mods.sort(), key].join("+");
}

function createMenuKeys({ isMac = process.platform === "darwin" } = {}) {
  let state = null;
  const same = (a, b) => normalize(a, isMac) === normalize(b, isMac);

  /** Takes the page's report; returns whether the menu must rebuild. */
  function set(raw) {
    let next = null;
    if (raw && typeof raw === "object") {
      const keys = {};
      for (const [action, list] of Object.entries(raw.keys ?? {})) {
        if (MENU_ACTIONS.has(action) && Array.isArray(list)) keys[action] = list.filter((a) => typeof a === "string" && ACCELERATOR.test(a)).slice(0, 8);
      }
      const claimed = Array.isArray(raw.claimed) ? raw.claimed.filter((a) => typeof a === "string" && ACCELERATOR.test(a)).slice(0, 200) : [];
      next = { keys, claimed };
    }
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    return changed;
  }

  /** The accelerator a menu item shows; undefined for none. */
  function accelerator(action, fallback) {
    if (!state) return fallback;
    if (action in state.keys) return state.keys[action][0];
    return state.claimed.some((a) => same(a, fallback)) ? undefined : fallback;
  }

  /** Whether the menu's own chord still means this action (Undo and Redo keep
   *  their chord for text editing, but stop running the app's undo when the
   *  person moved that action elsewhere). */
  function chordRuns(action, chord) {
    if (!state) return true;
    if (action in state.keys) return state.keys[action].some((a) => same(a, chord));
    return !state.claimed.some((a) => same(a, chord));
  }

  return { set, accelerator, chordRuns };
}

module.exports = { createMenuKeys };

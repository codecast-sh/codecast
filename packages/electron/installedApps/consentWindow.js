// The consent sheet's window (docs/architecture/installed-apps.md, "Desktop
// bridge for the web app"). One web route, /apps/consent/<id>, serves install,
// cast.app.permissions.request and the re-ask after a new version. Main opens
// it in a small focused shell window centered over the app asking, the route
// reads its request with apps.consent.get(id) and answers with
// apps.consent.answer(id, {approve, grants}). Closing the window is a refusal.
// The route reports its natural height with apps.consent.resize(id, height):
// the window takes that content height, never taller than the work area, and
// stays centered over the app asking. It shows on the first report (or after a
// short wait, for a route that never reports), so it never jumps on screen.
//
// createConsentWindows({createWindow, url, display})
//   createWindow(options) -> a BrowserWindow built as a shell window (the
//                            shell preload and authority), so the route can
//                            reach apps.consent
//   url(id)               -> the route's address in the shell's current origin
//   display()             -> the work area to center in when no app window
//                            is given: {x, y, width, height}
//
// ask(request, anchor?) resolves to {grants} when approved, or null.
// `request` is a ConsentRequest without its id; `anchor` is the asking app's
// window bounds.
const crypto = require("node:crypto");

const SIZE = { width: 460, height: 620 };
/** The shortest sheet: a header, one row and the footer. */
const MIN_HEIGHT = 240;
/** How long a window waits for the route's first height before showing anyway. */
const SHOW_FALLBACK_MS = 400;
/**
 * The sheet's window level: above every level an installed app can reach.
 * An app with `overlay` sits at "floating" (Electron's setAlwaysOnTop, the
 * shim's NSWindow.Level.floating) and can turn click-through on, and the
 * shim's tray panel sits at pop-up-menu. At the same level the app could
 * order itself over the sheet and draw a decoy over its switches while the
 * clicks pass through to them.
 */
const CONSENT_LEVEL = "screen-saver";

/** Where a window of `size` sits centered on `anchor`, kept inside `area`. */
function centeredOn(anchor, size, area) {
  const base = anchor || area;
  let x = Math.round(base.x + (base.width - size.width) / 2);
  let y = Math.round(base.y + (base.height - size.height) / 2);
  if (area) {
    x = Math.min(Math.max(x, area.x), area.x + Math.max(0, area.width - size.width));
    y = Math.min(Math.max(y, area.y), area.y + Math.max(0, area.height - size.height));
  }
  return { x, y };
}

/**
 * Where a consent window of `height` content pixels goes: the content height
 * clamped to [MIN_HEIGHT, what fits the work area under the window's own
 * chrome], and the outer frame centered on `anchor` inside `area`.
 */
function fitConsent({ height, width, chrome = 0, anchor, area }) {
  const room = area ? area.height - chrome : Infinity;
  const contentHeight = Math.max(Math.min(MIN_HEIGHT, room), Math.min(Math.ceil(height), room));
  const { x, y } = centeredOn(anchor, { width, height: contentHeight + chrome }, area);
  return { contentHeight, x, y };
}

const uniq = (list) => [...new Set(Array.isArray(list) ? list.filter((p) => typeof p === "string") : [])];

function createConsentWindows({ createWindow, url, display, newId = () => crypto.randomBytes(9).toString("base64url") }) {
  const pending = new Map(); // id -> {request, resolve, win, key}

  function settle(id, answer) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.fallback);
    entry.resolve(answer);
    // Closed on the next turn, so the route's own answer() call gets its reply.
    const win = entry.win;
    if (win && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.close(), 0);
    return true;
  }

  /** Shows the window once, on the route's first height or the fallback, whichever comes first. */
  function reveal(entry) {
    clearTimeout(entry.fallback);
    entry.fallback = null;
    const win = entry.win;
    if (entry.shown || !win || win.isDestroyed()) return;
    entry.shown = true;
    win.show();
    win.focus();
  }

  /**
   * Opens the sheet. A second ask for the same app and kind while one is open
   * brings that window forward and shares its answer.
   */
  function ask(request, anchor = null) {
    const key = `${request.info && request.info.slug}:${request.kind}`;
    for (const entry of pending.values()) {
      if (entry.key === key) {
        if (entry.win && !entry.win.isDestroyed()) entry.win.focus();
        return entry.promise;
      }
    }
    const id = newId();
    const full = {
      id,
      kind: request.kind,
      info: request.info,
      asked: uniq(request.asked),
      current: uniq(request.current),
      added: uniq(request.added),
    };
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    const entry = { request: full, resolve, win: null, key, promise };
    pending.set(id, entry);

    const area = display(anchor);
    const { x, y } = centeredOn(anchor, SIZE, area);
    const win = createWindow({
      ...SIZE,
      x,
      y,
      useContentSize: true,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: request.info && request.info.app ? request.info.app.name : "Install app",
    });
    Object.assign(entry, { win, anchor, area, shown: false, fallback: null });
    win.setAlwaysOnTop(true, CONSENT_LEVEL);
    // The fallback only for a window still waiting: the route's height may come first.
    win.once("ready-to-show", () => {
      if (entry.shown || entry.fallback || pending.get(id) !== entry) return;
      entry.fallback = setTimeout(() => reveal(entry), SHOW_FALLBACK_MS);
    });
    // Closing it any way at all is a refusal.
    win.on("closed", () => settle(id, null));
    win.loadURL(url(id));
    return promise;
  }

  return {
    ask,
    /** The request the route renders, or null for an id that is not open. */
    get: (id) => (pending.has(id) ? pending.get(id).request : null),
    /** The route's answer. Approve carries the complete grant list for the version. */
    answer(id, answer) {
      const entry = pending.get(id);
      if (!entry) return false;
      if (!answer || answer.approve !== true) return settle(id, null);
      return settle(id, { grants: uniq(answer.grants) });
    },
    /** The route's natural content height: the window fits it, centered over the asking app, and shows. */
    resize(id, height) {
      const entry = pending.get(id);
      const win = entry && entry.win;
      if (!win || win.isDestroyed() || !Number.isFinite(height) || height <= 0) return false;
      const outer = win.getBounds();
      const chrome = Math.max(0, outer.height - win.getContentBounds().height);
      const fit = fitConsent({ height, width: outer.width, chrome, anchor: entry.anchor, area: entry.area });
      win.setContentSize(win.getContentBounds().width, fit.contentHeight);
      win.setPosition(fit.x, fit.y);
      reveal(entry);
      return true;
    },
    /** Refuses everything open (the app quitting, or the asking app going away). */
    cancelAll(slug) {
      for (const [id, entry] of [...pending]) if (!slug || entry.key.startsWith(`${slug}:`)) settle(id, null);
    },
    size: () => pending.size,
  };
}

module.exports = { createConsentWindows, centeredOn, fitConsent, CONSENT_SIZE: SIZE, CONSENT_MIN_HEIGHT: MIN_HEIGHT, CONSENT_LEVEL };

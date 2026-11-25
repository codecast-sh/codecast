// The consent sheet's window (docs/architecture/installed-apps.md, "Desktop
// bridge for the web app"). One web route, /apps/consent/<id>, serves install,
// cast.app.permissions.request and the re-ask after a new version. Main opens
// it in a small focused shell window centered over the app asking, the route
// reads its request with apps.consent.get(id) and answers with
// apps.consent.answer(id, {approve, grants}). Closing the window is a refusal.
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

const uniq = (list) => [...new Set(Array.isArray(list) ? list.filter((p) => typeof p === "string") : [])];

function createConsentWindows({ createWindow, url, display, newId = () => crypto.randomBytes(9).toString("base64url") }) {
  const pending = new Map(); // id -> {request, resolve, win, key}

  function settle(id, answer) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    entry.resolve(answer);
    // Closed on the next turn, so the route's own answer() call gets its reply.
    const win = entry.win;
    if (win && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.close(), 0);
    return true;
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

    const { x, y } = centeredOn(anchor, SIZE, display(anchor));
    const win = createWindow({
      ...SIZE,
      x,
      y,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: request.info && request.info.app ? request.info.app.name : "Install app",
    });
    entry.win = win;
    win.setAlwaysOnTop(true, "floating");
    win.once("ready-to-show", () => {
      win.show();
      win.focus();
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
    /** Refuses everything open (the app quitting, or the asking app going away). */
    cancelAll(slug) {
      for (const [id, entry] of [...pending]) if (!slug || entry.key.startsWith(`${slug}:`)) settle(id, null);
    },
    size: () => pending.size,
  };
}

module.exports = { createConsentWindows, centeredOn, CONSENT_SIZE: SIZE };

// Teammates' cursors on the sharer's own screen.
//
// On a call, everyone watching a screen share can point at it: their pointer
// rides the LiveKit data channel as a point normalized to the share's frame
// (web lib/calls/callCursors.ts) and is drawn over their copy of the share.
// The person sharing is looking at the real thing, not at a tile, so for them
// the arrows have to land on the real screen: the pixel a viewer points at in
// the video is the pixel on the display (or in the window) being captured.
//
// The call renderer forwards the cursors aimed at its own share
// (`app:share-cursors`); the shell knows what that share captures, because it
// picked the source (shellAuthority's display-media handler reports it here).
// A screen maps to its display's bounds, a window to its current frame
// (native windowFrame, by the CGWindowID in "window:<id>:0"), and one glass
// window covers that rect and draws the arrows (web route /share-cursors).
//
// The glass is content protected, which is what keeps this honest: a capture
// of the screen leaves it out, so viewers never receive the sharer's copy of
// their own arrow on top of the one they already draw. Verified against the
// ScreenCaptureKit capture on macOS 26: a protected window reads as whatever
// is underneath it, an unprotected one shows.

const CHANNEL = "share-cursors";
const MAX_CURSORS = 24;
// A shared window can move while arrows sit on it; follow it at this pace.
const WINDOW_POLL_MS = 250;

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/** The cursors a renderer sent, reduced to what the glass draws. */
function sanitizeCursors(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list.slice(0, MAX_CURSORS)) {
    if (!c || typeof c.id !== "string" || !c.id) continue;
    if (!Number.isFinite(c.nx) || !Number.isFinite(c.ny)) continue;
    out.push({ id: c.id, name: typeof c.name === "string" ? c.name.slice(0, 80) : "", nx: clamp01(c.nx), ny: clamp01(c.ny) });
  }
  return out;
}

/**
 * Where a capture source sits on screen, in global points, or null when it
 * is not on screen at all (a minimized or closed window, an unplugged display).
 */
function sourceRect(source, { screen, addon }) {
  if (!source || typeof source.id !== "string") return null;
  if (source.id.startsWith("screen:")) {
    // display_id is the Electron display id; "screen:<id>:0" carries the same
    // number on macOS, the fallback for a source that came without it.
    const displayId = source.displayId || source.id.split(":")[1];
    const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
    return display ? { ...display.bounds } : null;
  }
  const m = /^window:(\d+):/.exec(source.id);
  const frame = m ? addon?.windowFrame?.(Number(m[1])) : null;
  if (!frame || !frame.onscreen || !(frame.width > 0) || !(frame.height > 0)) return null;
  return { x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height) };
}

function sameRect(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function createShareCursors({ createGlass, screen, addon, timers = { setInterval, clearInterval } }) {
  const sources = new Map();
  let glass = null;
  let owner = null;
  let cursors = [];
  let rect = null;
  let poll = null;

  function stopPoll() {
    if (poll) timers.clearInterval(poll);
    poll = null;
  }

  function hide() {
    stopPoll();
    rect = null;
    if (glass && !glass.isDestroyed() && glass.isVisible()) glass.hide();
  }

  function place() {
    const source = owner ? sources.get(owner) : null;
    const next = cursors.length ? sourceRect(source, { screen, addon }) : null;
    if (!next) {
      // The window went away or off screen: nothing honest to point at. Keep
      // polling a window share, so the arrows come back when it does.
      if (glass && !glass.isDestroyed() && glass.isVisible()) glass.hide();
      rect = null;
      if (!cursors.length) stopPoll();
      return;
    }
    if (!glass || glass.isDestroyed()) glass = createGlass();
    if (!sameRect(rect, next)) {
      rect = next;
      glass.setBounds(next);
    }
    glass.webContents.send(`app:${CHANNEL}`, cursors);
    if (!glass.isVisible()) glass.showInactive();
  }

  function ensurePoll() {
    const source = owner ? sources.get(owner) : null;
    if (poll || !source?.id?.startsWith("window:")) return;
    poll = timers.setInterval(() => {
      if (!cursors.length) return stopPoll();
      const next = sourceRect(sources.get(owner), { screen, addon });
      if (!sameRect(rect, next)) place();
    }, WINDOW_POLL_MS);
  }

  /** The display-media handler picked `source` for this renderer's capture. */
  function setSource(wc, source) {
    if (!wc || !source) return;
    if (!sources.has(wc)) wc.once?.("destroyed", () => forget(wc));
    sources.set(wc, source);
    if (owner === wc) {
      stopPoll();
      rect = null;
      place();
      if (cursors.length) ensurePoll();
    }
  }

  function forget(wc) {
    sources.delete(wc);
    if (owner === wc) {
      owner = null;
      cursors = [];
      hide();
    }
  }

  /** The cursors pointing at `wc`'s own share right now; empty clears. */
  function update(wc, list) {
    const next = sanitizeCursors(list);
    if (!next.length) {
      if (owner === wc) {
        cursors = [];
        hide();
      }
      return;
    }
    if (!sources.has(wc)) return;
    if (owner !== wc) {
      stopPoll();
      rect = null;
      owner = wc;
    }
    cursors = next;
    place();
    ensurePoll();
  }

  function install(ipc) {
    ipc.handle(`app:${CHANNEL}`, (e, list) => {
      update(e.sender, list);
      return true;
    });
  }

  return { setSource, update, forget, install, get glass() { return glass; } };
}

module.exports = { CHANNEL, sanitizeCursors, sourceRect, createShareCursors };

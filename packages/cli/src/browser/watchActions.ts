/**
 * The action channel of the browser watch stream: what the agent's hand is
 * doing on the page, so a viewer can draw its cursor over the frames.
 *
 * Frames carry pixels only. The cursor Chrome dispatches input at is not in
 * them, and the daemon never sees the commands that place it: `cast browser`
 * runs on whichever engine is installed (the agent-browser binary, the
 * built-in CDP driver, the extension bridge into the human's own Chrome), and
 * each one talks to Chrome on its own socket. What every engine has in common
 * is the page. All of them dispatch TRUSTED input through CDP's Input domain,
 * so the page sees the same mousedown, mousemove, wheel and input events no
 * matter who sent them. So the watch source listens there: a small script,
 * installed on the screencast's own CDP session, reports each event through
 * a Runtime binding, and the daemon shapes it into an `action` frame.
 *
 * Engine agnostic by construction, and no relay between processes: the
 * screencast session already exists for every engine, and it is the one
 * place that has both the page and the viewer.
 *
 * Coordinates are normalized 0..1 against the page's own viewport, read at
 * the moment of the event (the same convention control-mode input rides in
 * on, see WatchInput in watchSource.ts), so the overlay is right whatever
 * size the frames are scaled to.
 *
 * Text: what the agent types is shown as a caption, capped, and never read
 * from a password field or a field whose autocomplete names a password, a
 * one time code or a card. Those report a typing action with no text.
 */

/** Bumped when the server sends something an older viewer would not expect.
 *  Viewers ignore frame types they do not know, so a bump never breaks one. */
export const WATCH_PROTOCOL_VERSION = 2;

/** The page-side function name the observer script reports through. */
export const ACTION_BINDING = "__castWatchAction";

/** Typed text is a caption, not a transcript. */
export const ACTION_TEXT_CAP = 200;

/** How many recent actions the page and the daemon each keep, so a viewer
 *  who connects mid flow sees the cursor at once. */
export const ACTION_RECENT = 8;

/** A replayed action older than this is not "where the cursor is now". */
export const ACTION_REPLAY_MAX_AGE_MS = 30_000;

/** Mouse moves are coalesced to this in the page: enough for a glide,
 *  nothing like a raw pointer stream. */
const MOVE_INTERVAL_MS = 40;
const WHEEL_INTERVAL_MS = 80;
/** Keystrokes into one field within this gap read as one caption. */
const TYPING_GAP_MS = 3000;

export type WatchActionKind = "move" | "down" | "up" | "type" | "nav" | "scroll";

/** One action frame, server to viewer. x/y are 0..1 of the page viewport. */
export interface WatchAction {
  type: "action";
  kind: WatchActionKind;
  x: number;
  y: number;
  /** The caption for `type`: what has been typed into the field so far. */
  text?: string;
  /** Present on `type` when the field is sensitive; `text` is then absent. */
  secret?: true;
  /** The new main frame URL, on `nav`. */
  url?: string;
  /** Wheel deltas in CSS pixels, on `scroll`. */
  dx?: number;
  dy?: number;
  /** Wall clock ms when the page saw it. */
  at: number;
}

/**
 * The page script. One idempotent expression, so it installs the same way
 * as a new-document script and evaluated into a page that is already open.
 * Written against `window` only (no bare globals) so a test can run it with
 * a fake.
 *
 * Only the top frame reports: an iframe's coordinates are in its own
 * viewport, and a cursor drawn from them would land in the wrong place.
 */
export function actionObserverSource(): string {
  return `(() => {
  const W = window;
  if (W.__castWatch) return;
  if (W.top && W.top !== W) return;
  const S = { recent: [], moveAt: 0, wheelAt: 0, downAt: 0, typing: null };
  W.__castWatch = S;
  const push = (a) => {
    S.recent.push(a);
    if (S.recent.length > ${ACTION_RECENT}) S.recent.shift();
    const fn = W[${JSON.stringify(ACTION_BINDING)}];
    if (typeof fn === "function") { try { fn(JSON.stringify(a)); } catch {} }
  };
  const raw = (kind, x, y, extra) => Object.assign({ kind, x, y, w: W.innerWidth, h: W.innerHeight, at: Date.now() }, extra || {});
  const attr = (el, name) => (el && typeof el.getAttribute === "function" ? el.getAttribute(name) || "" : "").toLowerCase();
  const sensitive = (el) => attr(el, "type") === "password" || /password|one-time-code|cc-|security-code/.test(attr(el, "autocomplete"));
  const center = (el) => {
    const r = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    return r && r.width ? [r.left + r.width / 2, r.top + r.height / 2] : null;
  };
  const opts = { capture: true, passive: true };
  W.addEventListener("mousemove", (e) => {
    const now = Date.now();
    if (now - S.moveAt < ${MOVE_INTERVAL_MS}) return;
    S.moveAt = now;
    push(raw("move", e.clientX, e.clientY));
  }, opts);
  W.addEventListener("mousedown", (e) => {
    S.downAt = Date.now();
    push(raw("down", e.clientX, e.clientY));
  }, opts);
  W.addEventListener("mouseup", (e) => push(raw("up", e.clientX, e.clientY)), opts);
  W.addEventListener("click", (e) => {
    // A press was already reported. A scripted click (element.click()) has no
    // press and no coordinates: aim at the element it hit.
    if (Date.now() - S.downAt < 1000) return;
    const c = center(e.target) || [e.clientX, e.clientY];
    push(raw("down", c[0], c[1]));
    push(raw("up", c[0], c[1]));
  }, opts);
  W.addEventListener("wheel", (e) => {
    const now = Date.now();
    if (now - S.wheelAt < ${WHEEL_INTERVAL_MS}) return;
    S.wheelAt = now;
    push(raw("scroll", e.clientX, e.clientY, { dx: e.deltaX, dy: e.deltaY }));
  }, opts);
  W.addEventListener("input", (e) => {
    const el = e.target;
    const c = center(el) || [0, 0];
    if (sensitive(el)) {
      S.typing = null;
      push(raw("type", c[0], c[1], { secret: true }));
      return;
    }
    const now = Date.now();
    if (!S.typing || S.typing.el !== el || now - S.typing.at > ${TYPING_GAP_MS}) S.typing = { el, text: "", at: now };
    S.typing.at = now;
    const data = typeof e.data === "string" ? e.data : "";
    if (typeof e.inputType === "string" && e.inputType.indexOf("delete") === 0) S.typing.text = S.typing.text.slice(0, -1);
    else S.typing.text = (S.typing.text + data).slice(-${ACTION_TEXT_CAP});
    push(raw("type", c[0], c[1], { text: S.typing.text }));
  }, opts);
})()`;
}

/** Install into a page that is already open and answer with what it saw
 *  recently (a previous viewer's script may still be there, ring and all). */
export function actionObserverInstallExpression(): string {
  return `${actionObserverSource()};
JSON.stringify((window.__castWatch && window.__castWatch.recent) || [])`;
}

const KINDS = new Set<WatchActionKind>(["move", "down", "up", "type", "nav", "scroll"]);

const unit = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;

/**
 * Shape one raw report from the page into an action frame. Null for anything
 * malformed, and for an event with no viewport to normalize against (a page
 * with a zero-size window has nowhere to draw a cursor).
 */
export function normalizeAction(raw: unknown, now = Date.now()): WatchAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== "string" || !KINDS.has(kind as WatchActionKind)) return null;
  const { x, y, w, h } = r;
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0) || !(h > 0)) return null;
  const action: WatchAction = {
    type: "action",
    kind: kind as WatchActionKind,
    x: unit(x / w),
    y: unit(y / h),
    at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : now,
  };
  if (kind === "type") {
    if (r.secret === true) action.secret = true;
    else if (typeof r.text === "string") action.text = r.text.slice(-ACTION_TEXT_CAP);
  }
  if (kind === "scroll") {
    if (typeof r.dx === "number" && Number.isFinite(r.dx)) action.dx = Math.round(r.dx);
    if (typeof r.dy === "number" && Number.isFinite(r.dy)) action.dy = Math.round(r.dy);
  }
  if (kind === "nav" && typeof r.url === "string") action.url = r.url;
  return action;
}

/** Parse one binding payload (JSON text) into an action frame, or null. */
export function parseActionPayload(payload: unknown, now = Date.now()): WatchAction | null {
  if (typeof payload !== "string") return null;
  try {
    return normalizeAction(JSON.parse(payload), now);
  } catch {
    return null;
  }
}

/** The actions a page reported before this viewer arrived, still fresh. */
export function replayableActions(recentJson: unknown, now = Date.now()): WatchAction[] {
  if (typeof recentJson !== "string") return [];
  let list: unknown;
  try {
    list = JSON.parse(recentJson);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .slice(-ACTION_RECENT)
    .map((r) => normalizeAction(r, now))
    .filter((a): a is WatchAction => a !== null && now - a.at <= ACTION_REPLAY_MAX_AGE_MS);
}

/**
 * A bounded memory of the last actions per tab, kept by the daemon across
 * viewer connections: the second viewer of a tab sees the cursor at once,
 * without waiting for the agent's next move.
 */
export class RecentActions {
  private byTab = new Map<string, WatchAction[]>();

  remember(tabId: string, action: WatchAction): void {
    let list = this.byTab.get(tabId);
    if (!list) {
      // Keep insertion order so the oldest tab is the one dropped.
      if (this.byTab.size >= 32) this.byTab.delete(this.byTab.keys().next().value!);
      list = [];
      this.byTab.set(tabId, list);
    }
    list.push(action);
    if (list.length > ACTION_RECENT) list.splice(0, list.length - ACTION_RECENT);
  }

  recall(tabId: string, now = Date.now()): WatchAction[] {
    const list = this.byTab.get(tabId) ?? [];
    return list.filter((a) => now - a.at <= ACTION_REPLAY_MAX_AGE_MS);
  }
}

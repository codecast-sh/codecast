/**
 * The wire protocol between the bridge host and the Chrome extension, and the
 * one place tab ids are mapped to CDP target ids.
 *
 * Two faces on the host:
 *
 *   clients (built-in driver, agent-browser, anything that speaks CDP)
 *          \  ws://127.0.0.1:PORT/devtools/browser/<token>   — REAL CDP
 *           bridge host
 *          /  ws://127.0.0.1:PORT/ext?token=<token>           — this protocol
 *   the extension (one, in the user's real Chrome, holding chrome.debugger)
 *
 * The client face is deliberately not a custom protocol: the host presents
 * itself as a Chrome DevTools browser endpoint (`/json/version`, `/json/list`,
 * a browser-level socket with the Target domain) and emulates the handful of
 * browser-scope methods over the extension. That is what lets every engine —
 * our CdpConnection driver, agent-browser's `--cdp`, a Playwright script —
 * drive the real Chrome without knowing the extension exists.
 *
 * Only the extension face is ours, and it is tiny: tab management,
 * attach/detach, raw CDP per tab, plus events flowing back.
 *
 * Two things ride on that face that plain CDP has no word for. A tab can be
 * created in the background (`active: false`, so Chrome does not steal the
 * human's focus) and inside a Chrome tab group (`group`), which is how a
 * session's tabs stay together and how the extension shows work in progress:
 * it animates the group title while a `cdp` op is in flight. The host maps
 * `Target.createTarget {background, castGroup}` onto these and never lets
 * `castGroup` or a group leak back to a client.
 */

/**
 * Bumped when a message shape changes incompatibly. Both ends report theirs.
 * 3: tabs.create takes `background` and `group`; tabs carry `group`.
 */
export const BRIDGE_PROTOCOL = 3;

/** Default loopback port for the bridge host. Override: CAST_BRIDGE_PORT. */
export const BRIDGE_DEFAULT_PORT = 41729;

/** WS close code the host uses for a bad or missing token. */
export const CLOSE_BAD_TOKEN = 4401;

/** Ops the extension implements. Anything else gets an error reply. */
export type BridgeOp =
  | "ping"
  | "tabs.list"
  | "tabs.create"
  | "tabs.close"
  | "tabs.activate"
  | "attach"
  | "detach"
  | "cdp";

/** The colours Chrome accepts for a tab group (chrome.tabGroups.Color). */
export type BridgeGroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

/** A Chrome tab group as the bridge names it: by title within a window. */
export interface BridgeGroup {
  title: string;
  color: BridgeGroupColor;
}

/** Host → extension request. */
export interface BridgeRequest {
  id: number;
  op: BridgeOp;
  tabId?: number;
  url?: string;
  /** tabs.create: open without activating the tab (default false). */
  background?: boolean;
  /** tabs.create: put the tab in this group, reusing one with the same title in the same window. */
  group?: BridgeGroup;
  method?: string;
  params?: Record<string, unknown>;
}

/** Extension → host reply. Extra result fields ride on the top level. */
export interface BridgeReply {
  id: number;
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** Extension → host, unsolicited. */
export type BridgeEventMsg =
  | { op: "hello"; version?: string; protocol?: number; userAgent?: string }
  | { op: "pong" }
  /** A chrome.debugger event on an attached tab. */
  | { op: "event"; tabId: number; method: string; params: Record<string, unknown> }
  /** Chrome's tab list changed (any tab, driven or not). */
  | { op: "tab"; kind: "created" | "removed" | "updated"; tab: BridgeTab }
  /** The debugger left a tab without us asking — the user hit Cancel on the banner. */
  | { op: "detached"; tabId: number };

export interface BridgeTab {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  windowId: number;
  attached: boolean;
  /** The tab's group with its plain title (never the animated one), absent when ungrouped. */
  group?: BridgeGroup;
}

// ---------------------------------------------------------------------------
// Tab id ⇄ CDP target id
// ---------------------------------------------------------------------------

/**
 * A Chrome tab id is a 32-bit integer; a Chrome target id is 32 hex chars.
 * We mint 8 uppercase hex chars: enough to hold any tab id losslessly, and
 * exactly the width `shortId()` prints, so `--tab <prefix>` and the ids in
 * `cast browser tabs` keep working the way they do for the clone. Anything
 * that prints or parses a real-Chrome tab id goes through these two.
 */
export function targetIdOfTab(tabId: number): string {
  return (tabId >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

export function tabIdOfTarget(targetId: string): number | null {
  if (!/^[0-9A-Fa-f]{1,8}$/.test(targetId)) return null;
  return parseInt(targetId, 16);
}

/**
 * The wire protocol between the bridge host and the Chrome extension, and the
 * one place tab ids are mapped to CDP target ids.
 *
 * Two faces on the host:
 *
 *   clients (built-in driver, agent-browser, anything that speaks CDP)
 *          \  ws://127.0.0.1:PORT/devtools/browser/<token>   — REAL CDP
 *           bridge host
 *          /  ws://127.0.0.1:PORT/ext  (hello proves the token) — this protocol
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

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Bumped when a message shape changes incompatibly. Both ends report theirs.
 * 3: tabs.create takes `background` and `group`; tabs carry `group`.
 * 4: the extension face authenticates both ways (see bridgeProof).
 */
export const BRIDGE_PROTOCOL = 4;

/** Default loopback port for the bridge host. Override: CAST_BRIDGE_PORT. */
export const BRIDGE_DEFAULT_PORT = 41729;

/**
 * The extension's ID, the same on every machine because the manifest carries
 * a fixed public key (`key` in packages/browser-extension/manifest.json). Chrome
 * derives the ID from that key: SHA-256 of the DER-encoded public key, the
 * first 32 hex characters, each digit mapped from 0-9a-f onto a-p (an ID is
 * letters only so it can never look like a number). `extensionIdOfKey` is that
 * rule; the test checks the constant against the manifest with it, and a
 * scratch Chrome for Testing reported the same value from chrome.runtime.id.
 * Without a key an unpacked extension is named after its install path, which
 * is why the key is committed: `cast browser extension setup` opens the
 * options page by this ID to hand the token over without a paste.
 */
export const BRIDGE_EXTENSION_ID = "dfimhlggoaabdefnfhlpboehapdaakol";

/** Chrome's rule for the ID of an extension whose manifest carries `key` (base64 DER). */
export function extensionIdOfKey(keyBase64: string): string {
  const hex = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("hex").slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

/**
 * The options page with the pairing data in the fragment. The page saves it
 * and connects; a fragment never reaches a server and is cleared on arrival.
 */
export function bridgePairingUrl(state: { token: string; port: number }): string {
  return `chrome-extension://${BRIDGE_EXTENSION_ID}/options.html#${new URLSearchParams({ token: state.token, port: String(state.port) })}`;
}

/**
 * A page that forwards to the pairing URL. `setup` writes it to a 0600 file
 * and starts Chrome on the file's path, so the token rides in a file only its
 * owner can read while the process table shows a path. The options page is
 * web-accessible to `file:` pages for exactly this hop; the redirect keeps
 * the fragment, and the options page clears it as it always did.
 */
export function bridgePairingPage(pairingUrl: string): string {
  // `<` cannot appear in a URL built by URLSearchParams, but a script body
  // must never be able to close itself, so the escape is unconditional.
  const js = JSON.stringify(pairingUrl).replace(/</g, "\\u003c");
  return `<!doctype html><meta charset="utf-8"><title>Pairing with cast</title>` +
    `<script>location.replace(${js})</script>` +
    `<p>Opening the Codecast extension. If this page stays, the extension is not installed or needs a reload at chrome://extensions.</p>\n`;
}

/** WS close code the host uses for a bad or missing token. */
export const CLOSE_BAD_TOKEN = 4401;

// ---------------------------------------------------------------------------
// Mutual authentication
// ---------------------------------------------------------------------------
//
// The token never travels on the extension face, and nothing trusts a server
// for sitting on the port. Both sides prove they hold the token with an HMAC
// over a fresh nonce the other side chose:
//
//   extension → host   hello {nonce, auth: HMAC(token, "ext:" + nonce)}
//   host → extension   welcome {proof: HMAC(token, nonce)}
//   CLI → host         GET /healthz?nonce=N  →  "… proof=HMAC(token, 'healthz:' + N)"
//
// A process that squats the port cannot answer any of these, so the extension
// never hands it chrome.debugger and the CLI never presents the token to it.
// The three messages are prefixed differently so a proof for one purpose can
// never be replayed as another (a nonce is hex, so it cannot start with a
// prefix either).

export type ProofPurpose = "host" | "ext" | "healthz";

/** 32 random bytes as hex: the shape `isNonce` accepts, on both sides. */
export function randomNonce(): string {
  return randomBytes(32).toString("hex");
}

export function isNonce(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** The HMAC-SHA256 proof one side sends the other. Mirrored in background.js. */
export function bridgeProof(token: string, purpose: ProofPurpose, nonce: string): string {
  const message = purpose === "host" ? nonce : `${purpose}:${nonce}`;
  return createHmac("sha256", token).update(message).digest("hex");
}

/** Constant-time comparison for tokens and proofs. */
export function secretMatches(expected: string, got: string | null | undefined): boolean {
  if (typeof got !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

/**
 * The one group every cast tab in the human's Chrome sits in. One group, not
 * one per session: the human wants a single place where agent tabs are, and
 * the title animates while any session works there. Red is the Chrome
 * colour nearest the coral of the codecast mark.
 */
export const CAST_TAB_GROUP: BridgeGroup = { title: "Cast", color: "red" };

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

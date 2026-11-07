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
import { BROWSER_EXTENSION_ID, BROWSER_EXTENSION_STORE_URL } from "@codecast/shared/contracts";

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
 * rule; the test checks the constant against the manifest with it.
 * Without a key an unpacked extension is named after its install path, which
 * is why the key is committed: `cast browser extension setup` opens the
 * options page by this ID to hand the token over without a paste.
 */
export const BRIDGE_EXTENSION_ID = BROWSER_EXTENSION_ID;
export const BRIDGE_STORE_URL = BROWSER_EXTENSION_STORE_URL;

/** Chrome's rule for the ID of an extension whose manifest carries `key` (base64 DER). */
export function extensionIdOfKey(keyBase64: string): string {
  const hex = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("hex").slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

/**
 * The options page with a one-time pairing code (pairing.ts) in the
 * fragment. The page offers it for one click and the worker exchanges it for
 * the profile's own key. A fragment never reaches a server and is cleared on
 * arrival; and the code works once and expires in ten minutes, so the copy
 * Chrome keeps in its history opens nothing.
 */
export function bridgePairingUrl(pairing: { code: string; port: number }): string {
  return `chrome-extension://${BRIDGE_EXTENSION_ID}/options.html#${new URLSearchParams({ code: pairing.code, port: String(pairing.port) })}`;
}

/**
 * The options page as a wake: opening it runs the extension's page script,
 * whose message starts the service worker if Chrome ended it and makes a
 * live one drop a stuck socket (options.js pairFromFragment, background.js
 * op "wake"). Carries no secret, so it may travel as a plain URL.
 */
export function bridgeWakeUrl(): string {
  return `chrome-extension://${BRIDGE_EXTENSION_ID}/options.html#wake`;
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
  return PAIRING_PAGE_HEAD + `<script>location.replace(${js})</script>` +
    `<p>Opening the Codecast extension. ${PAIRING_FALLBACK}</p>\n`;
}

const PAIRING_PAGE_HEAD = `<!doctype html><meta charset="utf-8"><title>Pairing with cast</title>`;
const PAIRING_FALLBACK = `If this page stays, <a href="${BRIDGE_STORE_URL}" target="_blank" rel="noopener noreferrer">install Codecast from the Chrome Web Store</a>, then run <code>cast browser extension setup</code> again.`;

/**
 * What the forwarding page becomes once the wait settles, with the token
 * gone. The file stays: the extension can connect on its own (a Chrome
 * started cold reconnects with its saved token) before Chrome has read the
 * tab, and a deleted file then loads as "file not found".
 */
export function bridgeSettledPage(connected: boolean): string {
  return PAIRING_PAGE_HEAD + (connected
    ? `<p>Codecast is connected to cast. You can close this tab.</p>\n`
    : `<p>The Codecast extension did not connect. ${PAIRING_FALLBACK}</p>\n`);
}

/** WS close code the host uses for a bad or missing token. */
export const CLOSE_BAD_TOKEN = 4401;

/**
 * WS close code for a handshake that ran out of time: the host heard no
 * hello (a worker starved on a loaded machine), or the extension saw no
 * welcome (background.js CONNECT_TIMEOUT_MS). Distinct from CLOSE_BAD_TOKEN
 * on purpose: a slow handshake is a retry, a rejected token is a re-pair,
 * and the extension keys its badge and its retries on the code.
 */
export const CLOSE_HANDSHAKE_TIMEOUT = 4408;

/**
 * WS close code for a second extension, a proven one, while the current one
 * still answers: the extension paired in two Chrome profiles. The newcomer
 * waits as a standby instead of replacing the live one; replacing made the
 * two profiles take the bridge from each other every few seconds, failing
 * every command in flight each time.
 */
export const CLOSE_EXTENSION_STANDBY = 4409;

/** WebSocket close code for a CDP client whose sessions the host dropped while their tabs live on (host.ts disconnect). */
export const CLOSE_SESSIONS_DROPPED = 4410;

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
  | "cdp"
  /** Reload the extension itself (chrome.runtime.reload): an unpacked load
   *  never picks up an edited file otherwise. Answered before it happens. */
  | "reload";

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
  owned?: boolean;
  url?: string;
  /** tabs.create: open without activating the tab (default false). */
  background?: boolean;
  /** tabs.create: put the tab in this group, reusing one with the same title in the same window. */
  group?: BridgeGroup;
  method?: string;
  params?: Record<string, unknown>;
  /** cdp: Chrome's id of a child session (a cross-origin iframe) on the tab; absent for the tab's own. */
  sessionId?: string;
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
  | {
      op: "hello";
      version?: string;
      protocol?: number;
      userAgent?: string;
      /** The worker's boot: a fresh id means Chrome ended the previous worker. */
      boot?: string;
      bootAt?: number;
      /** Why it connected: boot, startup, installed, alarm, retry, reconnect. */
      trigger?: string;
      /** The worker's last few lifecycle notes (background.js note), oldest first, for the host log. */
      recent?: string[];
    }
  | { op: "pong" }
  /** The worker's own keepalive; the host answers pong. */
  | { op: "ping" }
  /** A chrome.debugger event on an attached tab; `session` names the child session (cross-origin iframe) it came from. */
  | { op: "event"; tabId: number; session?: string; method: string; params: Record<string, unknown> }
  /** Chrome's tab list changed (any tab, driven or not). */
  | { op: "tab"; kind: "created" | "removed" | "updated"; tab: BridgeTab }
  /** The debugger left a tab without us asking: the user hit Cancel on the banner,
   *  or (`reason: "reclaimed"`) took the tab back from the toolbar, after which no
   *  session keeps a grant on it. */
  | { op: "detached"; tabId: number; reason?: "reclaimed" };

export interface BridgeTab {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  windowId: number;
  attached: boolean;
  /** Created by the extension for a session (background.js ownedTabs); absent from extensions before protocol 4.1. */
  owned?: boolean;
  /** The tab's group with its plain title (never the animated one), absent when ungrouped. */
  group?: BridgeGroup;
  /** The human lent this tab of theirs to agents from the toolbar; it is `owned` while lent. */
  lent?: boolean;
  /** An agent tab whose page opened this one (window.open, target=_blank): every session holding the opener may see it. */
  opener?: number;
  /** A step an agent handed the human on this tab (`cast browser handoff`) and where it stands. */
  handoff?: BridgeHandoff;
  /** Why no idle cleanup or reaper may close this tab, when one applies. */
  keep?: BridgeKeepReason;
  /** The Chrome profile it lives in (links.ts id). Set by the host, never sent by the extension. */
  profile?: string;
}

export type BridgeHandoffState = "waiting" | "done" | "expired" | "cancelled";
export interface BridgeHandoff {
  id: string;
  state: BridgeHandoffState;
}

/**
 * Tabs the extension's idle cleanup and the CLI's reaper (engineReap.ts) both
 * leave open: a handoff waiting on the human, a tab the human lent, pinned,
 * or dragged out of the Cast group, and a tab playing sound.
 */
export type BridgeKeepReason = "handoff" | "lent" | "pinned" | "claimed" | "audible";

/**
 * Methods the extension answers itself on a tab's CDP session, never passed
 * to Chrome. `Cast.handoff {text, id?, timeoutMs?, raise?}` shows the handoff
 * card and answers `{id, state, shown, expires}`; `{cancel: true}` takes it down.
 */
export const CAST_HANDOFF_METHOD = "Cast.handoff";

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

/**
 * CDP's WebAuthn domain installs virtual authenticators and mints credentials
 * on them. In the person's signed-in Chrome that is a passkey an agent holds,
 * which is exactly what Vault's Touch ID check exists to rule out, so no door
 * into a browser forwards it: not the bridge, not `raw`, not the extension.
 */
export function isWebAuthnMethod(method: string): boolean {
  return /^WebAuthn\.\w+$/i.test(method);
}

export const WEBAUTHN_REFUSAL = "refusing CDP's WebAuthn domain: agents cannot create or use passkeys";

export function tabIdOfTarget(targetId: string): number | null {
  if (!/^[0-9A-Fa-f]{1,8}$/.test(targetId)) return null;
  return parseInt(targetId, 16);
}

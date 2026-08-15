/**
 * Wire format between a `cast browser` process and the driver resident in the
 * daemon.
 *
 * The daemon owns one long-lived socket to Chrome; each CLI invocation opens a
 * short WebSocket to the daemon instead. Two kinds of message travel over it:
 * raw CDP calls, forwarded verbatim (the CLI keeps speaking CDP through the
 * same `CdpClient` interface it uses against Chrome directly), and a handful of
 * `cast.*` control calls for the work the daemon can do once and remember —
 * attaching a tab, enabling its domains, arming the recorder — which is where
 * the per-command cost used to go.
 */

import type { CdpTarget } from "../cdp.js";
import type { InstanceState, Liveness } from "../instance.js";

/** Path on the daemon's loopback hook server. */
export const RESIDENT_WS_PATH = "/browser/cdp";
export const RESIDENT_HTTP_PREFIX = "/browser/";

/** Bumped when the wire shape changes; a mismatch makes the CLI go direct. */
export const RESIDENT_PROTOCOL_VERSION = 1;

export interface WireCall {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  timeoutMs?: number;
}

export interface WireReply {
  id: number;
  result?: unknown;
  error?: { name?: string; message: string };
}

export interface WireEvent {
  event: { method: string; params: Record<string, unknown>; sessionId?: string };
}

export type WireMessage = WireReply | WireEvent;

// ---------------------------------------------------------------- cast.* calls

/** `cast.hello` — first call on every connection. */
export interface HelloResult {
  version: number;
  liveness: Liveness;
  state: InstanceState | null;
}

/** `cast.targets` — page targets, from the daemon's own socket (no HTTP hop). */
export type TargetsResult = { targets: CdpTarget[] };

/**
 * `cast.attach {targetId}` — attach (or reuse the attachment to) a tab with
 * its domains enabled, recorder armed and viewport applied. `reused` tells
 * the CLI whether that work happened just now or was already done.
 */
export interface AttachParams extends Record<string, unknown> {
  targetId: string;
}
export interface AttachResult {
  sessionId: string;
  reused: boolean;
}

/** `cast.status` — what the resident driver is holding, for diagnostics. */
export interface ResidentStatus {
  connected: boolean;
  port: number | null;
  attachedTabs: number;
  clients: number;
}

export function isWireEvent(m: WireMessage): m is WireEvent {
  return (m as WireEvent).event !== undefined;
}

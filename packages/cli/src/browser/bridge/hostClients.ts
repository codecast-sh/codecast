/**
 * Host-scoped client tokens for the bridge: how a cloud host's sessions drive
 * this laptop's Chrome without ever holding the laptop's machine-wide token.
 *
 * The laptop daemon holds a reverse forward to each cloud host it manages
 * (cloud/browserLink.ts), so the host's loopback reaches this bridge. What
 * crosses to the host is a token minted for that host alone: the laptop keeps
 * only its sha256, in bridge.json beside the machine token, and the bridge host
 * accepts it on the CDP face and the few HTTP routes a CDP client needs, never
 * as the extension's pairing secret. Revoking one host deletes its record; the
 * bridge host re-reads the records and drops that host's live sockets.
 *
 * The host proves the bridge before presenting its token the same way a local
 * CLI does (host.ts probeHost), keyed on the hash both sides can compute:
 * /healthz?client=<host id>&nonce=… answers HMAC(sha256(token), "healthz:"+nonce).
 */

import * as crypto from "node:crypto";
import { secretMatches } from "./protocol.js";

export interface HostClientRecord {
  /** sha256 hex of the token; the token itself never touches the laptop's disk. */
  hash: string;
  /** Who the token was minted for, for status and the bridge host's log. */
  label: string;
  mintedAt: number;
  /** The process holding the host's link (the daemon, or `extension link --foreground`): while it lives, no other may replace this token. */
  holder?: number;
}

/** host id (the cloud registry id) → its current token's record. */
export type HostClients = Record<string, HostClientRecord>;

export const hashHostToken = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");

/** A fresh token and the record to store for it. */
export function newHostClient(label: string, now = Date.now(), holder?: number): { token: string; record: HostClientRecord } {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, record: { hash: hashHostToken(token), label, mintedAt: now, ...(holder ? { holder } : {}) } };
}

/** The host id a presented token belongs to, or null. Compares every record in constant time. */
export function matchHostClient(clients: HostClients | undefined, presented: string | null | undefined): string | null {
  if (!clients || typeof presented !== "string" || !presented) return null;
  const hash = hashHostToken(presented);
  let found: string | null = null;
  for (const [id, rec] of Object.entries(clients)) if (secretMatches(rec.hash, hash)) found = id;
  return found;
}

/**
 * A cloud host's sessions live in a namespace of their own on the bridge
 * (`host:<id>:<session>`), so its token can never name, see or take over a
 * laptop session. A host socket that names none sees its own namespace
 * (every session of that host), where a laptop one sees every agent tab.
 */
export function scopedSession(caller: { host: string | null }, raw: string | null | undefined): string | null {
  if (!raw) return null;
  return caller.host ? `host:${caller.host}:${raw}` : raw;
}

/** The sessions a caller may be shown: all of them to this laptop, only its own (unprefixed) to a host. */
export function visibleSessions(caller: { host: string | null }, sessions: string[]): string[] {
  if (!caller.host) return sessions;
  const prefix = `host:${caller.host}:`;
  return sessions.filter((s) => s.startsWith(prefix)).map((s) => s.slice(prefix.length));
}


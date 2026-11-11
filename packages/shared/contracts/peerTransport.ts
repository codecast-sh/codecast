// Direct links between one owner's machines over Tailscale
// (docs/architecture/peer-transport.md). PURE isomorphic data and functions:
// imported by the daemon, Convex and the web.

/** A machine's place on a tailnet, as its own `tailscale status` reports it. */
export interface PeerTailnet {
  /** Tailnet IPv4 (100.x). */
  ip: string;
  /** MagicDNS name, with the trailing dot `tailscale status` prints. */
  name: string;
  /** MagicDNS suffix naming the tailnet ("tail1234.ts.net"); null when unknown. */
  tailnet: string | null;
  /** Self's Tailscale UserID; a grant needs both machines on the same one. */
  ts_user_id?: string;
  /** Whether Self's tailnet IPv4 is on a local interface (false under userspace networking). */
  bindable?: boolean;
}

/** An IPv4 in 100.64.0.0/10, the only range Tailscale assigns. */
export function isTailnetIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) && o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

function boundedString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 255 ? v : null;
}

/** A reported tailnet record, or null for anything malformed. */
export function normalizePeerTailnet(raw: unknown): PeerTailnet | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ip = typeof r.ip === "string" && isTailnetIPv4(r.ip) ? r.ip : null;
  const name = boundedString(r.name);
  if (!ip || !name) return null;
  const tsUserId = typeof r.ts_user_id === "number" && Number.isSafeInteger(r.ts_user_id) ? String(r.ts_user_id) : boundedString(r.ts_user_id);
  return {
    ip,
    name,
    tailnet: boundedString(r.tailnet),
    ...(tsUserId ? { ts_user_id: tsUserId } : {}),
    ...(typeof r.bindable === "boolean" ? { bindable: r.bindable } : {}),
  };
}

/**
 * What the heartbeat reports: Self's identity (tailnet.ts selfTailnet), its
 * Tailscale UserID read from the raw status, and whether its IPv4 is on a
 * local interface (`localAddresses`, from os.networkInterfaces()).
 */
export function reportedPeerTailnet(
  self: { ip: string; name: string; tailnet: string | null } | null,
  status: unknown,
  localAddresses: readonly string[],
): PeerTailnet | null {
  if (!self) return null;
  const userId = (status as { Self?: { UserID?: unknown } } | null)?.Self?.UserID;
  return normalizePeerTailnet({ ...self, ts_user_id: userId, bindable: localAddresses.includes(self.ip) });
}

/**
 * The heartbeat's tailnet field from one status read: undefined (say nothing)
 * when the read outlasts `timeoutMs` or reports no tailnet only once, since a
 * failed or slow `tailscale status` reads as null too. Off the tailnet is
 * reported after two null reads in a row, so a hiccup never clears the row.
 */
export function heartbeatTailnetField(): (read: Promise<PeerTailnet | null>, timeoutMs: number) => Promise<PeerTailnet | null | undefined> {
  let nulls = 0;
  return async (read, timeoutMs) => {
    let stop = () => {};
    const timedOut = new Promise<undefined>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      stop = () => clearTimeout(timer);
    });
    const value = await Promise.race([read, timedOut]).finally(() => stop());
    if (value === undefined) return undefined;
    if (value) { nulls = 0; return value; }
    return ++nulls >= 2 ? null : undefined;
  };
}

export function samePeerTailnet(a: PeerTailnet | null | undefined, b: PeerTailnet | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.ip === b.ip && a.name === b.name && (a.tailnet ?? null) === (b.tailnet ?? null)
    && (a.ts_user_id ?? null) === (b.ts_user_id ?? null) && (a.bindable ?? null) === (b.bindable ?? null);
}

/** The short machine name from a MagicDNS name ("mbp.tail1234.ts.net." -> "mbp"). */
export function tailnetShortName(name: string): string {
  return name.replace(/\.$/, "").split(".")[0] || name;
}

/** The last recorded transfer outcome from the source to the requester (peer_links). */
export interface PeerLinkOutcome {
  last_direct_ok_at?: number;
  last_direct_failure?: { at: number; reason: string };
}

export type PeerLinkState =
  | { state: "direct"; tailnet: string | null; proven: boolean }
  | {
      state: "relayed";
      why: "self_off" | "peer_off" | "different_tailnet" | "other_account" | "not_bindable" | "peer_offline" | "disabled" | "last_failed";
      reason?: string;
    };

/**
 * How data from `peer` (the source) to `self` will travel, as far as the
 * roster can tell. The daemon decides for real at transfer time (its own
 * `tailscale status` must show the peer online); this is the UI's answer.
 * `proven` means the last direct transfer worked and nothing failed since.
 */
export function peerLinkState(opts: {
  self: PeerTailnet | null | undefined;
  peer: PeerTailnet | null | undefined;
  peerOnline: boolean;
  directLinks?: boolean;
  last?: PeerLinkOutcome | null;
}): PeerLinkState {
  const { self, peer, last } = opts;
  if (opts.directLinks === false) return { state: "relayed", why: "disabled" };
  if (!self) return { state: "relayed", why: "self_off" };
  if (!peer) return { state: "relayed", why: "peer_off" };
  if (self.tailnet && peer.tailnet && self.tailnet !== peer.tailnet) return { state: "relayed", why: "different_tailnet" };
  if (self.ts_user_id && peer.ts_user_id && self.ts_user_id !== peer.ts_user_id) return { state: "relayed", why: "other_account" };
  if (!opts.peerOnline) return { state: "relayed", why: "peer_offline" };
  if (peer.bindable === false) return { state: "relayed", why: "not_bindable" };
  const failure = last?.last_direct_failure;
  if (failure && !(last?.last_direct_ok_at !== undefined && last.last_direct_ok_at > failure.at)) {
    return { state: "relayed", why: "last_failed", reason: failure.reason };
  }
  return { state: "direct", tailnet: self.tailnet ?? peer.tailnet, proven: last?.last_direct_ok_at !== undefined };
}

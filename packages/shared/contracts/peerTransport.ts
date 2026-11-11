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
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A reported tailnet record, or null for anything malformed. */
export function normalizePeerTailnet(raw: unknown): PeerTailnet | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ip = typeof r.ip === "string" && IPV4.test(r.ip) ? r.ip : null;
  const name = typeof r.name === "string" && r.name.length > 0 && r.name.length <= 255 ? r.name : null;
  if (!ip || !name) return null;
  const tailnet = typeof r.tailnet === "string" && r.tailnet.length > 0 && r.tailnet.length <= 255 ? r.tailnet : null;
  return { ip, name, tailnet };
}

export function samePeerTailnet(a: PeerTailnet | null | undefined, b: PeerTailnet | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.ip === b.ip && a.name === b.name && a.tailnet === b.tailnet;
}

/** The short machine name from a MagicDNS name ("mbp.tail1234.ts.net." -> "mbp"). */
export function tailnetShortName(name: string): string {
  return name.replace(/\.$/, "").split(".")[0] || name;
}

export type PeerLinkState =
  | { state: "direct"; tailnet: string | null }
  | { state: "relayed"; why: "self_off" | "peer_off" | "different_tailnet" | "peer_offline" | "disabled" };

/**
 * How data between two of one owner's machines will travel, as far as the
 * roster can tell. The daemon decides for real at transfer time (its own
 * `tailscale status` must show the peer online); this is the UI's answer.
 */
export function peerLinkState(opts: {
  self: PeerTailnet | null | undefined;
  peer: PeerTailnet | null | undefined;
  peerOnline: boolean;
  directLinks?: boolean;
}): PeerLinkState {
  if (opts.directLinks === false) return { state: "relayed", why: "disabled" };
  if (!opts.self) return { state: "relayed", why: "self_off" };
  if (!opts.peer) return { state: "relayed", why: "peer_off" };
  if (opts.self.tailnet && opts.peer.tailnet && opts.self.tailnet !== opts.peer.tailnet) return { state: "relayed", why: "different_tailnet" };
  if (!opts.peerOnline) return { state: "relayed", why: "peer_offline" };
  return { state: "direct", tailnet: opts.self.tailnet ?? opts.peer.tailnet };
}

/**
 * Who may take part in a direct link (docs/architecture/peer-transport.md):
 * only another machine of the same Tailscale user, online at the address it
 * claimed, and only when this machine's tailnet IP is a real local interface.
 */

import * as os from "node:os";
import { execFile } from "../proc.js";
import { selfTailnet, type TailnetStatus } from "../cloud/tailnet.js";

export type PeerCheck = { ok: true } | { ok: false; reason: string };

/** The node at exactly `ip` is `name`, online, not shared in, not tagged, and owned by Self's user. */
export function verifyOwnerPeer(status: TailnetStatus | null, peer: { ip: string; name: string }): PeerCheck {
  if (status?.BackendState !== "Running" || !status.Self) return { ok: false, reason: "not_on_tailnet: this machine is not on a running tailnet" };
  const node = Object.values(status.Peer ?? {}).find((p) => p.TailscaleIPs?.includes(peer.ip));
  if (!node) return { ok: false, reason: `not_on_tailnet: no node at ${peer.ip}` };
  if (node.DNSName !== peer.name) return { ok: false, reason: `name_mismatch: ${peer.ip} is ${node.DNSName ?? "unnamed"}, not ${peer.name}` };
  if (node.Online !== true) return { ok: false, reason: `offline: ${peer.name} is offline` };
  if (node.ShareeNode) return { ok: false, reason: `shared_node: ${peer.name} is shared in from another tailnet` };
  const self = status.Self.UserID;
  if (typeof self !== "number" || node.UserID !== self || node.Tags?.length || status.Self.Tags?.length) {
    return { ok: false, reason: `other_user: ${peer.name} does not belong to this machine's Tailscale user` };
  }
  return { ok: true };
}

/** Self's tailnet IPv4, when it sits on a local interface (it does not under userspace networking). */
export function grantBindAddress(
  status: TailnetStatus | null,
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): { ok: true; ip: string } | { ok: false; reason: string } {
  const self = selfTailnet(status);
  if (!self) return { ok: false, reason: "not_on_tailnet: this machine is not on a running tailnet" };
  const local = Object.values(ifaces).some((list) => list?.some((i) => i.family === "IPv4" && i.address === self.ip));
  return local ? { ok: true, ip: self.ip } : { ok: false, reason: `userspace: ${self.ip} is not on a local interface` };
}

const SOCKETFW = "/usr/libexec/ApplicationFirewall/socketfilterfw";

/** The macOS application firewall is set to block all incoming connections. Any doubt answers false. */
export function firewallBlocksIncoming(opts: { platform?: string; bin?: string } = {}): Promise<boolean> {
  if ((opts.platform ?? process.platform) !== "darwin") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(opts.bin ?? SOCKETFW, ["--getblockall"], { encoding: "utf-8", timeout: 2_000 }, (err: unknown, stdout: unknown) => {
      resolve(!err && /\benabled\b/i.test(String(stdout ?? "")));
    });
  });
}

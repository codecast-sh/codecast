/**
 * The host side of the laptop Chrome link (decision sd-2645): a session on a
 * cloud host drives the human's laptop Chrome whenever the laptop and its
 * extension are reachable, and the host's own Chrome otherwise.
 *
 * The laptop daemon holds an ssh connection to the host with a reverse
 * forward of its bridge port (cloud/browserLink.ts). Over that connection it
 * writes this file: the forwarded port, a token minted for this host alone
 * (bridge/hostClients.ts), and which laptop it is. The connection's remote
 * side removes the file when it closes, but a file can outlive a link that
 * died abruptly, so nothing trusts it: every `cast browser` invocation proves
 * the bridge on the port (a /healthz HMAC keyed on the token's hash) and asks
 * whether the extension is on it, inside a short budget, before choosing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { browserHome } from "../profile.js";
import { bridgeProof, randomNonce, secretMatches } from "./protocol.js";
import { hashHostToken } from "./hostClients.js";
import { bridgeStatus, type BridgeHostStatus, type ProvenBridge } from "./host.js";

export const LAPTOP_LINK_FILE = "laptop-link.json";

export interface LaptopLink {
  v: 1;
  /** The host loopback port forwarded to the laptop's bridge (the same number as the laptop's). */
  port: number;
  /** This host's own client token; the laptop stores only its hash. */
  token: string;
  /** The laptop registry's id for this host: the bridge keys the token by it. */
  hostId: string;
  /** The laptop's name, for status lines. */
  laptop: string;
  linkedAt: number;
}

export const laptopLinkPath = (): string => path.join(browserHome(), LAPTOP_LINK_FILE);

export function readLaptopLink(file = laptopLinkPath()): LaptopLink | null {
  try {
    const l = JSON.parse(fs.readFileSync(file, "utf-8")) as LaptopLink;
    return l?.v === 1 && Number.isInteger(l.port) && typeof l.token === "string" && typeof l.hostId === "string" ? l : null;
  } catch {
    return null;
  }
}

export type LinkVerdict =
  | { mode: "laptop"; laptop: string; bridge: ProvenBridge; status: BridgeHostStatus }
  | { mode: "host"; laptop?: string; reason: string };

/** The whole probe's budget: a dead laptop costs a session this much per command, no more. */
export const LINK_PROBE_BUDGET_MS = 1_500;

/**
 * Does the link reach a bridge that holds this host's token, with the
 * extension on it? Proof first, so the token is never presented to a
 * squatter on the host's port.
 */
export async function probeLaptopLink(link: LaptopLink, budgetMs = LINK_PROBE_BUDGET_MS): Promise<LinkVerdict> {
  const deadline = Date.now() + budgetMs;
  const left = () => Math.max(100, deadline - Date.now());
  const host = (reason: string): LinkVerdict => ({ mode: "host", laptop: link.laptop, reason });
  const nonce = randomNonce();
  let body: string;
  try {
    const res = await fetch(`http://127.0.0.1:${link.port}/healthz?client=${encodeURIComponent(link.hostId)}&nonce=${nonce}`, { signal: AbortSignal.timeout(left()) });
    body = await res.text();
  } catch {
    return host("the laptop is not reachable over its link");
  }
  if (!body.startsWith("cast-bridge")) return host(`something else answers on 127.0.0.1:${link.port}`);
  const proof = /proof=([0-9a-f]+)/.exec(body)?.[1];
  if (!secretMatches(bridgeProof(hashHostToken(link.token), "healthz", nonce), proof)) {
    return host("the laptop no longer accepts this host's token (revoked or replaced)");
  }
  const bridge = { port: link.port, token: link.token, extensionSeenAt: link.linkedAt, proven: true } as const satisfies ProvenBridge;
  let status: BridgeHostStatus;
  try {
    status = await Promise.race([
      bridgeStatus(bridge),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), left())),
    ]);
  } catch {
    return host("the laptop's bridge did not answer in time");
  }
  if (!status.extensionConnected) return host("the Chrome extension on the laptop is not connected");
  return { mode: "laptop", laptop: link.laptop, bridge, status };
}

/** The last choice, so a session hears one line when it changes and nothing while it holds. */
const verdictPath = (): string => path.join(browserHome(), "laptop-link-verdict.json");

/** The laptop the last command here used or fell back from, if any. */
export function lastLinkedLaptop(file = verdictPath()): string | null {
  try { return (JSON.parse(fs.readFileSync(file, "utf-8")) as { laptop?: string }).laptop ?? null; } catch { return null; }
}

/** The line to print when the choice changed since the last command on this host, else null. */
export function switchNotice(v: LinkVerdict, file = verdictPath()): string | null {
  let prev: { mode?: string; laptop?: string } = {};
  try { prev = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* first command */ }
  const key = { mode: v.mode, laptop: v.laptop };
  if (prev.mode === key.mode && prev.laptop === key.laptop) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ ...key, at: Date.now() }), { mode: 0o600 });
  } catch { /* the notice repeats next time; nothing else depends on it */ }
  if (v.mode === "laptop") return `browser: using ${v.laptop}'s Chrome`;
  // A host that never had a link says nothing: its own Chrome is all it ever used.
  if (!prev.mode) return null;
  return `browser: ${v.reason}; using this host's own Chrome`;
}

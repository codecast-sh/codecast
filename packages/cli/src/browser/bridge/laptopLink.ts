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

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { browserHome } from "../profile.js";
import { defaultConfigDir, readSharedConfig } from "../../config/sharedConfig.js";
import { bridgeProof, randomNonce, secretMatches } from "./protocol.js";
import { hashHostToken } from "./hostClients.js";
import { RUN_ON_LAPTOP, askToRun } from "@codecast/shared/contracts/commandRun";
import { bridgeStatus, type BridgeHostStatus, type ProvenBridge } from "./host.js";

export const LAPTOP_LINK_FILE = "laptop-link.json";
/**
 * Why the laptop closed the link, when it said: the line it writes before
 * closing on purpose. The link's remote side keeps it after removing the link
 * file, and a new link removes it.
 */
export const LAPTOP_LINK_CLOSED_FILE = "laptop-link-closed.json";

/**
 * One file per laptop (by device id), so two laptops can link one host. The
 * legacy single file is still written by each link (last writer wins) for a
 * host whose cast predates this directory.
 */
export const LAPTOP_LINKS_DIR = "laptop-links";

export interface LaptopLinkClosed { v: 1; reason: "revoked"; laptop: string; hostId: string; at: number }

/** The first host-side port a laptop may forward to, and how many follow it. */
export const LINK_HOST_PORT_BASE = 42_000;
export const LINK_HOST_PORT_SPAN = 8_000;

/**
 * The host loopback port a laptop's link binds, derived from its device id so
 * each laptop has its own: with one shared number the second laptop's forward
 * always failed on the first one's port.
 */
export function linkHostPort(device: string): number {
  return LINK_HOST_PORT_BASE + (parseInt(crypto.createHash("sha256").update(device).digest("hex").slice(0, 8), 16) % LINK_HOST_PORT_SPAN);
}

/** A device id is safe in a file name and a shell word. */
export const isLinkDevice = (d: unknown): d is string => typeof d === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(d);

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
  /** The laptop's device id; absent from a laptop whose cast predates per-laptop links. */
  device?: string;
  /** The user id the laptop is signed in as: a host session only uses its own person's laptop. */
  owner?: string;
}


export function readLaptopLinkFile(file: string): LaptopLink | null {
  try {
    const l = JSON.parse(fs.readFileSync(file, "utf-8")) as LaptopLink;
    return l?.v === 1 && Number.isInteger(l.port) && typeof l.token === "string" && typeof l.hostId === "string" ? l : null;
  } catch {
    return null;
  }
}

/**
 * Every laptop linked to this host right now, newest first, one per device.
 * The legacy file names whichever laptop wrote it last; it counts only for a
 * laptop that has no file of its own here (one whose cast predates them).
 */
export function readLaptopLinks(home = browserHome(), owner?: string | null): LaptopLink[] {
  const dir = path.join(home, LAPTOP_LINKS_DIR);
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(".closed.json")); } catch { /* none yet */ }
  const links = names.map((n) => readLaptopLinkFile(path.join(dir, n))).filter((l): l is LaptopLink => !!l);
  const legacy = readLaptopLinkFile(path.join(home, LAPTOP_LINK_FILE));
  if (legacy && !links.some((l) => (legacy.device && l.device === legacy.device) || l.token === legacy.token)) links.push(legacy);
  return links
    .filter((l) => !owner || !l.owner || l.owner === owner)
    .sort((a, b) => b.linkedAt - a.linkedAt);
}

/** The link `cast browser` uses: the newest of this person's laptops (the only one, for one laptop). */
export function readLaptopLink(home = browserHome(), owner = ownUserId()): LaptopLink | null {
  return readLaptopLinks(home, owner)[0] ?? null;
}

/** The person this machine is signed in as, the owner a host's links must match. */
export function ownUserId(): string | null {
  return readSharedConfig(defaultConfigDir()).user_id ?? null;
}

export type LaptopPick = { link: LaptopLink } | { error: string; links: LaptopLink[] };

/**
 * Which laptop `--on <selector>` names: `laptop` is this person's only linked
 * laptop; a device id (or its prefix) or the laptop's name picks one of several.
 */
export function pickLaptopLink(links: LaptopLink[], selector: string): LaptopPick {
  const s = selector.trim().toLowerCase();
  const names = (ls: LaptopLink[]) => ls.map((l) => `${l.laptop}${l.device ? ` (${l.device.slice(0, 8)})` : ""}`).join(", ");
  if (!links.length) return { error: "no laptop is linked to this host right now: the laptop is off, asleep or offline, or this host is shared with teammates", links };
  if (s === "laptop") {
    if (links.length === 1) return { link: links[0]! };
    return { error: `${links.length} laptops are linked to this host: ${names(links)}. Name one with --on <laptop name or device id>`, links };
  }
  const hit = links.filter((l) => l.laptop.toLowerCase() === s || (!!l.device && l.device.toLowerCase().startsWith(s)));
  if (hit.length === 1) return { link: hit[0]! };
  if (hit.length > 1) return { error: `--on ${selector} matches ${names(hit)}; use more of the device id`, links };
  return { error: `no linked laptop matches --on ${selector}; linked: ${names(links)}`, links };
}

function readClosedFile(file: string): LaptopLinkClosed | null {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf-8")) as LaptopLinkClosed;
    return c?.v === 1 && c.reason === "revoked" && typeof c.laptop === "string" && typeof c.hostId === "string" ? c : null;
  } catch {
    return null;
  }
}

/** The newest "closed because revoked" line any laptop left here. */
export function readLaptopLinkClosed(home = browserHome()): LaptopLinkClosed | null {
  const dir = path.join(home, LAPTOP_LINKS_DIR);
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith(".closed.json")).map((n) => path.join(dir, n)); } catch { /* none */ }
  files.push(path.join(home, LAPTOP_LINK_CLOSED_FILE));
  return files.map(readClosedFile).filter((c): c is LaptopLinkClosed => !!c).sort((a, b) => b.at - a.at)[0] ?? null;
}

export type LinkVerdict =
  | { mode: "laptop"; laptop: string; bridge: ProvenBridge; status: BridgeHostStatus }
  | { mode: "host"; laptop?: string; reason: string; revoked?: true };

/** The host's verdict once its laptop has refused this host's key. */
export const revokedVerdict = (laptop: string, hostId: string): LinkVerdict => ({
  mode: "host",
  laptop,
  revoked: true,
  reason: `${laptop} refused this host's key (revoked there). To let this host use that Chrome again, ask your person with a Yes card: ${askToRun("Let this cloud host use the Chrome on your laptop again?", `cast browser extension link --host ${hostId}`, RUN_ON_LAPTOP)}`,
});

/** The whole probe's budget: a dead laptop costs a session this much per command, no more. */
export const LINK_PROBE_BUDGET_MS = 1_500;

/**
 * Does the link reach a bridge that holds this host's token, with the
 * extension on it? Proof first, so the token is never presented to a
 * squatter on the host's port.
 */
/**
 * Is the bridge on the link's port the laptop holding this host's token?
 * Proof first, so the token is never presented to a squatter on the host's
 * port. Null when proven, else the verdict that says why not.
 */
export async function proveLaptopBridge(link: LaptopLink, budgetMs = LINK_PROBE_BUDGET_MS): Promise<LinkVerdict | null> {
  const host = (reason: string): LinkVerdict => ({ mode: "host", laptop: link.laptop, reason });
  const nonce = randomNonce();
  let body: string;
  try {
    const res = await fetch(`http://127.0.0.1:${link.port}/healthz?client=${encodeURIComponent(link.hostId)}&nonce=${nonce}`, { signal: AbortSignal.timeout(Math.max(100, budgetMs)) });
    body = await res.text();
  } catch {
    return host("the laptop is not reachable over its link");
  }
  if (!body.startsWith("cast-bridge")) return host(`something else answers on 127.0.0.1:${link.port}`);
  const proof = /proof=([0-9a-f]+)/.exec(body)?.[1];
  if (!secretMatches(bridgeProof(hashHostToken(link.token), "healthz", nonce), proof)) return revokedVerdict(link.laptop, link.hostId);
  return null;
}

/** Does the link reach a bridge that holds this host's token, with the extension on it? */
export async function probeLaptopLink(link: LaptopLink, budgetMs = LINK_PROBE_BUDGET_MS): Promise<LinkVerdict> {
  const deadline = Date.now() + budgetMs;
  const left = () => Math.max(100, deadline - Date.now());
  const host = (reason: string): LinkVerdict => ({ mode: "host", laptop: link.laptop, reason });
  const refused = await proveLaptopBridge(link, budgetMs);
  if (refused) return refused;
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
  let prev: { mode?: string; laptop?: string; revoked?: boolean } = {};
  try { prev = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* first command */ }
  const key = { mode: v.mode, laptop: v.laptop, revoked: v.mode === "host" && v.revoked === true };
  if (prev.mode === key.mode && prev.laptop === key.laptop && (prev.revoked ?? false) === key.revoked) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ ...key, at: Date.now() }), { mode: 0o600 });
  } catch { /* the notice repeats next time; nothing else depends on it */ }
  if (v.mode === "laptop") return `browser: using ${v.laptop}'s Chrome`;
  // A host that never had a link says nothing: its own Chrome is all it ever used.
  if (!prev.mode) return null;
  return `browser: ${v.reason}; using this host's own Chrome`;
}

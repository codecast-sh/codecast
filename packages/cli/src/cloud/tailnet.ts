/**
 * Tailscale as an optional, better path to a cloud host.
 *
 * Nothing here is required. When this laptop runs Tailscale and a host's node
 * sits on the same tailnet, dialing the host's tailnet IP keeps SSH alive
 * across the laptop's network changes (the IP does not move when the laptop
 * does) and needs no public port. Every other case dials the public address
 * exactly as before, and a tailnet dial that does not answer falls back to it
 * (cloudHost.ts reachableRemoteHost).
 *
 * Trust rule: a host's recorded tailnet IP is used only while this laptop's
 * own `tailscale status` shows a node at that IP, online, under the node name
 * recorded with it. A host that left the tailnet, a reissued IP, a stopped or
 * logged-out tailscaled, a missing or hanging binary: all mean public.
 *
 * The record ({ ip, name }) is learned from the host itself over SSH
 * (readHostTailnet) whenever ensureUp reaches it, so it follows the host
 * joining or leaving the tailnet.
 */

import { spawnSync } from "../proc.js";
import * as fs from "node:fs";

export interface TailnetRecord {
  /** The host node's tailnet IPv4. */
  ip: string;
  /** Its MagicDNS name, the identity checked before the IP is dialed. */
  name: string;
  checkedAt: number;
}

interface Node { DNSName?: string; TailscaleIPs?: string[]; Online?: boolean }
export interface TailnetStatus { BackendState?: string; Self?: Node; Peer?: Record<string, Node> }

const MAC_APP_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const STATUS_TIMEOUT_MS = 2_000;
const CACHE_MS = 15_000;
let cache: { key: string; at: number; status: TailnetStatus | null } | undefined;

/** The binary to ask: CODECAST_TAILSCALE_BIN, else `tailscale` on PATH, else the macOS app's. */
function candidates(): string[] {
  const pinned = process.env.CODECAST_TAILSCALE_BIN;
  if (pinned !== undefined) return pinned ? [pinned] : [];
  return process.platform === "darwin" && fs.existsSync(MAC_APP_BIN) ? ["tailscale", MAC_APP_BIN] : ["tailscale"];
}

/** `tailscale status --json` parsed, or null when there is no usable answer. */
export function parseTailnetStatus(stdout: string): TailnetStatus | null {
  try {
    const s = JSON.parse(stdout) as TailnetStatus;
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

/**
 * This machine's tailnet, when tailscaled is up and logged in; null otherwise.
 * Cached briefly: toRemoteHost runs on every daemon tick for every host.
 */
export function localTailnet(): TailnetStatus | null {
  const key = `${process.env.CODECAST_TAILSCALE_BIN ?? ""}|${process.env.PATH ?? ""}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.status;
  let status: TailnetStatus | null = null;
  for (const bin of candidates()) {
    // env passed explicitly: bun otherwise resolves the binary against the
    // PATH it snapshotted at startup, not the one the process holds now.
    const r = spawnSync(bin, ["status", "--json"], { encoding: "utf-8", timeout: STATUS_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], env: process.env });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
    if (r.status === 0) status = parseTailnetStatus(r.stdout);
    break;
  }
  if (status?.BackendState !== "Running") status = null;
  cache = { key, at: Date.now(), status };
  return status;
}

/** The recorded IP, if this tailnet shows that exact node online there; else null. */
export function tailnetDialAddress(record: TailnetRecord | undefined, status: TailnetStatus | null = record ? localTailnet() : null): string | null {
  if (!record || !status) return null;
  const node = Object.values(status.Peer ?? {}).find((p) => p.TailscaleIPs?.includes(record.ip));
  return node?.Online === true && node.DNSName === record.name ? record.ip : null;
}

/** Run on the host: its own status, or nothing when it has no tailscale. */
export const HOST_TAILNET_COMMAND = "tailscale status --json 2>/dev/null || true";

/** The host's record from HOST_TAILNET_COMMAND's output; undefined when it is not on a running tailnet. */
export function readHostTailnet(stdout: string, now = Date.now()): TailnetRecord | undefined {
  const s = parseTailnetStatus(stdout);
  if (s?.BackendState !== "Running") return undefined;
  const ip = s.Self?.TailscaleIPs?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const name = s.Self?.DNSName;
  return ip && name ? { ip, name, checkedAt: now } : undefined;
}

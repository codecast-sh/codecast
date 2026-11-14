/**
 * `cast computer remote` on the laptop: the person's switch for which cloud
 * hosts may drive this Mac's apps (computer/remoteGrant.ts). Granting is the
 * person's; an agent session is refused and handed the card to raise.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { fmt, icons } from "../colors.js";
import { sessionIdFromEnv } from "../sessionIdentity.js";
import { isRemoteDevice } from "../remote/device.js";
import { patchHost, readHosts, resolveCloudHost, type CloudHost } from "../browser/cloudHost.js";
import { bridgeHostLogPath, ensureBridgeHost, revokeHostClient } from "../browser/bridge/host.js";
import { askForGrant, newGrant, parseDuration, type ComputerHostGrant } from "./remoteGrant.js";

const laptopName = (): string => os.hostname().replace(/\.local$/, "");

function die(message: string, hint?: string): never {
  console.error(`${fmt.error(icons.cross)} ${message}`);
  if (hint) console.error(`  ${fmt.muted(hint)}`);
  process.exit(1);
}

function hostOrDie(id: string): CloudHost {
  try { return resolveCloudHost(id); } catch (err) { return die((err as Error).message); }
}

export function describeGrant(g: ComputerHostGrant | undefined, now = Date.now()): string {
  if (!g) return "off";
  const parts = [`on since ${new Date(g.grantedAt).toISOString().slice(0, 16)}Z`];
  if (g.sessions?.length) parts.push(`sessions ${g.sessions.join(", ")}`);
  if (g.apps?.length) parts.push(`apps ${g.apps.join(", ")}`);
  if (g.expiresAt !== undefined) parts.push(g.expiresAt > now ? `until ${new Date(g.expiresAt).toISOString().slice(0, 16)}Z` : "expired");
  return parts.join(", ");
}

export async function grantRemote(o: { host: string; session?: string[]; for?: string; apps?: string[] }): Promise<void> {
  if (isRemoteDevice()) die("grant runs on the laptop whose apps it shares, not on a cloud host");
  const host = hostOrDie(o.host);
  // The person's act: from an agent, the Run card is how it reaches them,
  // and the daemon runs it with the session env stripped (run_cast, personEnv).
  if (sessionIdFromEnv()) die("letting a cloud host drive this Mac's apps is your person's call, not an agent's", `ask with a Yes card: ${askForGrant(host.id, laptopName())}`);
  if (host.shared) die(`${host.id} is shared with teammates: their sessions would drive this Mac's apps, so it is never granted`);
  const forMs = o.for ? parseDuration(o.for) : undefined;
  if (o.for && !forMs) die(`--for takes 30m, 8h or 2d (got "${o.for}")`);
  patchHost(host.id, { laptopComputer: newGrant({ session: o.session, forMs: forMs ?? undefined, apps: o.apps }) });
  await ensureBridgeHost().catch((err: Error) => die(`granted, but this Mac's bridge would not start: ${err.message}`));
  console.log(`${fmt.success(icons.check)} ${host.id} may drive this Mac's apps (${describeGrant(readHosts().find((h) => h.id === host.id)?.laptopComputer)}); the daemon links it within a minute`);
  console.log(fmt.muted(`  stop it: cast computer remote revoke --host ${host.id}`));
}

export async function revokeRemote(o: { host: string }): Promise<void> {
  const host = readHosts().find((h) => h.id === o.host);
  if (!host) die(`no cloud host ${o.host} here (cast hosts ls)`);
  patchHost(host.id, { laptopComputer: undefined });
  // Nothing left on the link: its key goes too, and the daemon closes it.
  if (host.laptopBrowser === false) {
    revokeHostClient(host.id);
  }
  console.log(`${fmt.success(icons.check)} ${host.id} no longer drives this Mac's apps; its live sessions are cut off within seconds`);
}

/** The last thing each host did here, from the bridge host's log. */
function lastActivity(): Map<string, string> {
  const seen = new Map<string, string>();
  try {
    const file = bridgeHostLogPath();
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(size, 512 * 1024));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    for (const line of buf.toString("utf-8").split("\n")) {
      const m = /^(\S+) .*\[COMPUTER-REMOTE\] (\S+) (.*)$/.exec(line);
      if (m) seen.set(m[2]!, `${m[1]!.slice(0, 19)}Z ${m[3]}`);
    }
  } catch { /* no log yet */ }
  return seen;
}

export async function listRemote(o: { json?: boolean }): Promise<void> {
  const hosts = readHosts();
  const activity = lastActivity();
  const rows = hosts.map((h) => ({ host: h.id, address: h.address ?? null, shared: !!h.shared, browser: h.laptopBrowser !== false, computer: h.laptopComputer ?? null, last: activity.get(h.id) ?? null }));
  if (o.json) return void console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return void console.log("no cloud hosts on this laptop (cast hosts ls)");
  for (const r of rows) {
    console.log(`${r.host}${r.address ? `  ${r.address}` : ""}${r.shared ? "  shared" : ""}`);
    console.log(`  apps     ${describeGrant(r.computer ?? undefined)}`);
    console.log(`  chrome   ${r.browser ? "on" : "off"}`);
    if (r.last) console.log(`  last     ${r.last}`);
  }
}

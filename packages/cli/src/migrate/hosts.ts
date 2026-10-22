/**
 * The cloud host a move goes to, and whether it can take the session: shared
 * by the runner (io.ts) and the rehearsal (rehearse.ts).
 */

import * as fs from "node:fs";
import { ensureUp, hostForDevice, readHosts, toRemoteHost, type CloudHost } from "../browser/cloudHost.js";
import { learnHostDeviceId } from "../cloud/prepare.js";
import { readPushableCredentialAsync, remoteClaudeLoginLive, type RemoteHost } from "../remote/session-move.js";

/**
 * Wakes and resolves the cloud host behind a device id, once per process:
 * from the registry, else by asking each host this machine provisioned that
 * has not reported its device id yet. Throws when this machine cannot reach it.
 */
export function hostResolver(log: (line: string) => void): (deviceId: string) => Promise<{ cloud: CloudHost; host: RemoteHost }> {
  const hosts = new Map<string, { cloud: CloudHost; host: RemoteHost }>();
  return async (deviceId: string) => {
    const cached = hosts.get(deviceId);
    if (cached) return cached;
    let cloud = hostForDevice(deviceId);
    if (!cloud) {
      // The registry knows the host but has not learned its device id yet
      // (nothing was placed on it from this machine). Wake each unlearned host
      // once and ask.
      for (const h of readHosts().filter((h) => !h.deviceId)) {
        try {
          const up = await ensureUp(h, (m) => log(`  ${h.id}: ${m}`));
          const id = await learnHostDeviceId(up, toRemoteHost(up));
          if (id === deviceId) { cloud = { ...up, deviceId: id }; break; }
        } catch (err) {
          log(`  ${h.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (!cloud) {
      throw new Error(`this machine has no registered cloud host for device ${deviceId.slice(0, 8)} (cast hosts ls); only the machine that provisioned the host can move sessions to or from it`);
    }
    const up = await ensureUp(cloud, (m) => log(`  ${cloud!.id}: ${m}`));
    const host = toRemoteHost(up);
    const learned = await learnHostDeviceId(up, host);
    if (learned && learned !== deviceId) {
      throw new Error(`host ${up.id} reports device ${learned.slice(0, 8)}, not ${deviceId.slice(0, 8)} — the registry is stale (cast hosts ls)`);
    }
    const entry = { cloud: up, host };
    hosts.set(deviceId, entry);
    return entry;
  };
}

/** Why the host could not run a Claude session now, or null. Every move pushes this machine's credential, so the host is asked only when there is nothing to push. */
export async function hostLoginGap(host: () => Promise<RemoteHost>): Promise<string | null> {
  const local = await readPushableCredentialAsync();
  if (local.cred) return null;
  return remoteClaudeLoginLive(await host()) ? null : `this machine has none to give it: ${local.reason}`;
}

/** Whether the host can take one more session from `localRoot` now (cloud/hostHeadroom). */
export async function hostRoom(cloud: CloudHost, localRoot: string | undefined): Promise<{ refuse?: string; small?: string }> {
  const { probeHeadroom, readRepoNeed, tooSmallFor } = await import("../cloud/hostHeadroom.js");
  const room = probeHeadroom(cloud);
  if (!room.fit) return { refuse: room.why ?? "no room" };
  const small = tooSmallFor(room, readRepoNeed(localRoot && fs.existsSync(localRoot) ? localRoot : undefined));
  return small ? { small } : {};
}


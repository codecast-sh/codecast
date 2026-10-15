/**
 * Autoscale's launch: `cast hosts create linux --like <template>` as a child,
 * its lines streamed to the placement log, under one laptop-wide lock so two
 * placements never launch at once. The second placement waits for the lock,
 * then chooses again, and by then the new host is awake with room.
 */

import * as path from "node:path";
import { spawn } from "../proc.js";
import { CLOUD_START_RUN_MS } from "@codecast/shared/contracts";
import { readHosts, toRemoteHost, type CloudHost } from "../browser/cloudHost.js";
import { learnHostDeviceId } from "./prepare.js";
import { resolveCastInvocation } from "../castInvocation.js";
import { defaultConfigDir } from "../config/configDir.js";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { withMirrorLock } from "./mirror/apply.js";

/** Run `fn` holding the laptop's autoscale lock (waits up to a whole placement). */
export function withAutoscaleLock<T>(fn: () => Promise<T>): Promise<T> {
  return withMirrorLock(path.join(defaultConfigDir(), "autoscale-lock"), fn, undefined, CLOUD_START_RUN_MS);
}

/** Launch and provision a host like `like`; resolves to its registry entry. */
export async function launchAutoscaledHost(like: CloudHost, size: string, log: (m: string) => void): Promise<CloudHost> {
  const { cmd, prefixArgs } = resolveCastInvocation();
  const args = [...prefixArgs, "hosts", "create", "linux", "--like", like.id, "--type", size, "--autoscaled"];
  let launched: string | undefined;
  const tail: string[] = [];
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: agentSpawnPath() } });
    const onLine = (chunk: Buffer) => {
      for (const raw of chunk.toString().split("\n")) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!line) continue;
        launched ??= /Registered (i-[0-9a-f]+)/.exec(line)?.[1];
        tail.push(line);
        if (tail.length > 5) tail.shift();
        log(line);
      }
    };
    child.stdout.on("data", onLine);
    child.stderr.on("data", onLine);
    child.on("error", () => resolve(null));
    child.on("close", resolve);
  });
  const host = launched ? readHosts().find((h) => h.id === launched) : undefined;
  if (code !== 0 || !host) {
    throw new Error(`autoscale could not ready a new host${launched ? ` (${launched})` : ""}: ${tail.at(-1) ?? `exit ${code}`}`);
  }
  // Provisioning leaves the daemon's device id unlearned; the next choice
  // only spreads onto hosts that have one.
  const deviceId = await learnHostDeviceId(host, toRemoteHost(host));
  if (!deviceId) throw new Error(`autoscale launched ${host.id} but its codecast daemon is not answering`);
  return { ...host, deviceId };
}

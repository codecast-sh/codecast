import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { atomicWriteFile } from "../atomicWrite.js";
import { defaultConfigDir } from "../config/configDir.js";

export interface KeepaliveOptions {
  configDir?: string;
  platform?: NodeJS.Platform;
  idleConfigPath?: string;
  now?: number;
}

export function createHostKeepalive(minutes: string, options: KeepaliveOptions = {}): { id: string; expiresAt: string } {
  const duration = Number(minutes);
  if (/\D/.test(minutes) || !Number.isInteger(duration) || duration < 1 || duration > 1440) {
    throw new Error("minutes must be a whole number from 1 to 1440");
  }
  if ((options.platform ?? process.platform) !== "linux"
    || !fs.statSync(options.idleConfigPath ?? "/etc/cast-idle-minutes", { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Run `cast hosts keepalive` on an existing cloud Linux host with /etc/cast-idle-minutes");
  }

  const expiry = Math.floor((options.now ?? Date.now()) / 1000) + duration * 60;
  const lease = { id: randomUUID(), expiresAt: new Date(expiry * 1000).toISOString() };
  const dir = path.join(options.configDir ?? defaultConfigDir(), "host-keepalive");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  atomicWriteFile(path.join(dir, lease.id), `${expiry}\n`, { mode: 0o600 });
  return lease;
}

export function registerHostKeepaliveCommand(hosts: Command, options: KeepaliveOptions = {}): void {
  hosts
    .command("keepalive <minutes>")
    .description("Keep this cloud Linux host awake for 1–1440 whole minutes; run on the host")
    .allowExcessArguments(false)
    .option("--json", "Print the lease id and ISO expiry as JSON")
    .action((minutes: string, o: { json?: boolean }) => {
      const lease = createHostKeepalive(minutes, options);
      console.log(o.json ? JSON.stringify(lease) : `Keepalive lease ${lease.id} expires at ${lease.expiresAt}`);
    });
}

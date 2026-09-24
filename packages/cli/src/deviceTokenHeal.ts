// The network half of the heal bearerToken.ts starts when this machine's
// device id no longer matches the device its bound token was minted for.
// The old token, presented with the device it was minted for, mints a token
// bound to this machine through apiTokens.mintForDevice; the new token goes
// into config.json and the heal record.
//
// Several processes find the move at once (the daemon and a cast command, or
// the hooks of every running agent), so an exclusive lock file picks one to
// mint; the rest keep presenting the old token, which still works, and read
// the new one from the record on their next load. The old token is not
// revoked: on a disk clone the source machine still uses it.

import * as fs from "node:fs";
import * as path from "node:path";
import { presentToken, splitPresentedToken } from "@platform/auth/tokenFormat";
import { fingerprint, healRecordFile, readHealRecord, type HealRecord } from "./bearerToken.js";
import { defaultConfigDir } from "./config/configDir.js";
import { mintTokenForDevice } from "./remote/convexClient.js";
import { deviceLabel } from "./remote/device.js";
import { decryptToken, encryptToken, isEncryptedToken } from "./tokenEncryption.js";

/** A lock older than this belongs to a process that died mid heal. */
const STALE_LOCK_MS = 60_000;

export type HealOutcome = "healed" | "already" | "busy" | "refused" | "failed";

export async function healDeviceToken(input: { secret: string; minted: string; current: string }): Promise<HealOutcome> {
  const lock = path.join(defaultConfigDir(), ".device_token_heal.lock");
  if (!takeLock(lock)) return "busy";
  try {
    const from = fingerprint(input.secret);
    if (readHealRecord()?.from === from) return "already";
    const configFile = path.join(defaultConfigDir(), "config.json");
    // Another process may have healed and then a fresh sign in replaced the
    // token entirely; only the token this process read is ours to heal.
    const stored = JSON.parse(fs.readFileSync(configFile, "utf-8")).auth_token;
    const plain = isEncryptedToken(stored) ? decryptToken(stored) : stored;
    if (splitPresentedToken(plain).secret !== input.secret) return "already";

    let token: string;
    try {
      token = await mintTokenForDevice(input.current, `${deviceLabel()} (moved)`, presentToken(input.secret, input.minted));
    } catch (err) {
      if (!/Unauthorized/.test(err instanceof Error ? err.message : String(err))) return "failed";
      writeAtomic(healRecordFile(), { from, refused: true } satisfies HealRecord);
      return "refused";
    }
    const to = encryptToken(presentToken(token, input.current));
    // The record first: from here on every load and save of the old token
    // resolves to the new one, even if the config write below never lands.
    writeAtomic(healRecordFile(), { from, to } satisfies HealRecord);
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    writeAtomic(configFile, { ...config, auth_token: to }, 2);
    return "healed";
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function takeLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600));
      return true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs < STALE_LOCK_MS) return false;
        fs.rmSync(lock, { force: true });
      } catch {}
    }
  }
  return false;
}

function writeAtomic(file: string, value: unknown, indent?: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, indent), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// The stored token and the credential it becomes on the wire.
//
// config.json holds the token encrypted for this machine. In memory,
// `config.auth_token` is what a request sends as `api_token`: the secret
// itself for an ordinary token, and `<secret>.<device_id>` for a token the
// server bound to a machine (the secret says so by its prefix; see
// @platform/auth tokenFormat). A bound token is stored with the device it
// was minted for, inside the encryption, so the secret and its device can
// never be paired wrongly by a writer. A config copied to another machine
// cannot be decrypted there unless the machine key came along with it, and a
// whole ~/.codecast copy is not something binding can stop.
//
// When that happens (Migration Assistant, a disk clone, a host landing on new
// hardware) the machine key rotates and this machine's device id moves, so the
// token is bound to a device that is no longer this one. The read still
// presents the minted device, so nothing breaks, and starts a heal: the old
// token mints one bound to the new device (deviceTokenHeal.ts). The heal
// leaves a record in the config dir mapping the old secret to its successor,
// read on every load and save here, so a process that read the old token
// before the heal cannot write it back.
//
// Composed once, where the token is decrypted, rather than at the ~300 call
// sites that build request bodies or Convex args: a step every caller has to
// remember is a step the newest caller forgets.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeviceBoundToken, presentToken, splitPresentedToken } from "@platform/auth/tokenFormat";
export { isDeviceBoundToken } from "@platform/auth/tokenFormat";
import { defaultConfigDir } from "./config/configDir.js";
import { deviceId, previousDeviceId } from "./remote/device.js";
import { TokenDecryptError, decryptToken, encryptToken, isEncryptedToken } from "./tokenEncryption.js";

/**
 * Whether a mint (`cast auth`, `cast login`) asks the server to bind the new
 * token to this machine. OFF until decision sd-242 settles how remote hosts
 * get a token, because host provisioning copies this machine's token and a
 * bound one cannot be copied. Everything else stays live: the server enforces
 * the binding on any bound token, and a bound token already in a config is
 * presented with its device. Flipping this is the whole rollout.
 */
export const REQUEST_DEVICE_BOUND_TOKENS = false;

/** The device a mint names, or nothing while the switch above is off. */
export function mintDeviceId(): string | undefined {
  return REQUEST_DEVICE_BOUND_TOKENS ? deviceId() : undefined;
}

/** The plaintext secret behind what config.json stores, encrypted or not. Throws TokenDecryptError. */
export function secretFromStored(stored: string): string {
  return splitPresentedToken(plainFromStored(stored)).secret;
}

/** What a stored token is presented as on the wire. Throws TokenDecryptError. */
export function bearerFromStored(stored: string): string {
  const { secret, deviceId: stamped } = splitPresentedToken(plainFromStored(stored));
  if (!isDeviceBoundToken(secret)) return secret;
  const record = readHealRecord();
  if (record?.from === fingerprint(secret)) {
    if (record.to && secretFromStored(record.to) !== secret) return bearerFromStored(record.to);
    throw new TokenDecryptError(
      "This machine's Codecast sign-in is bound to another machine and could not be moved here. Run `cast auth` to sign this machine in.",
    );
  }
  const current = deviceId();
  // A token stored before devices were kept beside it: after a key rotation,
  // the device it was minted for is the one the old key gave.
  const minted = stamped ?? previousDeviceId() ?? current;
  if (minted !== current) startDeviceTokenHeal(secret, minted, current);
  return presentToken(secret, minted);
}

/** What goes back into config.json for an in-memory token: encrypted, a bound secret with its device. */
export function storedFromBearer(bearer: string): string {
  if (isEncryptedToken(bearer)) return bearer;
  const { secret, deviceId: presented } = splitPresentedToken(bearer);
  if (!isDeviceBoundToken(secret)) return encryptToken(secret);
  const record = readHealRecord();
  if (record?.to && record.from === fingerprint(secret)) return record.to;
  // A fresh mint arrives as the bare secret, bound to the device that asked.
  return encryptToken(presentToken(secret, presented ?? deviceId()));
}

function plainFromStored(stored: string): string {
  return isEncryptedToken(stored) ? decryptToken(stored) : stored;
}

/** What a heal left behind: the old secret's fingerprint, and its successor or the server's refusal. */
export interface HealRecord {
  from: string;
  to?: string;
  refused?: true;
}

export function healRecordFile(): string {
  return path.join(defaultConfigDir(), ".device_token_heal.json");
}

export function readHealRecord(): HealRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(healRecordFile(), "utf-8"));
    return typeof r?.from === "string" ? r : null;
  } catch {
    return null;
  }
}

/** A secret's name in the heal record, so the record never holds a usable credential in the clear. */
export function fingerprint(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 32);
}

let heal: Promise<void> | null = null;
let lastHealAt = 0;
const HEAL_RETRY_MS = 10 * 60_000;

/**
 * Start the heal in the background, at most once per process at a time and
 * once per ten minutes after a failure, so a long lived daemon offline at the
 * move tries again without looping. The lock in deviceTokenHeal.ts keeps
 * separate processes from minting twice.
 */
function startDeviceTokenHeal(secret: string, minted: string, current: string): void {
  if (heal || Date.now() - lastHealAt < HEAL_RETRY_MS) return;
  lastHealAt = Date.now();
  heal = import("./deviceTokenHeal.js")
    .then((m) => m.healDeviceToken({ secret, minted, current }))
    .then(() => {}, () => {})
    .finally(() => {
      heal = null;
    });
}

/** The heal this process started, if any, for a caller that wants it finished before exit. */
export function pendingDeviceTokenHeal(): Promise<void> {
  return heal ?? Promise.resolve();
}

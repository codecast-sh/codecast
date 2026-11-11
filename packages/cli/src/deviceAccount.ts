// Which account this machine last synced as. When `cast auth` signs the box
// into a different account, the running daemon still holds the old token
// until it restarts. The stamp is the previous account, so the next boot can
// move the sessions this device already owns onto the new one.
//
// The stamp also keeps that account's token (encrypted, as config.json keeps
// it). It is what proves to the server that the previous account really was
// signed in on this machine: a device id alone is public to teammates.
import * as fs from "node:fs";
import * as path from "node:path";
import { bearerFromStored, storedFromBearer } from "./bearerToken.js";

export const DEVICE_ACCOUNT_FILE = "device-account.json";

export function accountSwitchRestartReason(
  runningUserId: string | null | undefined,
  diskUserId: string | null | undefined,
): string | null {
  if (!runningUserId || !diskUserId || runningUserId === diskUserId) return null;
  return `account changed from ${runningUserId} to ${diskUserId}`;
}

export function readDeviceAccountStamp(dir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, DEVICE_ACCOUNT_FILE), "utf8"));
    return typeof raw?.user_id === "string" && raw.user_id ? raw.user_id : null;
  } catch {
    return null;
  }
}

/** The previous account's token as the claim presents it, or undefined when the stamp has none. */
export function readDeviceAccountBearer(dir: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, DEVICE_ACCOUNT_FILE), "utf8"));
    return typeof raw?.auth_token === "string" && raw.auth_token ? bearerFromStored(raw.auth_token) : undefined;
  } catch {
    return undefined;
  }
}

/** Record the account this machine syncs as, with the token it presents (`config.auth_token`). */
export function writeDeviceAccountStamp(dir: string, userId: string, bearer?: string | null): void {
  const file = path.join(dir, DEVICE_ACCOUNT_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const auth_token = bearer ? storedFromBearer(bearer) : undefined;
  fs.writeFileSync(file, JSON.stringify({ user_id: userId, ...(auth_token ? { auth_token } : {}) }) + "\n", { mode: 0o600 });
}

/** The account to claim from, or null when this boot is the same login. */
export function previousAccountToClaim(
  stampUserId: string | null | undefined,
  currentUserId: string | null | undefined,
): string | null {
  if (!stampUserId || !currentUserId || stampUserId === currentUserId) return null;
  return stampUserId;
}

export type DeviceClaimResult = { moved?: number; more?: boolean; pending?: boolean; error?: string; needs_proof?: boolean };

/** How long a handover refused for want of proof waits before it is asked again. */
export const DEVICE_CLAIM_PROOF_RETRY_MS = 15 * 60 * 1000;

/**
 * Whether a handover is finished, so the stamp may move to the new account.
 * Anything still owed (the previous login still online, more pages, or a
 * refusal for want of the previous account's token) keeps it: the stamp is
 * the only record of whom to claim from, and discarding it loses the
 * sessions for good.
 */
export function deviceClaimSettled(result: DeviceClaimResult | null | undefined): boolean {
  return !!result && !result.pending && !result.more && !result.needs_proof;
}

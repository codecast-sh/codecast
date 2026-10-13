// Which account this machine last synced as. When `cast auth` signs the box
// into a different account, the running daemon still holds the old token
// until it restarts. The stamp is the previous account, so the next boot can
// move the sessions this device already owns onto the new one.
import * as fs from "node:fs";
import * as path from "node:path";

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

export function writeDeviceAccountStamp(dir: string, userId: string): void {
  const file = path.join(dir, DEVICE_ACCOUNT_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ user_id: userId }) + "\n", { mode: 0o600 });
}

/** The account to claim from, or null when this boot is the same login. */
export function previousAccountToClaim(
  stampUserId: string | null | undefined,
  currentUserId: string | null | undefined,
): string | null {
  if (!stampUserId || !currentUserId || stampUserId === currentUserId) return null;
  return stampUserId;
}

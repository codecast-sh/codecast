// The one-shot gui-domain job that copies a cloud Mac's pushed login file
// into its keychain item (ccAccounts.ts adoptPushedCredential).
import { createHash } from "crypto";
import * as path from "path";
import { startLaunchdJob } from "./launchdJob.js";

const ADOPT_RECHECK_MS = 10 * 60_000;
let lastAdopt: { digest: string; at: number } | undefined;

// $1 service, $2 pushed file, $3 account name for a new item. -U updates the
// existing item in place under its own account, keeping the ACL claude reads it
// through.
const ADOPT_SCRIPT = `new=$(cat "$2") || exit 1
[ "$(security find-generic-password -s "$1" -w 2>/dev/null)" = "$new" ] && exit 0
acct=$(security find-generic-password -s "$1" 2>/dev/null | sed -n 's/.*"acct"<blob>="\\([^"]*\\)".*/\\1/p' | head -1)
security add-generic-password -U -a "\${acct:-$3}" -s "$1" -w "$new" && echo "$(date -u +%FT%TZ) adopted the pushed login"`;

/** Submits the job unless this file went out within ADOPT_RECHECK_MS; true when a job was submitted. */
export function submitAdoptJob(file: string, item: { service: string; account: string }, credentialFile: string, configDir: string, now: number): boolean {
  const digest = createHash("sha256").update(file).digest("hex");
  if (lastAdopt?.digest === digest && now - lastAdopt.at < ADOPT_RECHECK_MS) return false;
  const submitted = startLaunchdJob({
    label: "sh.codecast.adopt-login",
    argv: ["/bin/bash", "-c", ADOPT_SCRIPT, "adopt-login", item.service, credentialFile, item.account],
    plistPath: path.join(configDir, "adopt-login.plist"),
    logPath: path.join(configDir, "logs", "adopt-login.log"),
  });
  if (submitted) lastAdopt = { digest, at: now };
  return submitted;
}

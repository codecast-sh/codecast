/**
 * `cast devices update`'s verdicts. A machine is current only when the version
 * its daemon reports running is at or past the release the manifest names now.
 * Never its own cached check (`update_available`, up to a day old), and never
 * "we asked": on 2026-11-24 `--all` called a fleet on 1.1.272 current with
 * 1.1.273 out, and every press on it was cleared without an update.
 */
import { compareVersions } from "@platform/cli-kit/update";

/** The roster fields a verdict reads (devices.listDevices). */
export interface UpdateRow {
  cli_version?: string;
  online?: boolean;
  last_seen?: number;
  update_requested_at?: number;
  update_state?: "requested" | "installing" | "failed";
  update_error?: string;
}

export type Verdict =
  | { kind: "current" }
  | { kind: "updated"; from?: string }
  | { kind: "failed"; reason: string }
  | { kind: "behind"; reason: string }
  | { kind: "skipped"; reason: string };

const RELEASE = /^\d+\.\d+\.\d+$/;

/** Runs `latest` or newer. An unknown or non-release version is not current. */
export function isCurrent(version: string | undefined, latest: string): boolean {
  return !!version && RELEASE.test(version) && compareVersions(version, latest) >= 0;
}

/** The daemon's update error in plain words, its code kept for searching. */
export function explainUpdateError(code: string | undefined): string {
  if (!code) return "the update failed without a reason";
  const say = (words: string) => `${words} (${code})`;
  if (code.startsWith("checksum_mismatch_")) return say("the downloaded binary did not match the release checksum");
  if (code === "download_incomplete") return say("the download was cut short");
  if (code === "download_too_large") return say("the download was larger than any release");
  const curl = /^download_curl_(\w+)$/.exec(code);
  if (curl) return say(`the download failed (curl exit ${curl[1]})`);
  if (code === "download_redirect_refused" || code === "download_not_https") return say("the download was redirected off the release site");
  if (code === "managed_install") return say("installed by your organization's MDM; it updates with the next Codecast.pkg");
  if (code.startsWith("platform_signature_")) return say("the new binary's code signature was refused");
  if (code.startsWith("manifest_") || code.includes("signature")) return say("the release manifest could not be verified");
  if (/EACCES|EPERM|permission denied/i.test(code)) return say("no permission to replace the binary");
  if (code.startsWith("no_binary_")) return say("the release has no binary for this platform");
  return code;
}

/**
 * Where an asked machine stands now, or null while its update is still under
 * way. `at` is the request this command made.
 */
export function settle(row: UpdateRow, latest: string, at: number): Verdict | null {
  if (isCurrent(row.cli_version, latest)) return { kind: "updated" };
  // A newer press (the web's Update, another shell) takes the request over.
  const mine = row.update_requested_at !== undefined && row.update_requested_at >= at;
  if (mine && row.update_state === "failed") return { kind: "failed", reason: explainUpdateError(row.update_error) };
  if (!mine) return { kind: "failed", reason: "the request was cleared without an update; run it again" };
  return null;
}

/** The verdict for an asked machine that has not settled when the wait ends. */
export function unsettled(row: UpdateRow, waitedSeconds: number, now: number): Verdict {
  if (!row.online) {
    const ago = row.last_seen ? ` (last seen ${ageWords(now - row.last_seen)} ago)` : "";
    return { kind: "behind", reason: `offline${ago}; asked, it updates when it is back` };
  }
  if (waitedSeconds <= 0) return { kind: "behind", reason: "asked; not waiting for it (--wait 0)" };
  const where = row.update_state === "installing" ? "still installing" : "has not started the update";
  return { kind: "behind", reason: `${where} after ${waitedSeconds}s` };
}

function ageWords(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const LABEL: Record<Verdict["kind"], string> = {
  current: "current",
  updated: "updated",
  failed: "failed",
  behind: "not updated",
  skipped: "skipped",
};

/** One machine's result line: verdict, name (padded by the caller), the version it runs, why. */
export function verdictLine(v: Verdict, name: string, version: string | undefined): string {
  const ran = version ?? "unknown";
  const shown = v.kind === "updated" && v.from && v.from !== ran ? `${v.from} → ${ran}` : ran;
  const why = "reason" in v ? `  ${v.reason}` : "";
  return `${LABEL[v.kind].padEnd(12)}${name}${shown}${why}`;
}

/** Failed or still behind: what makes the command exit non-zero. Skipped machines do not count. */
export const notCurrent = (v: Verdict): boolean => v.kind === "failed" || v.kind === "behind";

export function summaryLine(verdicts: Verdict[], latest: string): string {
  const counted = verdicts.filter((v) => v.kind !== "skipped");
  const ok = counted.filter((v) => !notCurrent(v)).length;
  return `${ok} of ${counted.length} on ${latest} or newer`;
}

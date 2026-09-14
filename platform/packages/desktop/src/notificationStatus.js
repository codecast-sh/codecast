// Does the OS actually show this app's notifications?
//
// macOS has no API an Electron app can ask, and the renderer's
// `Notification.permission` says "granted" whether or not a banner will ever
// appear — so an app that trusts it tells the person notifications are on
// while the system drops every one. What macOS does expose is the truth after
// the fact: usernoted logs how it presented each notification. Posting a probe
// and reading that verdict back is the one honest answer available.
//
// Pure parsing here, so the policy is testable without a Mac.

const { execFile } = require("child_process");

/** Presentation verdicts, most to least useful. */
const VERDICTS = ["banner", "alert", "none", "unknown"];

/**
 * Pull this app's most recent presentation verdict out of `log show --style
 * ndjson` output. Lines are one JSON object each; the ones we want read
 * `Presenting <NotificationRecord app:"<id>" …> as banner (…)`.
 */
function parseVerdict(ndjson, appId) {
  let verdict = null;
  for (const line of String(ndjson || "").split("\n")) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line).eventMessage;
    } catch {
      continue;
    }
    if (typeof message !== "string" || !message.includes("Presenting")) continue;
    if (!message.includes(`app:"${appId}"`)) continue;
    const m = /> as (\w+)/.exec(message);
    if (m) verdict = VERDICTS.includes(m[1]) ? m[1] : "unknown";
  }
  return verdict;
}

/**
 * What the verdict means for the person. `banner` and `alert` are the two
 * shapes macOS shows on screen; `none` means it accepted the notification and
 * displayed nothing, which is what both "Allow Notifications" off and alert
 * style "None" look like from out here — the same sentence and the same fix
 * covers both, so we do not guess between them.
 */
function statusFor(verdict) {
  if (verdict === "banner" || verdict === "alert") return "showing";
  if (verdict === "none") return "silenced";
  return "unknown";
}

/** The System Settings pane for one app's notifications. */
function settingsUrl(appId) {
  return `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${appId}`;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout) =>
      resolve(err && !stdout ? null : stdout),
    );
  });
}

/**
 * Read the verdict for notifications posted in the last `seconds`. Never
 * throws and never blocks a caller for long: no answer is "unknown", which the
 * UI states as not knowing rather than as good news.
 */
async function readVerdict(appId, { seconds = 30, timeoutMs = 12_000, exec = run } = {}) {
  const out = await exec(
    "/usr/bin/log",
    ["show", "--last", `${seconds}s`, "--style", "ndjson", "--predicate",
     `process == "usernoted" AND eventMessage CONTAINS "Presenting"`],
    timeoutMs,
  );
  return out === null ? null : parseVerdict(out, appId);
}

module.exports = { parseVerdict, statusFor, settingsUrl, readVerdict, VERDICTS };

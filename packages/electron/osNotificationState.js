// macOS per-app notification consent. Electron has no API for "are my
// notifications actually allowed?" — a denied app's Notification.show() just
// silently does nothing — so the only readable source is Notification
// Center's own preference store: ~/Library/Preferences/com.apple.ncprefs.plist,
// an array of { "bundle-id", flags, ... } dicts. Bit 25 of `flags` is set for
// every app the user allowed and clear for denied ones; an app with NO entry
// was never registered at all (macOS registers it, and shows the Allow/Don't
// Allow prompt, the first time it posts a notification).
//
// Verified empirically on macOS 26 (Darwin 25): allowed apps (Chrome, Slack,
// Notion) all carry 0x2000000; denied/unanswered ones (Zoom, Discord, Signal)
// all lack it. `flags` can exceed 32 bits (0x23088200e observed) — JS bitwise
// ops truncate to 32, which leaves bit 25 intact.

const { execFile } = require("child_process");
const os = require("os");
const path = require("path");

const ALLOWED_FLAG = 1 << 25;

// States:
//   granted — the user allowed notifications
//   off     — an entry exists without the allowed bit: denied, or the OS
//             prompt is still sitting unanswered
//   ask     — no entry: macOS never prompted; posting one notification will
//             raise the Allow/Don't Allow prompt
//   unknown — the plist couldn't be read (never nag on unknown)
function parseNotificationState(xml, bundleId) {
  // Chunk per app dict: keys are alphabetical, so everything between one
  // bundle-id and the next belongs to that app. A lazy cross-dict regex could
  // steal the NEXT dict's flags when an entry has none.
  const chunks = xml.split("<key>bundle-id</key>");
  for (let i = 1; i < chunks.length; i++) {
    const id = chunks[i].match(/^\s*<string>([^<]*)<\/string>/);
    if (!id || id[1] !== bundleId) continue;
    const flags = chunks[i].match(/<key>flags<\/key>\s*<integer>(-?\d+)<\/integer>/);
    if (!flags) return "ask";
    return parseInt(flags[1], 10) & ALLOWED_FLAG ? "granted" : "off";
  }
  return "ask";
}

function getOsNotificationState(bundleId) {
  if (process.platform !== "darwin") return Promise.resolve("granted");
  return new Promise((resolve) => {
    execFile(
      "plutil",
      ["-convert", "xml1", "-o", "-", path.join(os.homedir(), "Library/Preferences/com.apple.ncprefs.plist")],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve("unknown");
        try {
          resolve(parseNotificationState(String(stdout), bundleId));
        } catch {
          resolve("unknown");
        }
      },
    );
  });
}

// Deep link into System Settings → Notifications → this app (Ventura+ URL;
// older versions fall back to the pane root, which still lands close enough).
function notificationSettingsUrl(bundleId) {
  return `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${bundleId}`;
}

module.exports = { parseNotificationState, getOsNotificationState, notificationSettingsUrl, ALLOWED_FLAG };

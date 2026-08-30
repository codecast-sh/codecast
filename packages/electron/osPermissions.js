// OS-level permissions the desktop app depends on, read from the OS itself.
//
// Four kinds: notifications, microphone, camera, screen. Each resolves to one
// readiness value, shared with the web layer (lib/osPermissions.ts):
//   granted — the user allowed it
//   ask     — undecided; one gesture (`request`) raises the OS prompt
//   off     — denied, or turned off later; only System Settings can flip it
//   unknown — couldn't tell (not macOS, plist unreadable): never nag on it
//
// Microphone, camera and screen come from Electron's systemPreferences, which
// reads the TCC database. Notifications have no Electron API at all — a
// denied app's Notification.show() just silently does nothing — so the only
// readable source is Notification Center's own preference store,
// ~/Library/Preferences/com.apple.ncprefs.plist: an array of
// { "bundle-id", flags, ... } dicts where bit 25 of `flags` is set for every
// allowed app and clear for denied ones, and an app with NO entry was never
// registered (macOS registers it, and shows Allow/Don't Allow, the first time
// it posts a notification). Verified empirically on macOS 26 (Darwin 25):
// allowed apps (Chrome, Slack, Notion) all carry 0x2000000; denied/unanswered
// ones (Zoom, Discord, Signal) all lack it. `flags` can exceed 32 bits
// (0x23088200e observed) — JS bitwise ops truncate to 32, which leaves bit 25
// intact.

const { execFile } = require("child_process");
const os = require("os");
const path = require("path");

const KINDS = ["notifications", "microphone", "camera", "screen"];
const NOTIFICATIONS_ALLOWED_FLAG = 1 << 25;

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
    return parseInt(flags[1], 10) & NOTIFICATIONS_ALLOWED_FLAG ? "granted" : "off";
  }
  return "ask";
}

function readNotificationState(bundleId) {
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

// systemPreferences.getMediaAccessStatus vocabulary → readiness.
function mediaStatusToReadiness(status) {
  switch (status) {
    case "granted": return "granted";
    case "not-determined": return "ask";
    case "denied":
    case "restricted": return "off";
    default: return "unknown";
  }
}

// System Settings panes, one per kind. The notifications URL is the
// Ventura+ form that lands on this app's row; the privacy ones open the
// Privacy & Security list at the right category.
function settingsUrl(kind, bundleId) {
  switch (kind) {
    case "notifications":
      return `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${bundleId}`;
    case "microphone":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
    case "camera":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera";
    case "screen":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    default:
      return null;
  }
}

// `electron` is injected so the pure parts stay testable under plain node.
function createOsPermissions({ electron, bundleId, showNotification }) {
  const { systemPreferences, desktopCapturer, shell } = electron;
  const mac = process.platform === "darwin";

  async function getAll() {
    if (!mac) {
      // Windows/Linux: nothing gates media or banners at the OS level in a
      // way we can read, and the web layer's own permission model covers the
      // rest. Report granted so nothing nags.
      return Object.fromEntries(KINDS.map((k) => [k, "granted"]));
    }
    const media = (k) => {
      try {
        return mediaStatusToReadiness(systemPreferences.getMediaAccessStatus(k));
      } catch {
        return "unknown";
      }
    };
    return {
      notifications: await readNotificationState(bundleId),
      microphone: media("microphone"),
      camera: media("camera"),
      screen: media("screen"),
    };
  }

  // The one gesture per kind that makes the OS ask. Resolves the readiness
  // AFTER the gesture where the OS answers synchronously (mic/camera), else
  // the pre-gesture state — the caller re-polls.
  async function request(kind) {
    if (!mac) return "granted";
    switch (kind) {
      case "notifications":
        // Posting a real notification is what registers the app with
        // Notification Center and raises Allow/Don't Allow. Not gated on
        // focus: the user just clicked "Turn on".
        showNotification("Notifications are on", "Codecast will notify you when someone messages or a session needs you.");
        return "ask";
      case "microphone":
      case "camera": {
        try {
          const ok = await systemPreferences.askForMediaAccess(kind);
          return ok ? "granted" : "off";
        } catch {
          return "unknown";
        }
      }
      case "screen": {
        // No prompt API exists for screen recording. A capture attempt is
        // what makes macOS list the app under Screen & System Audio
        // Recording (and, on recent versions, show its own "open System
        // Settings" dialog); then send them to the pane.
        try {
          await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
        } catch {}
        shell.openExternal(settingsUrl("screen", bundleId));
        return "ask";
      }
      default:
        return "unknown";
    }
  }

  function openSettings(kind) {
    const url = settingsUrl(kind, bundleId);
    if (url) shell.openExternal(url);
  }

  return { getAll, request, openSettings };
}

module.exports = {
  KINDS,
  NOTIFICATIONS_ALLOWED_FLAG,
  parseNotificationState,
  mediaStatusToReadiness,
  settingsUrl,
  createOsPermissions,
};

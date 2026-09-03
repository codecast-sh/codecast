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
// denied app's Notification.show() just silently does nothing — so the shell
// asks UNUserNotificationCenter through a native addon
// (native/notifications.mm, built by scripts/build-native.sh). There is no
// file to read instead: Notification Center's store needs Full Disk Access,
// and the ncprefs.plist mirror it used to keep froze on macOS 26, so an app
// installed since has no entry there and an allowed app read as never asked.
// The API answers only the bundle's main executable, hence an addon in the
// main process rather than a helper binary.

const KINDS = ["notifications", "microphone", "camera", "screen"];

// UNAuthorizationStatus → readiness. -1 is the addon's "no answer" (outside
// an app bundle, or Notification Center didn't reply in time).
function authorizationStatusToReadiness(status) {
  switch (status) {
    case 0: return "ask"; // notDetermined
    case 1: return "off"; // denied
    case 2: // authorized
    case 3: // provisional
    case 4: return "granted"; // ephemeral
    default: return "unknown";
  }
}

// A missing binary (a non-mac host, a build that skipped it) reads as
// unknown — never nag on unknown — rather than a boot crash.
function loadNotificationsAddon() {
  try {
    return require("./native/notifications.node");
  } catch {
    return null;
  }
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

// `electron` and the notifications addon are injected so the pure parts
// stay testable under plain node.
function createOsPermissions({ electron, bundleId, notifications = loadNotificationsAddon() }) {
  const { systemPreferences, desktopCapturer, shell } = electron;
  const mac = process.platform === "darwin";

  function readNotificationState() {
    if (!notifications) return "unknown";
    try {
      return authorizationStatusToReadiness(notifications.authorizationStatus());
    } catch {
      return "unknown";
    }
  }

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
      notifications: readNotificationState(),
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
        // Raises Allow / Don't Allow (a no-op once decided); the answer
        // lands in Notification Center, so the caller re-polls for it.
        if (notifications) {
          try {
            notifications.requestAuthorization();
          } catch {}
        }
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

  // Deliver a notification through the modern API. Once this process has
  // read its permission above, macOS drops everything Electron's legacy
  // `Notification` sends, silently — so this is the only path that reaches
  // the human. Returns false when the addon cannot post (not macOS, no
  // binary, outside a bundle); the caller falls back to the legacy class,
  // which still works in a process that never touched the modern API.
  const clickHandlers = new Map();
  let activateWired = false;
  function notify(title, body, onClick) {
    if (!mac || !notifications || typeof notifications.post !== "function") return false;
    try {
      if (!activateWired && typeof notifications.onActivate === "function") {
        notifications.onActivate((id) => {
          const handler = clickHandlers.get(id);
          clickHandlers.delete(id);
          if (handler) {
            try { handler(); } catch {}
          }
        });
        activateWired = true;
      }
      // Never asked: raise the prompt, then post anyway (the answer lands in
      // Notification Center, and a later notification benefits).
      if (readNotificationState() === "ask") {
        try { notifications.requestAuthorization(); } catch {}
      }
      const id = notifications.post(String(title), String(body));
      if (!id) return false;
      if (onClick) clickHandlers.set(id, onClick);
      return true;
    } catch {
      return false;
    }
  }

  return { getAll, request, openSettings, notify };
}

module.exports = {
  KINDS,
  authorizationStatusToReadiness,
  mediaStatusToReadiness,
  settingsUrl,
  createOsPermissions,
};

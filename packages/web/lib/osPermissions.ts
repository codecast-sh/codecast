// The OS-level permissions Codecast depends on, as one registry.
//
// "OS-level" means the thing System Settings or the browser's site permission
// decides — not the in-app preference switches. With one of these off, the
// feature that needs it fails silently (a banner that never shows, a
// microphone that opens to nothing), so the app has to know the true state
// and own the fix.
//
// Every surface answers with one vocabulary, PermissionReadiness:
//   granted — the OS will allow it
//   ask     — undecided; one gesture (`requestOsPermission`) raises the OS
//             prompt
//   off     — denied; only a settings screen fixes it (System Settings on
//             the desktop, site settings in a browser)
//   unknown — can't tell (SSR, an old desktop shell, a browser with no
//             Permissions API): never nag on unknown
//   n/a     — this surface has no persistent grant for it (a browser's
//             screen share asks per use): nothing to set up
//
// The desktop shell reads the OS (packages/electron/osPermissions.js); a
// browser reads its own permission model. The registry, the store/hook
// (hooks/useOsPermissions.ts), the row (components/permissions/PermissionRow)
// and the first-run dialog are the only places that know the difference.

import { bridge, isElectron } from "./desktop";

// What the app itself asks macOS for. One cheap read each, so they share one
// map and one poll.
export type AppPermissionKind = "notifications" | "microphone" | "camera" | "screen";
// The two grants that belong to `codecast computer`, the small signed helper an
// agent drives other Mac apps through. Read separately, and only while a
// surface is showing them: each read launches that helper and can take seconds.
export type ComputerPermissionKind = "computerAccessibility" | "computerScreen";
export type OsPermissionKind = AppPermissionKind | ComputerPermissionKind;
export type PermissionReadiness = "granted" | "ask" | "off" | "unknown" | "n/a";
export type PermissionMap = Record<AppPermissionKind, PermissionReadiness>;
export type ComputerPermissionMap = Record<ComputerPermissionKind, PermissionReadiness>;

export const OS_PERMISSION_KINDS: AppPermissionKind[] = ["notifications", "microphone", "camera", "screen"];
export const COMPUTER_PERMISSION_KINDS: ComputerPermissionKind[] = ["computerAccessibility", "computerScreen"];

export type OsPermissionInfo = {
  kind: OsPermissionKind;
  label: string;
  // What breaks without it, in the user's terms — the sentence under the
  // label in every surface that lists permissions.
  why: string;
  // The device-setup flow treats required kinds as the ones worth opening
  // the dialog for; optional ones are listed but never gate "all set".
  required: boolean;
  // What to say when the grant is not on, for a kind the generic sentence
  // would describe wrongly — a grant Codecast does not hold itself.
  offHint?: string;
};

export const OS_PERMISSIONS: Record<OsPermissionKind, OsPermissionInfo> = {
  notifications: {
    kind: "notifications",
    label: "Notifications",
    why: "Messages from your team and sessions waiting on you, when Codecast is in the background.",
    required: true,
  },
  microphone: {
    kind: "microphone",
    label: "Microphone",
    why: "Huddles, push-to-talk, and recording a meeting.",
    required: true,
  },
  camera: {
    kind: "camera",
    label: "Camera",
    why: "Video in huddles. Voice-only works without it.",
    required: false,
  },
  screen: {
    kind: "screen",
    label: "Screen recording",
    why: "Sharing your screen in a huddle, and hearing the computer's audio when recording a meeting.",
    required: false,
  },
  computerAccessibility: {
    kind: "computerAccessibility",
    label: "Computer control",
    why: "Lets an agent work in the other apps on this Mac for you: reading what a window shows and clicking in it. macOS calls this Accessibility. You grant it to a separate small app named codecast computer, so Codecast itself never holds it.",
    required: false,
    offHint: "codecast computer is not turned on in the Accessibility list yet.",
  },
  computerScreen: {
    kind: "computerScreen",
    label: "Computer screenshots",
    why: "Lets an agent see a picture of the window it is working in, which is how it checks that an action landed. macOS calls this Screen Recording, and it goes to the same codecast computer app, not to Codecast.",
    required: false,
    offHint: "codecast computer is not turned on in the Screen Recording list yet.",
  },
};

export const UNKNOWN_PERMISSIONS: PermissionMap = {
  notifications: "unknown",
  microphone: "unknown",
  camera: "unknown",
  screen: "unknown",
};

function asReadiness(v: unknown): PermissionReadiness {
  return v === "granted" || v === "ask" || v === "off" || v === "n/a" ? v : "unknown";
}

// Browser Permissions API state → readiness. Absent/throwing (Safari for
// media kinds, Firefox for some) → unknown.
export function browserPermissionToReadiness(state: PermissionState | undefined): PermissionReadiness {
  if (state === "granted") return "granted";
  if (state === "denied") return "off";
  if (state === "prompt") return "ask";
  return "unknown";
}

async function queryBrowserPermission(name: string): Promise<PermissionReadiness> {
  try {
    const status = await navigator.permissions.query({ name: name as PermissionName });
    return browserPermissionToReadiness(status.state);
  } catch {
    return "unknown";
  }
}

export async function getOsPermissions(): Promise<PermissionMap> {
  if (isElectron()) {
    const fn = bridge("getOsPermissions");
    if (!fn) return UNKNOWN_PERMISSIONS;
    try {
      const raw = (await fn()) as Partial<Record<OsPermissionKind, unknown>> | null;
      return {
        notifications: asReadiness(raw?.notifications),
        microphone: asReadiness(raw?.microphone),
        camera: asReadiness(raw?.camera),
        screen: asReadiness(raw?.screen),
      };
    } catch {
      return UNKNOWN_PERMISSIONS;
    }
  }
  const notifications: PermissionReadiness =
    typeof Notification === "undefined"
      ? "unknown"
      : Notification.permission === "granted"
        ? "granted"
        : Notification.permission === "denied"
          ? "off"
          : "ask";
  const [microphone, camera] = await Promise.all([
    queryBrowserPermission("microphone"),
    queryBrowserPermission("camera"),
  ]);
  return { notifications, microphone, camera, screen: "n/a" };
}

// The one gesture per (surface, kind, state). Resolves what happened so the
// caller can re-poll or show follow-up copy:
//   granted         — consent landed on the spot
//   requested       — the OS/browser is showing its own prompt; poll for it
//   opened-settings — a settings screen was opened; poll on refocus
//   unsupported     — nothing programmatic exists (a browser's "off"): show
//                     the manual hint instead
export type RequestOutcome = "granted" | "requested" | "opened-settings" | "unsupported";

export async function requestOsPermission(
  kind: OsPermissionKind,
  readiness: PermissionReadiness,
): Promise<RequestOutcome> {
  if (isElectron()) {
    if (readiness === "off") {
      const open = bridge("openOsPermissionSettings");
      if (!open) return "unsupported";
      await open(kind);
      return "opened-settings";
    }
    const request = bridge("requestOsPermission");
    if (!request) return "unsupported";
    const after = asReadiness(await request(kind));
    return after === "granted" ? "granted" : "requested";
  }
  if (readiness !== "ask") return "unsupported";
  if (kind === "notifications") {
    if (typeof Notification === "undefined") return "unsupported";
    const result = await Notification.requestPermission();
    return result === "granted" ? "granted" : "requested";
  }
  if (kind === "microphone" || kind === "camera") {
    // Opening the device is the browser's prompt. Release it at once — this
    // is consent, not capture.
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        kind === "microphone" ? { audio: true } : { video: true },
      );
      for (const t of stream.getTracks()) t.stop();
      return "granted";
    } catch {
      return "requested";
    }
  }
  return "unsupported";
}

// Is there a button worth drawing? A browser's "off" has no programmatic
// path, so the row shows the manual hint and no button.
export function isPermissionActionable(readiness: PermissionReadiness): boolean {
  return readiness === "ask" || (readiness === "off" && isElectron());
}

export function permissionActionLabel(readiness: PermissionReadiness): string | null {
  if (!isPermissionActionable(readiness)) return null;
  return readiness === "off" ? "Open System Settings" : "Turn on";
}

// The sentence for a state that is not granted — used as the row's status
// text and as the remedy in a media-failure notice.
export function permissionHint(kind: OsPermissionKind, readiness: PermissionReadiness): string | null {
  const info = OS_PERMISSIONS[kind];
  const label = info.label;
  // "Notifications are", "Microphone is".
  const plural = kind === "notifications";
  const are = plural ? "are" : "is";
  const them = plural ? "them" : "it";
  if (readiness === "off") {
    if (info.offHint) return info.offHint;
    return isElectron()
      ? `${label} ${are} turned off for Codecast in System Settings.`
      : `${label} ${are} blocked for this site — allow ${them} in the site settings (the icon next to the address bar).`;
  }
  if (readiness === "ask") return `${label} ${plural ? "haven't" : "hasn't"} been allowed on this device yet.`;
  return null;
}

// ---------------------------------------------------------------------------
// Shared live store. One answer for the whole app (the nudge banner, the
// setup dialog, settings rows, the call error notice) and one poll loop: on
// the desktop each read is a plutil exec, so N consumers must not mean N
// reads. hooks/useOsPermissions.ts is the React view of this.
//
// There is no change event for OS-level consent, so the store re-checks at
// the moments the answer can have flipped: window refocus (the user came back
// from System Settings or the browser's site-settings sheet), the browser
// Permissions API change event where it exists, and a slow poll while
// anything is still actionable (the macOS Allow dialog is answered without
// the app ever losing focus).
// ---------------------------------------------------------------------------

let current: PermissionMap = UNKNOWN_PERMISSIONS;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
let installed = false;
let pollId: number | null = null;

export function refreshOsPermissions(): Promise<void> {
  if (inflight) return inflight;
  inflight = getOsPermissions()
    .then((next) => {
      if (OS_PERMISSION_KINDS.some((k) => next[k] !== current[k])) {
        current = next;
        for (const l of listeners) l();
      }
    })
    .finally(() => {
      inflight = null;
      schedulePoll();
    });
  return inflight;
}

function schedulePoll() {
  if (pollId != null) window.clearTimeout(pollId);
  pollId = null;
  if (listeners.size === 0 || !OS_PERMISSION_KINDS.some((k) => isPermissionActionable(current[k]))) return;
  pollId = window.setTimeout(() => refreshOsPermissions(), 30_000);
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("focus", () => {
    refreshOsPermissions();
    // Coming back from System Settings is the whole reason this read exists,
    // and it costs a helper launch — so it runs only while a surface is
    // showing those two rows.
    if (computerListeners.size > 0) refreshComputerPermissions();
  });
  if (!isElectron() && navigator.permissions?.query) {
    for (const name of ["notifications", "microphone", "camera"]) {
      navigator.permissions
        .query({ name: name as PermissionName })
        .then((status) => status.addEventListener("change", () => refreshOsPermissions()))
        .catch(() => {});
    }
  }
}

export function subscribeOsPermissions(cb: () => void): () => void {
  listeners.add(cb);
  install();
  if (listeners.size === 1) refreshOsPermissions();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) schedulePoll();
  };
}

// The last known map, for non-React callers (callManager, the recorder).
export function peekOsPermissions(): PermissionMap {
  return current;
}

// ---------------------------------------------------------------------------
// The codecast computer grants, as their own small store.
//
// Same vocabulary, same rows, different economics: one read spawns the CLI,
// which launches the helper and waits on macOS, and that takes seconds. So it
// never joins the map above — nothing reads these at boot, nothing polls them
// on a timer, and a consumer that shows the rows is what makes a read happen
// (on mount, and on every return to the window after that).
// ---------------------------------------------------------------------------

export const UNKNOWN_COMPUTER_PERMISSIONS: ComputerPermissionMap = {
  computerAccessibility: "unknown",
  computerScreen: "unknown",
};

export async function getComputerPermissions(): Promise<ComputerPermissionMap> {
  // Only the desktop shell can reach the helper; a browser tab has no grant of
  // this kind to show at all.
  if (!isElectron()) return { computerAccessibility: "n/a", computerScreen: "n/a" };
  const fn = bridge("getComputerPermissions");
  if (!fn) return UNKNOWN_COMPUTER_PERMISSIONS;
  try {
    const raw = (await fn()) as Partial<Record<ComputerPermissionKind, unknown>> | null;
    return {
      computerAccessibility: asReadiness(raw?.computerAccessibility),
      computerScreen: asReadiness(raw?.computerScreen),
    };
  } catch {
    return UNKNOWN_COMPUTER_PERMISSIONS;
  }
}

let computerCurrent: ComputerPermissionMap = UNKNOWN_COMPUTER_PERMISSIONS;
let computerInflight: Promise<void> | null = null;
const computerListeners = new Set<() => void>();

export function refreshComputerPermissions(): Promise<void> {
  if (computerInflight) return computerInflight;
  computerInflight = getComputerPermissions()
    .then((next) => {
      if (COMPUTER_PERMISSION_KINDS.some((k) => next[k] !== computerCurrent[k])) {
        computerCurrent = next;
        for (const l of computerListeners) l();
      }
    })
    .finally(() => {
      computerInflight = null;
    });
  return computerInflight;
}

export function subscribeComputerPermissions(cb: () => void): () => void {
  computerListeners.add(cb);
  install();
  return () => {
    computerListeners.delete(cb);
  };
}

export function peekComputerPermissions(): ComputerPermissionMap {
  return computerCurrent;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __CODECAST_ELECTRON__?: {
      getVersion: () => Promise<string>;
      setBadgeCount: (count: number) => Promise<void>;
      onDeepLink: (cb: (url: string) => void) => void;
      onUpdateStatus: (cb: (status: { status: string; version?: string; percent?: number }) => void) => void;
      restartForUpdate: () => Promise<void>;
      showNotification: (title: string, body: string, data?: { conversationId?: string }) => Promise<void>;
      getShortcuts: () => Promise<Record<string, string>>;
      setShortcut: (key: string, accelerator: string) => Promise<Record<string, string>>;
      paletteNavigate: (path: string) => void;
      paletteHide: () => void;
      onPaletteShow: (cb: () => void) => () => void;
      platform: string;
    };
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.__CODECAST_ELECTRON__;
}

export function isDesktop(): boolean {
  return isTauri() || isElectron();
}

export function hasBrowserNotificationPermission(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (isDesktop()) return true;
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export async function notifyNative(title: string, body: string, data?: { conversationId?: string }) {
  if (isTauri()) {
    if (document.hasFocus()) return;
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title, body });
  } else if (isElectron()) {
    // Electron renderer's web Notification API doesn't produce system notifications.
    // Must use IPC to the main process which has access to the native Notification module.
    window.__CODECAST_ELECTRON__!.showNotification(title, body, data);
  } else if (hasBrowserNotificationPermission()) {
    if (document.hasFocus()) return;
    const n = new Notification(title, { body, icon: "/icon-192.png", tag: data?.conversationId });
    if (data?.conversationId) {
      n.onclick = () => {
        window.focus();
        window.location.href = `/conversation/${data.conversationId}`;
      };
    }
  }
}

export async function updateBadge(count: number) {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    invoke("set_badge_count", { count });
  } else if (isElectron()) {
    window.__CODECAST_ELECTRON__!.setBadgeCount(count);
  }
}

export async function onDeepLink(cb: (urls: string[]) => void) {
  if (isTauri()) {
    const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
    onOpenUrl(cb);
  } else if (isElectron()) {
    window.__CODECAST_ELECTRON__!.onDeepLink((url) => cb([url]));
  }
}

export async function checkForUpdates() {
  if (isTauri()) {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update) {
      await update.downloadAndInstall();
    }
  }
  // Electron auto-update is handled in main process -- see main.js
}

export function onUpdateStatus(cb: (status: { status: string; version?: string; percent?: number }) => void) {
  if (isElectron()) {
    window.__CODECAST_ELECTRON__!.onUpdateStatus(cb);
  }
}

export function restartForUpdate() {
  if (isElectron()) {
    window.__CODECAST_ELECTRON__!.restartForUpdate();
  }
}

export function desktopHeaderClass(): string {
  if (typeof window === "undefined") return "";
  if (isTauri()) return "tauri-drag-region pl-[78px]";
  if (isElectron()) return "electron-drag-region pl-[78px]";
  return "";
}

const INTERACTIVE_TAGS = new Set(["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT"]);

export function setupDesktopDrag(el: HTMLElement): (() => void) | undefined {
  if (!isTauri()) return;
  // Electron uses CSS -webkit-app-region: drag natively, no JS needed
  // Tauri needs manual IPC call
  const handleMouseDown = (e: MouseEvent) => {
    let node = e.target as HTMLElement | null;
    while (node && node !== el) {
      if (INTERACTIVE_TAGS.has(node.tagName) || node.getAttribute("role") === "button" || node.isContentEditable) return;
      node = node.parentElement;
    }
    (window as any).__TAURI_INTERNALS__?.invoke("start_window_drag").catch(() => {});
  };
  el.addEventListener("mousedown", handleMouseDown);
  return () => el.removeEventListener("mousedown", handleMouseDown);
}

export function useIsDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return isDesktop();
}

export async function getAppVersion(): Promise<string | null> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("get_app_version");
  }
  if (isElectron()) {
    return window.__CODECAST_ELECTRON__!.getVersion();
  }
  return null;
}

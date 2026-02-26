declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __CODECAST_ELECTRON__?: {
      getVersion: () => Promise<string>;
      setBadgeCount: (count: number) => Promise<void>;
      onDeepLink: (cb: (url: string) => void) => void;
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

export async function notifyNative(title: string, body: string) {
  if (isTauri()) {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title, body });
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

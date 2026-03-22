declare global {
  interface Window {
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
      paletteStartSession: (data: { message: string; agentType: string; projectPath?: string }) => void;
      onPaletteShow: (cb: () => void) => () => void;
      onComposeShow: (cb: () => void) => () => void;
      platform: string;
    };
  }
}

export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.__CODECAST_ELECTRON__;
}

export function isDesktop(): boolean {
  return isElectron();
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
  if (isElectron()) {
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
  if (isElectron()) {
    window.__CODECAST_ELECTRON__!.setBadgeCount(count);
  }
}

export async function onDeepLink(cb: (urls: string[]) => void) {
  if (isElectron()) {
    window.__CODECAST_ELECTRON__!.onDeepLink((url) => cb([url]));
  }
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
  if (isElectron()) return "electron-drag-region pl-[78px]";
  return "";
}

export function useIsDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return isDesktop();
}

export function setupDesktopDrag(_el: HTMLElement): (() => void) | undefined {
  return;
}

export async function checkForUpdates() {
  // Electron auto-update is handled in main process
}

export async function getAppVersion(): Promise<string | null> {
  if (isElectron()) {
    return window.__CODECAST_ELECTRON__!.getVersion();
  }
  return null;
}

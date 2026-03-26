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
      paletteNavigateSession: (data: Record<string, unknown>) => void;
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

function bridge<K extends keyof NonNullable<Window["__CODECAST_ELECTRON__"]>>(
  method: K,
): NonNullable<Window["__CODECAST_ELECTRON__"]>[K] | undefined {
  const b = window.__CODECAST_ELECTRON__;
  const fn = b?.[method];
  return typeof fn === "function" ? fn.bind(b) as any : undefined;
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
    bridge("showNotification")?.(title, body, data);
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
    bridge("setBadgeCount")?.(count);
  }
}

export async function onDeepLink(cb: (urls: string[]) => void) {
  if (isElectron()) {
    bridge("onDeepLink")?.((url: string) => cb([url]));
  }
}

export function onUpdateStatus(cb: (status: { status: string; version?: string; percent?: number }) => void) {
  if (isElectron()) {
    bridge("onUpdateStatus")?.(cb);
  }
}

export function restartForUpdate() {
  if (isElectron()) {
    bridge("restartForUpdate")?.();
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
    return bridge("getVersion")?.() ?? null;
  }
  return null;
}

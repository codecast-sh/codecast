declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

export async function notifyNative(title: string, body: string) {
  if (!isDesktop()) return;
  const { sendNotification } = await import("@tauri-apps/plugin-notification");
  sendNotification({ title, body });
}

export async function updateBadge(count: number) {
  if (!isDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  invoke("set_badge_count", { count });
}

export async function onDeepLink(cb: (urls: string[]) => void) {
  if (!isDesktop()) return;
  const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  onOpenUrl(cb);
}

export async function checkForUpdates() {
  if (!isDesktop()) return;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (update) {
    await update.downloadAndInstall();
  }
}

let _isDesktopCached: boolean | null = null;

export function desktopHeaderClass(): string {
  if (_isDesktopCached === null && typeof window !== "undefined") {
    _isDesktopCached = isDesktop();
  }
  return _isDesktopCached ? "tauri-drag-region pl-[78px]" : "";
}

export async function getAppVersion(): Promise<string | null> {
  if (!isDesktop()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("get_app_version");
}

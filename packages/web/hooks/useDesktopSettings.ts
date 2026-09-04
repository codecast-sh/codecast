import { useInboxStore } from "../store/inboxStore";
import { getDesktopShortcutConfig, isElectron, type DesktopShortcutConfig } from "../lib/desktop";
import { useMountEffect } from "./useMountEffect";

export async function refreshDesktopSettings() {
  const value = await getDesktopShortcutConfig();
  if (value) useInboxStore.getState().syncTable("settingsData", [{ _id: "desktop:shortcuts", value }]);
}

export function useDesktopSettings() {
  const config = useInboxStore((s) => s.settingsData["desktop:shortcuts"]?.value) as DesktopShortcutConfig | undefined;
  useMountEffect(() => {
    if (isElectron()) void refreshDesktopSettings();
  });
  return config;
}

import { useInboxStore } from "../../store/inboxStore";

/** A tab's title for /m/<mod>/<pane>: the pane's title from the mod's manifest, else the mod's. */
export function modTabLabel(path: string): string {
  const [, , name, pane] = path.split("?")[0].split("/");
  const mods = ((useInboxStore.getState() as any).mods ?? {}) as Record<string, any>;
  const row = Object.values(mods).find((r: any) => r?.name === name);
  const paneTitle = row?.manifest?.panes?.find((p: any) => p.id === (pane || row?.manifest?.panes?.[0]?.id))?.title;
  return paneTitle ?? row?.title ?? name ?? "Mod";
}

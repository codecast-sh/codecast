// The store is read through its window handle (store/inboxStore.ts exposes it in
// every build), not imported: pathLabel is on the store's own import graph.

/** A tab's title for /m/<mod>/<pane>: the pane's title from the mod's manifest, else the mod's. */
export function modTabLabel(path: string): string {
  const [, , name, pane] = path.split("?")[0].split("/");
  const mods = ((globalThis as any).__inboxStore?.getState?.().mods ?? {}) as Record<string, any>;
  const row = Object.values(mods).find((r: any) => r?.name === name);
  const paneTitle = row?.manifest?.panes?.find((p: any) => p.id === (pane || row?.manifest?.panes?.[0]?.id))?.title;
  return paneTitle ?? row?.title ?? name ?? "Mod";
}

/** A tab's title for /objects/<prefix> (the kind's plural) or /o/<short id> (the object's title). */
export function objectTabLabel(path: string): string {
  const [, area, ref = ""] = path.split("?")[0].split("/");
  const st = (globalThis as any).__inboxStore?.getState?.();
  const prefix = area === "objects" ? ref : ref.split("-")[0];
  let kind: any;
  for (const row of Object.values((st?.mods ?? {}) as Record<string, any>)) {
    kind ??= row?.manifest?.objects?.find((k: any) => k.prefix === prefix);
  }
  if (area === "objects") return kind?.plural ?? (kind ? `${kind.title}s` : ref);
  const obj = Object.values((st?.modObjects ?? {}) as Record<string, any>).find((o: any) => o?.short_id === ref.toLowerCase());
  return obj?.title ?? ref;
}

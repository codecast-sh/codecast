// The object kinds mods declare (shared/contracts/mods.ts ModObjectKind), as
// the web reads them: which prefixes are kinds, the kind behind a short id,
// and the object row a short id names. Kinds come from every mod row the
// viewer can see, enabled or not, so `bug-14` stays a pill even while the mod
// that draws bugs is off. The store is read through its window handle, not
// imported, so the markdown pipeline (which the store's own graph reaches) can
// call this without a cycle.

import { OBJECT_REF_SCAN_SOURCE, OBJECT_SHORT_ID_RE, type ModObjectKind } from "@codecast/shared/contracts/mods";
import { activeWorkspaceKeyOf } from "../workspaceScope";

type KindEntry = ModObjectKind & { mod: string; modTitle?: string };

function state(): any {
  return (globalThis as any).__inboxStore?.getState?.() ?? null;
}

let cacheRef: unknown = null;
let cacheKinds = new Map<string, KindEntry>();

/** Every declared kind by prefix. Recomputed only when the mods collection changes. */
export function objectKinds(): Map<string, KindEntry> {
  const mods = state()?.mods;
  if (mods === cacheRef) return cacheKinds;
  cacheRef = mods;
  const next = new Map<string, KindEntry>();
  for (const row of Object.values((mods ?? {}) as Record<string, any>)) {
    for (const k of (row?.manifest?.objects ?? []) as ModObjectKind[]) {
      if (!next.has(k.prefix)) next.set(k.prefix, { ...k, mod: row.name, modTitle: row.title });
    }
  }
  cacheKinds = next;
  return next;
}

export function objectKind(prefix: string | undefined): KindEntry | undefined {
  return prefix ? objectKinds().get(prefix) : undefined;
}

/** True when `text` is `<prefix>-<n>` for a declared kind. */
export function isObjectRef(text: string): boolean {
  const m = OBJECT_SHORT_ID_RE.exec((text || "").toLowerCase());
  return !!m && objectKinds().has(m[1]);
}

export function objectRefScanRegex(): RegExp {
  return new RegExp(OBJECT_REF_SCAN_SOURCE, "gi");
}

let indexRef: unknown = null;
let index = new Map<string, any[]>();

/**
 * The object row a short id names, from the store. A short id counts per
 * workspace, so `bug-1` can exist in several: the active workspace's wins,
 * then the newest. Indexed once per collection ref.
 */
export function objectByShortId(collection: Record<string, any> | undefined, shortId: string): any | undefined {
  if (collection !== indexRef) {
    indexRef = collection;
    index = new Map();
    for (const row of Object.values(collection ?? {})) {
      if (!row?.short_id || row.archived) continue;
      const list = index.get(row.short_id) ?? [];
      list.push(row);
      index.set(row.short_id, list);
    }
  }
  const rows = index.get(shortId.toLowerCase());
  if (!rows?.length) return undefined;
  const st = state();
  const active = st ? activeWorkspaceKeyOf(st) : null;
  return rows.find((r) => r.workspace === active) ?? rows.reduce((a, b) => ((b.updated_at ?? 0) > (a.updated_at ?? 0) ? b : a));
}

export function objectHref(shortId: string): string {
  return `/o/${shortId.toLowerCase()}`;
}

export function objectsHref(prefix: string): string {
  return `/objects/${prefix}`;
}

/** A status's color: the lifecycle's last status is done (green), the rest take accents in order. */
const STATUS_TONES = ["var(--sol-blue)", "var(--sol-yellow)", "var(--sol-violet)", "var(--sol-orange)", "var(--sol-cyan)", "var(--sol-magenta)"];

export function statusTone(kind: Pick<ModObjectKind, "statuses">, status: string | undefined): string {
  const list = kind.statuses ?? [];
  const i = status ? list.indexOf(status) : -1;
  if (i < 0) return "var(--sol-text-dim)";
  if (i === list.length - 1 && list.length > 1) return "var(--sol-green)";
  return STATUS_TONES[i % STATUS_TONES.length];
}

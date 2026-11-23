// How a backend push reached prod and what it changed there. Shared by the web deploy detail and the phone's deploy
// screen, so imports stay relative. A list row (the targets feed) carries the origin and the counts
// (DeployPushSummary); the names come only with the deploy itself (deploys.get, a DeployView).
import type { DeployPushSummary, DeployView } from "@codecast/shared/contracts/deploys";
import type { TargetDevPush } from "@codecast/shared/contracts/deployTargets";
import { agoOf } from "../../lib/threadState";

type Row = Partial<DeployPushSummary>;
type View = Pick<DeployView, "machine" | "pushed_via" | "dirty" | "adds" | "drops">;

/** Names a group shows before its "+K more". */
export const NAMES_SHOWN = 20;

/** Whether a list row says the push added or dropped anything, so the names are worth reading. */
export function hasChangeNames(row: object | null | undefined): boolean {
  const r = (row ?? {}) as Row & Partial<View>;
  return !!(r.adds_count || r.drops_count || r.adds?.length || r.drops?.length);
}

/** Where a push came from: `deploy.sh · ana-mac · 3 uncommitted files`, or null when nothing was recorded. */
export function originWords(row: object | null | undefined, view?: object | null): string | null {
  const at = <K extends keyof View>(k: K) => ((row ?? {}) as Partial<View>)[k] ?? ((view ?? {}) as Partial<View>)[k];
  const n = at("dirty");
  const parts = [at("pushed_via"), at("machine"), n ? `${n} uncommitted ${n === 1 ? "file" : "files"}` : null].filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ") : null;
}

export type ChangeGroup = { kind: "dropped" | "added"; label: string; names: string[] };

/** What a push took off the target and put on it, dropped first, each counted; a group whose names have not
 *  arrived yet has none. Empty groups are left out. */
export function changeGroups(row: object | null | undefined, view?: object | null): ChangeGroup[] {
  const r = (row ?? {}) as Row & Partial<View>;
  const v = (view ?? {}) as Partial<View>;
  const group = (kind: ChangeGroup["kind"], word: string, names: string[] | undefined, count: number | undefined): ChangeGroup[] => {
    const n = names?.length || count || 0;
    return n ? [{ kind, label: `${word} ${n}`, names: names ?? [] }] : [];
  };
  return [
    ...group("dropped", "Dropped", v.drops ?? r.drops, r.drops_count),
    ...group("added", "Added", v.adds ?? r.adds, r.adds_count),
  ];
}

/** The names a group shows and how many it holds back. */
export function shownNames(names: string[], all: boolean): { shown: string[]; more: number } {
  if (all || names.length <= NAMES_SHOWN) return { shown: names, more: 0 };
  return { shown: names.slice(0, NAMES_SHOWN), more: names.length - NAMES_SHOWN };
}

/** A target's dev push in one line: `uncommitted push · ana-mac · Ana · 3m ago · 2 files`, with what it added and
 *  dropped when it did. A push of a clean tree names its sha instead (`dev push of 1a2b3c4`). */
export function devPushWords(p: TargetDevPush, now: number): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return [
    p.dirty > 0 ? "uncommitted push" : `dev push of ${p.sha.slice(0, 7)}`,
    p.machine,
    p.by,
    agoOf(now - p.at),
    p.dirty > 0 ? n(p.dirty, "file", "files") : null,
    p.adds_count ? `added ${p.adds_count}` : null,
    p.drops_count ? `dropped ${p.drops_count}` : null,
  ].filter((x): x is string => !!x).join(" · ");
}

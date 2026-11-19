// What a climb level can see (flows.md FL10, contracts/climb.ts levelNoise).
// A climb compares each candidate with the base case by case, so on a
// reproducible base the difference varies only on the cases a change moves:
// a paired level's floor rests on the share of cases one change moves and
// the change a moved case makes. This module reads those from the card and
// from the level's earlier climbs filed in the registry.
import type { EnvCase } from "@codecast/shared/contracts/envs";
import type { ClimbCardLevel } from "@codecast/shared/contracts/climb";

type Post = (urlPath: string, body: Record<string, unknown>, read?: boolean) => Promise<any>;
export type MovedHistory = { share: number; rms?: number };
export type PairedTerms = { share: number; rms?: number; from: "history" | "card" };

/**
 * How earlier climbs' changes moved this level, from the registry: each
 * candidate attempt on dev at this env_version against the base attempt filed
 * nearest before it, the share of cases its change moved and the root mean
 * square of those moves. The median of up to eight. Null with no such history.
 */
export async function movedHistory(post: Post, goal: string, env: string, version: string): Promise<MovedHistory | null> {
  const rows: any[] = await post("/cli/envs/list", { goal, env, limit: 50 }, true).catch(() => []);
  const same = (rows ?? []).filter((a) => a?.split === "dev" && a?.env_version === version && typeof a?.finished_at === "number");
  const bases = same.filter((a) => a.candidate?.label === "base").sort((a, b) => b.finished_at - a.finished_at);
  const cands = same.filter((a) => a.candidate?.label !== "base").sort((a, b) => b.finished_at - a.finished_at).slice(0, 8);
  const cases = async (id: string): Promise<EnvCase[] | null> => { const a = await post("/cli/envs/get", { id }, true).catch(() => null); return Array.isArray(a?.cases) ? a.cases : null; };
  const shares: number[] = [], rmss: number[] = [];
  for (const c of cands) {
    const b = bases.find((x) => x.finished_at <= c.finished_at) ?? bases[bases.length - 1];
    if (!b) continue;
    const [bc, cc] = [await cases(b.short_id), await cases(c.short_id)];
    if (!bc || !cc) continue;
    const base = new Map(bc.map((x) => [x.id, x.score]));
    const diffs = cc.flatMap((x) => (base.has(x.id) ? [x.score - base.get(x.id)!] : []));
    if (!diffs.length) continue;
    const moved = diffs.filter((d) => Math.abs(d) > 1e-6);
    shares.push(moved.length / diffs.length);
    if (moved.length) rmss.push(Math.sqrt(moved.reduce((a, d) => a + d * d, 0) / moved.length));
  }
  if (!shares.length) return null;
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
  return { share: median(shares), ...(rmss.length ? { rms: median(rmss) } : {}) };
}

/** A level's paired-floor terms: the card's share when it states one, else the history's, with the history's moved change. Undefined when nothing gives a share. */
export function pairedTerms(level: Pick<ClimbCardLevel, "moved_share">, history: MovedHistory | null): PairedTerms | undefined {
  const share = level.moved_share ?? history?.share;
  if (share === undefined || !(share > 0)) return undefined;
  return { share, ...(history?.rms ? { rms: history.rms } : {}), from: level.moved_share !== undefined ? "card" : "history" };
}

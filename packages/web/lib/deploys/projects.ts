// A personal workspace's Deploys page lists projects, not targets: one chip per repository that has a deploy record or
// a Ship run there, multi-select, all on until the viewer turns one off (components/deploys/DeploysPage). Pure: no
// store, no React.
import type { ShippingRun } from "@codecast/shared/contracts/deployTargets";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
import { repositoryOfRun } from "./board";
import { recordTarget, targetNow, type DeployTargetRow, type TeamDeployRow } from "./targets";

/** What a project's chip says at a glance: going out, last deploy failed, something live, or nothing live known. */
export type ProjectTone = "going" | "failed" | "current" | "unknown";

export type Project = {
  /** `owner/name`, lowercased. */
  repository: string;
  /** How the address names it: the whole `owner/name`, lowercased, so two owners' same-named repositories stay apart. */
  key: string;
  /** What its chip and tags say: the repository's part after the owner. */
  name: string;
  targets: DeployTargetRow[];
  tone: ProjectTone;
  /** Deploys that went live in the last 30 days. */
  live30: number;
  /** Its newest activity: a deploy asked for or going live, or a Ship run moving. */
  at: number;
};

const MONTH_MS = 30 * 24 * 60 * 60_000;


/**
 * Every project in the workspace, newest activity first: each repository its targets (from deploy records) name, and
 * each a Ship run is in, given the target personal Ship runs record (`production`) when it has no record yet.
 */
export function projectsOf(
  targets: ReadonlyArray<DeployTargetRow>,
  deploys: ReadonlyArray<TeamDeployRow>,
  runs: ReadonlyArray<ShippingRun>,
  checkouts: ReadonlyArray<Pick<CheckoutRow, "path" | "repository">>,
  workspace: string,
  now: number,
): Project[] {
  const byRepo = new Map<string, { targets: DeployTargetRow[]; at: number }>();
  const entry = (repository: string) => {
    const k = repository.toLowerCase();
    let e = byRepo.get(k);
    if (!e) byRepo.set(k, (e = { targets: [], at: 0 }));
    return e;
  };
  for (const t of targets) if (t.repository) entry(t.repository).targets.push(t);
  for (const r of runs) {
    const repository = repositoryOfRun(r, checkouts);
    if (!repository) continue;
    const e = entry(repository);
    e.at = Math.max(e.at, r.updated_at);
  }
  const out: Project[] = [];
  for (const [repository, e] of byRepo) {
    const ts = e.targets.length ? e.targets : [recordTarget(workspace, "", "production", repository)];
    const nows = ts.map((t) => targetNow(t, deploys));
    const history = nows.flatMap((n) => n.history);
    const at = Math.max(e.at, ...history.map((d) => Math.max(d.created_at, d.live_at ?? 0)));
    const tone: ProjectTone = nows.some((n) => n.open) ? "going" : nows.some((n) => n.failed) ? "failed" : nows.some((n) => n.live) ? "current" : "unknown";
    const live30 = history.filter((d) => d.live_at != null && now - d.live_at <= MONTH_MS).length;
    out.push({ repository, key: repository, name: repository.split("/").pop() || repository, targets: ts, tone, live30, at });
  }
  return out.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
}

/** The projects `?projects=` turns on: every one when it is absent (null), none when it is empty. */
export function projectsOn(param: string | null): ReadonlySet<string> | null {
  return param === null ? null : new Set(param.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** `?projects=` after the viewer toggles `key`: null (all on, so the address names none) once every project is on. */
export function toggleProject(projects: ReadonlyArray<Pick<Project, "key">>, on: ReadonlySet<string> | null, key: string): string | null {
  const keys = projects.map((p) => p.key);
  const next = new Set(on ?? keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return keys.every((k) => next.has(k)) ? null : keys.filter((k) => next.has(k)).join(",");
}

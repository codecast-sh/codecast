// A deploy's words, the same on every surface that names one (deploys.md DP7):
// its title, the facts a card or pill shows, its state and tone.
import { deployStateWords, type DeployAfter, type DeployView } from "@codecast/shared/contracts/deploys";

type DeployLike = Partial<Pick<DeployView, "short_id" | "target" | "sha" | "version" | "status" | "carries" | "live_at" | "created_at" | "started_by">> & { after?: DeployAfter | null };

export function deployTitle(d: DeployLike): string {
  // A deploy with no sha or version is named by its dp-N.
  const v = d.sha ? d.sha.slice(0, 7) : d.version ? d.version.slice(0, 12) : d.short_id ?? null;
  return `${d.target ?? "deploy"}${v ? ` ${v}` : ""}`;
}


export const deployState = (d: DeployLike): string => deployStateWords({ status: d.status ?? "live", carries: d.carries ?? [] }, d.after ?? null);

export function deployFacts(d: DeployLike): string[] {
  const n = d.carries?.length ?? 0;
  return [deployState(d), n ? `${n} fix${n === 1 ? "" : "es"}` : "no fixes", ...(d.started_by?.name ? [d.started_by.name] : [])];
}

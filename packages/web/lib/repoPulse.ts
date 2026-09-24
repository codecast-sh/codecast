import { publicRepoUrl } from "./repoTransport";
import { SITE_LINKS } from "./siteLinks";

export type RepoPulse = { stargazers_count: number | null; live: number };

export const REPO_PULSE_URL = publicRepoUrl(SITE_LINKS.repository, "pulse", {});

/** The words beside the dot, and the ones that replace them on hover. */
export function pulseWords(live: number): { now: string; hover: string } {
  if (live <= 0) return { now: "quiet now", hover: "see who built it" };
  return { now: `${live} ${live === 1 ? "agent" : "agents"} now`, hover: "watch them build it" };
}

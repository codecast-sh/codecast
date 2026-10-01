/**
 * Chapter 10, GitHub (61 to 68s): the pull request knows its sessions: checks
 * go green and it merges.
 */

import { MergedFlyer, PullRequestPage } from "./integrations";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "integrations",
  parts: [{ key: "main", region: "pr.main", order: 0, Component: PullRequestPage }],
  flyers: {
    "integrations.merged": MergedFlyer,
  },
};

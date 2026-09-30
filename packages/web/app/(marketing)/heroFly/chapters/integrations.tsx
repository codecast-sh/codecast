"use client";

/**
 * Chapter 10, GitHub (61 to 68s): the pull request knows its sessions: checks
 * go green and it merges. PLACEHOLDER: replace each placeholder part with the
 * real views it names, fed by ../fixtures/integrations.ts. See README.md for
 * the contract.
 */

import { placeholderFlyer, placeholderPart } from "../placeholder";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "integrations",
  parts: [
    placeholderPart("integrations", "main", "pr.main", 0, "Pull request", ["PRHeader", "PRChecks", "PRCommits", "PrStatusChip", "ExternalEventRow", "IssueLink"]),
  ],
  flyers: {
    "integrations.merged": placeholderFlyer("Merged #482"),
  },
};

"use client";

/**
 * Chapter 8, Automate (47 to 53s): a trigger that checks CI every four hours
 * fires, and a workflow runs implement, verify, review. PLACEHOLDER: replace
 * each placeholder part with the real views it names, fed by
 * ../fixtures/automation.ts. See README.md for the contract.
 */

import { placeholderPart } from "../placeholder";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "automation",
  parts: [
    placeholderPart("automation", "main", "auto.main", 0, "Triggers and a workflow run", ["TriggerRowItem (actions)", "SchedFireBadge", "SchedHealthDot", "ScheduledTaskBlock", "WorkflowGraphView (chrome off)", "WorkflowRunNodes", "RunGate", "ThreadStatePanel"]),
  ],
};

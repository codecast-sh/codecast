"use client";

/**
 * Chapter 7, Track (40 to 47s): the lead files a task from the conversation;
 * it falls onto the board, an agent claims it, and the plan advances.
 * PLACEHOLDER: replace each placeholder part with the real views it names, fed
 * by ../fixtures/work.ts. See README.md for the contract.
 */

import { placeholderFlyer, placeholderPart } from "../placeholder";
import { OBJECTS } from "../fixtures/story";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "work",
  parts: [
    placeholderPart("work", "files", "desk.transcript", 40, "Lead files the task", ["CastCommandBlock", "TaskPill"], 60),
    placeholderPart("work", "board", "board.main", 0, "Task board and plan", ["TaskRow", "KanbanCard", "ListRowShell", "StationStrip", "TaskStatusBadge", "IssueLink", "LabelChips", "ActiveSessionBadge", "PlanProgressBar", "PlanGraphView"]),
  ],
  flyers: {
    "work.task": placeholderFlyer(OBJECTS.task.title),
  },
};

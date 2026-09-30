"use client";

/**
 * Chapter 1, Inbox (0 to 9s): the live inbox: six sessions from five agents,
 * the lead's row landing on top and taking focus. PLACEHOLDER: replace each
 * placeholder part with the real views it names, fed by ../fixtures/inbox.ts.
 * See README.md for the contract.
 */

import { placeholderPart } from "../placeholder";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "inbox",
  parts: [
    placeholderPart("inbox", "sidebar", "desk.sidebar", 0, "Sidebar", ["RailHeading", "SectionRow", "NavCount", "NavSection", "InboxNavRow", "SearchField"]),
    placeholderPart("inbox", "leadRow", "desk.list", 10, "Inbox: section header and the lead row", ["SectionHeader", "SessionCardView", "InboxViewMenu", "TopbarButton"], 80),
    placeholderPart("inbox", "rows", "desk.list", 30, "Inbox: the other sessions", ["SessionCardView", "StatusDot", "AgentTypeIcon", "SessionWorktreeChip", "PrStatusChip"]),
  ],
};

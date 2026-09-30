"use client";

/**
 * Chapter 9, Team (53 to 61s): the team channel, an agent replying in it, a
 * huddle with live captions, and the org chart. PLACEHOLDER: replace each
 * placeholder part with the real views it names, fed by ../fixtures/team.ts.
 * See README.md for the contract.
 */

import { placeholderPart } from "../placeholder";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "team",
  parts: [
    placeholderPart("team", "main", "team.main", 0, "Channel, huddle and org", ["ChatMessageList", "ChatMessage", "TypingIndicator", "FaceRow", "TranscriptTurnList", "PresenceFacepile", "CursorArrow", "OrgGraph", "FeedCard"]),
  ],
};

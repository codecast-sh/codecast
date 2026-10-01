/**
 * Chapter 9, Team (53 to 61s): the team channel, an agent replying in it, a
 * huddle with live captions, and the org chart. PLACEHOLDER: build the real
 * views in ./<id>.tsx and replace each placeholder part with them, fed by ../fixtures/team.ts.
 * See README.md for the contract.
 */

import { placeholderPart } from "../placeholderParts";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "team",
  parts: [
    placeholderPart("team", "main", "team.main", 0, "Channel, huddle and org", ["ChatMessageList", "ChatMessage", "TypingIndicator", "FaceRow", "TranscriptTurnList", "PresenceFacepile", "CursorArrow", "OrgGraph", "FeedCard"]),
  ],
};

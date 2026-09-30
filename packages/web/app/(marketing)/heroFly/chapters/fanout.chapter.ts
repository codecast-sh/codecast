/**
 * Chapter 3, Fan out (15 to 21s): the lead spawns two workers; their rows land
 * in the list and they boot on the pair. PLACEHOLDER: replace each placeholder
 * part with the real views it names, fed by ../fixtures/fanout.ts. See
 * README.md for the contract.
 */

import { placeholderFlyer, placeholderPart } from "../placeholderParts";
import { SESSIONS } from "../fixtures/story";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "fanout",
  parts: [
    placeholderPart("fanout", "spawn", "desk.transcript", 20, "Spawn blocks", ["CastCommandBlock", "TaskToolBlock", "SessionConstellation"], 90),
    placeholderPart("fanout", "workerRows", "desk.list", 20, "Worker rows", ["SessionCardView (subagent)"], 110),
    placeholderPart("fanout", "headerA", "pairA.header", 0, "Worker A header", ["ConversationHeaderBar", "AgentStatusPill"]),
    placeholderPart("fanout", "headerB", "pairB.header", 0, "Worker B header", ["ConversationHeaderBar", "AgentStatusPill"]),
    placeholderPart("fanout", "bootA", "pairA.transcript", 10, "Worker A boots", ["UserPrompt", "AssistantBlock"], 80),
    placeholderPart("fanout", "bootB", "pairB.transcript", 10, "Worker B boots", ["UserPrompt", "AssistantBlock"], 80),
  ],
  flyers: {
    "fanout.spawnA": placeholderFlyer(SESSIONS.api.title),
    "fanout.spawnB": placeholderFlyer(SESSIONS.ui.title),
  },
};

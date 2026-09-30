"use client";

/**
 * Chapter 2, Steer (9 to 15s): the lead's conversation: the prompt, a test
 * run, an edit, and the composer steering it. PLACEHOLDER: replace each
 * placeholder part with the real views it names, fed by
 * ../fixtures/conversation.ts. See README.md for the contract.
 */

import { placeholderPart } from "../placeholder";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "conversation",
  parts: [
    placeholderPart("conversation", "header", "desk.header", 0, "Conversation header", ["ConversationHeaderBar", "AgentStatusPill", "ConversationMetadata", "IdentityFace", "ViewerFaces"]),
    placeholderPart("conversation", "transcript", "desk.transcript", 10, "Lead transcript", ["UserPrompt", "AssistantBlock", "ToolBlock", "ThinkingBlock", "InlineDiff", "WorkingStatusLine"], 150),
    placeholderPart("conversation", "composer", "desk.composer", 0, "Composer", ["ComposerShell"]),
  ],
};

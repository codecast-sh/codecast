/**
 * Chapter 2, Steer (9 to 15s): the lead's conversation: the prompt, an edit, a
 * test run, and the composer steering it mid-run. The transcript also carries
 * chapter 3's spawn blocks, so one feed lifts as entries land. Views in
 * ./conversation.tsx, fed by ../fixtures/conversation.ts.
 */

import { LeadComposer, LeadHeader, LeadTranscript } from "./conversation";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "conversation",
  parts: [
    { key: "header", region: "desk.header", order: 0, Component: LeadHeader },
    { key: "transcript", region: "desk.transcript", order: 10, Component: LeadTranscript },
    { key: "composer", region: "desk.composer", order: 0, Component: LeadComposer },
  ],
};

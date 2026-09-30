/**
 * Chapter 5, Agents talk (28 to 34s): the workers message each other with cast
 * send, and one forks to try another way. PLACEHOLDER: build the real
 * views in ./<id>.tsx and replace each placeholder part with them, fed by ../fixtures/talk.ts.
 * See README.md for the contract.
 */

import { placeholderFlyer, placeholderPart } from "../placeholderParts";
import { SESSIONS } from "../fixtures/story";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "talk",
  parts: [
    placeholderPart("talk", "sendA", "pairA.transcript", 20, "cast send, then the reply", ["CastCommandBlock", "SessionMessageBlock", "EntityIdPill"], 120),
    placeholderPart("talk", "receiveB", "pairB.transcript", 20, "Message from, then a fork", ["SessionMessageBlock", "UserPrompt (forkChildren)"], 120),
  ],
  flyers: {
    "talk.envelope": placeholderFlyer(SESSIONS.api.title),
    "talk.envelopeBack": placeholderFlyer(SESSIONS.ui.title),
  },
};

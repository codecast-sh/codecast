/**
 * Chapter 5, Agents talk (28 to 34s): the workers message each other with cast
 * send, and one forks to try another way. Views in ./talk.tsx, fed by
 * ../fixtures/talk.ts.
 */

import { ApiSide, EnvelopeBackFlyer, EnvelopeFlyer, UiSide } from "./talk";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "talk",
  parts: [
    { key: "sendA", region: "pairA.transcript", order: 20, Component: ApiSide },
    { key: "receiveB", region: "pairB.transcript", order: 20, Component: UiSide },
  ],
  flyers: {
    "talk.envelope": EnvelopeFlyer,
    "talk.envelopeBack": EnvelopeBackFlyer,
  },
};

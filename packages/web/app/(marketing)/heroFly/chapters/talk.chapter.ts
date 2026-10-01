/**
 * Chapter 5, Agents talk (29.7 to 36.6s): the workers message each other with
 * cast send, and you fork the API worker to try another way. Views in ./talk.tsx, fed by
 * ../fixtures/talk.ts.
 */

import { ApiSide, EnvelopeBackFlyer, EnvelopeFlyer, ForkFeed, ForkFlyer, ForkHeader, UiSide } from "./talk";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "talk",
  parts: [
    { key: "sendA", region: "pairA.transcript", order: 20, Component: ApiSide },
    { key: "receiveB", region: "pairB.transcript", order: 20, Component: UiSide },
    // The fork's window, over the dashboard worker's once the fork opens.
    { key: "forkHeader", region: "pairB.header", order: 10, Component: ForkHeader },
    { key: "forkFeed", region: "pairB.transcript", order: 30, Component: ForkFeed },
  ],
  flyers: {
    "talk.envelope": EnvelopeFlyer,
    "talk.envelopeBack": EnvelopeBackFlyer,
    "talk.fork": ForkFlyer,
  },
};

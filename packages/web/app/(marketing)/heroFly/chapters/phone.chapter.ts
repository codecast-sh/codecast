/**
 * Chapter 4, Phone: the API worker stops on a question in its own pane; the
 * question reaches the codecast app on the phone, the answer typed there
 * goes back, and the worker carries on with it. Views in ./phone.tsx, fed by
 * ../fixtures/phone.ts.
 */

import { PhoneScreen, QuestionFlyer, WorkerExchange } from "./phone";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "phone",
  parts: [
    { key: "exchange", region: "pairA.transcript", order: 15, Component: WorkerExchange },
    { key: "phone", region: "phone.main", order: 0, Component: PhoneScreen },
  ],
  flyers: {
    "phone.question": QuestionFlyer,
  },
};

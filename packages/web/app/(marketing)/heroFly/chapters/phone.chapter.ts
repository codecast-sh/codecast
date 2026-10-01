/**
 * Chapter 4, Approve: the API worker asks to run a command in its own pane;
 * the ask reaches the phone, and Approve on the phone lands back on the
 * worker. Views in ./phone.tsx, fed by ../fixtures/phone.ts.
 */

import { PairVeil, PhoneScreen, PushFlyer, WorkerPermission } from "./phone";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "phone",
  parts: [
    { key: "permission", region: "pairA.transcript", order: 15, Component: WorkerPermission },
    { key: "veil", region: "pairB.scrim", order: 0, Component: PairVeil },
    { key: "phone", region: "phone.main", order: 0, Component: PhoneScreen },
  ],
  flyers: {
    "phone.permission": PushFlyer,
  },
};

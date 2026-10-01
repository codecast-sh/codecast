/**
 * Chapter 4, Approve (21 to 28s): the API worker asks to run a command; the
 * ask reaches the desk and the phone, and Approve on the phone lands back on
 * the desk. Views in ./phone.tsx, fed by ../fixtures/phone.ts.
 */

import { DeskPermission, PhoneScreen, PushFlyer } from "./phone";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "phone",
  parts: [
    { key: "permission", region: "desk.transcript", order: 30, Component: DeskPermission },
    { key: "phone", region: "phone.main", order: 0, Component: PhoneScreen },
  ],
  flyers: {
    "phone.permission": PushFlyer,
  },
};

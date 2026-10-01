/**
 * Chapter 1, Inbox (0 to 9s): the live inbox: six sessions from six agents,
 * the lead's row landing on top and taking focus, and (from chapter 3) the
 * workers it spawns landing under it. Views in ./inbox.tsx, fed by
 * ../fixtures/desk.ts. See README.md for the contract.
 */

import { DeskRail, DeskTopBar, InboxList } from "./inbox";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "inbox",
  parts: [
    { key: "topbar", region: "desk.topbar", order: 0, Component: DeskTopBar },
    { key: "rail", region: "desk.sidebar", order: 0, Component: DeskRail },
    { key: "list", region: "desk.list", order: 10, Component: InboxList },
  ],
};

/**
 * Chapter 13, Anywhere (80 to 84s): the same sessions on a laptop and a cloud
 * host, and an agent driving a browser there. Views in ./remote.tsx, fed by
 * ../fixtures/remote.ts.
 */

import { Anywhere, DeskVeil } from "./remote";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "remote",
  parts: [
    { key: "veil", region: "desk.scrim", order: 0, Component: DeskVeil },
    { key: "inset", region: "desk.inset", order: 0, Component: Anywhere },
  ],
};

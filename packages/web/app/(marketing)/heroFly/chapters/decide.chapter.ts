/**
 * Chapter 6, Decide (34 to 40s): the lead queues a decision with priced
 * options; picking one records the answer. Views in ./decide.tsx, fed by
 * ../fixtures/decide.ts.
 */

import { DecisionCard } from "./decide";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "decide",
  parts: [{ key: "card", region: "desk.side", order: 0, Component: DecisionCard }],
};

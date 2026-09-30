/**
 * Chapter 6, Decide (34 to 40s): the lead queues a decision with priced
 * options; picking one records the answer. PLACEHOLDER: build the real
 * views in ./<id>.tsx and replace each placeholder part with them, fed by ../fixtures/decide.ts.
 * See README.md for the contract.
 */

import { placeholderPart } from "../placeholderParts";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "decide",
  parts: [
    placeholderPart("decide", "card", "desk.side", 0, "Decision card", ["DecisionCompactCardView", "DecisionOptionList", "DecisionAnswerControls (keys off)", "DecisionRecordedAnswer"]),
  ],
};

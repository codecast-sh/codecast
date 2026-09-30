"use client";

/**
 * Chapter 6, Decide (34 to 40s): the lead queues a decision with priced
 * options; picking one records the answer. PLACEHOLDER: replace each
 * placeholder part with the real views it names, fed by ../fixtures/decide.ts.
 * See README.md for the contract.
 */

import { placeholderPart } from "../placeholder";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "decide",
  parts: [
    placeholderPart("decide", "card", "desk.side", 0, "Decision card", ["DecisionCompactCardView", "DecisionOptionList", "DecisionAnswerControls (keys off)", "DecisionRecordedAnswer"]),
  ],
};

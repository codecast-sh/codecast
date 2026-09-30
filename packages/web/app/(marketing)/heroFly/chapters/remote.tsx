"use client";

/**
 * Chapter 13, Anywhere (80 to 84s): the same sessions on a laptop, a cloud
 * host and in a browser. PLACEHOLDER: replace each placeholder part with the
 * real views it names, fed by ../fixtures/remote.ts. See README.md for the
 * contract.
 */

import { placeholderPart } from "../placeholder";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "remote",
  parts: [
    placeholderPart("remote", "inset", "desk.inset", 0, "Machines and browser", ["MachineChips", "TmuxAttachPill", "BrowserTabPill", "WatchAddress", "CastCommandBlock (cast computer)"]),
  ],
};

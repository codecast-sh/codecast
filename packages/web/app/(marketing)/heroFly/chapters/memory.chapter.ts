/**
 * Chapter 12, Memory (74 to 80s): three weeks later a teammate searches the
 * palette, and session blame ties a line to its session. The views are in
 * ./memory.tsx, fed by ../fixtures/memory.ts. See README.md for the contract.
 */

import { Blame, PaletteSearch } from "./memory";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "memory",
  parts: [
    { key: "palette", region: "palette.main", order: 0, Component: PaletteSearch },
    { key: "blame", region: "blame.main", order: 0, Component: Blame },
  ],
};

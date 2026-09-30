"use client";

/**
 * Chapter 12, Memory (74 to 80s): three weeks later a teammate searches the
 * palette, and cast blame ties a line to its session. PLACEHOLDER: replace
 * each placeholder part with the real views it names, fed by
 * ../fixtures/memory.ts. See README.md for the contract.
 */

import { placeholderPart } from "../placeholder";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "memory",
  parts: [
    placeholderPart("memory", "palette", "palette.main", 0, "Command palette search", ["Command (cmdk)", "CommandPaletteList", "PaletteSessionRow", "PaletteSearchResultRow", "KeyCap", "SearchResultRow"]),
    placeholderPart("memory", "blame", "blame.main", 0, "Blame", ["SessionBlameStrip", "BlobView (blameMode session)"]),
  ],
};

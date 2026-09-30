"use client";

/**
 * Chapter 11, Publish (68 to 74s): a canvas report becomes a published page
 * with viewer comments. PLACEHOLDER: replace each placeholder part with the
 * real views it names, fed by ../fixtures/publish.ts. See README.md for the
 * contract.
 */

import { placeholderPart } from "../placeholder";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "publish",
  parts: [
    placeholderPart("publish", "main", "page.main", 0, "Canvas, then the published page", ["AssistantBlock (cast-canvas)", "HtmlSnippet", "PageCard", "published page (srcdoc iframe)"]),
  ],
};

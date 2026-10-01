/**
 * Chapter 11, Publish (68 to 74s): a canvas report becomes a published page
 * with viewer comments. The views are in ./publish.tsx, fed by
 * ../fixtures/publish.ts. See README.md for the contract.
 */

import { PublishScene } from "./publish";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "publish",
  parts: [{ key: "scene", region: "page.main", order: 0, Component: PublishScene }],
};

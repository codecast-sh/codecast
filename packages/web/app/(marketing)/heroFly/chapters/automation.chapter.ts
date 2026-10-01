/**
 * Chapter 8, Automate (47 to 53s): a trigger that checks CI every four hours
 * fires, and a workflow runs implement, verify, review.
 */

import { AutomationSurface } from "./automation";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "automation",
  parts: [{ key: "main", region: "auto.main", order: 0, Component: AutomationSurface }],
};

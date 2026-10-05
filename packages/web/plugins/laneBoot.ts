import type { Plugin, ResolvedConfig } from "vite";
import { inlineIife } from "./inlineIife";
// A path into the vendored mirror: the config runs under Node, and this entry
// is plain JS, so Node loads it as it is.
import { tokensStyleTag } from "../../../platform/packages/design/vite.js";

/**
 * Lets a cold load of a simple lane page open on the lane's own paper rather
 * than the full app's splash. Two things go into index.html's <head>:
 *
 * - the family token sheet (@platform/design's tokensStyleTag, generated from its
 *   PALETTE), so the boot screen and AppLoader read the same --pd-* values the
 *   lane and Whisk do, with no second copy of a colour;
 * - components/simple/laneBoot.ts as an inline script, which flags
 *   <html data-lane> on a lane path before the body paints.
 *
 * The rules that use them sit beside #boot-shell in index.html.
 */

const PLUGIN_NAME = "codecast-lane-boot";
const SOURCE = "components/simple/laneBoot.ts";
const GLOBAL_NAME = "__ccLaneBoot";

export function laneBootPlugin(): Plugin {
  let config: ResolvedConfig;

  return {
    name: PLUGIN_NAME,
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml: {
      order: "pre",
      async handler() {
        const code = await inlineIife(config.root, SOURCE, GLOBAL_NAME);
        return [
          tokensStyleTag(),
          { tag: "script", children: `${code};${GLOBAL_NAME}.markLanePage()`, injectTo: "head" },
        ];
      },
    },
  };
}

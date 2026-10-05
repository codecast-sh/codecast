import type { Plugin, ResolvedConfig } from "vite";
import { inlineIife } from "./inlineIife";
// A relative import: the config is loaded by Node, which will not strip types
// from a node_modules import.
import { tokensCss } from "../../../platform/packages/design/src/css";

/**
 * Lets a cold load of a simple lane page open on the lane's own paper rather
 * than the full app's splash. Two things go into index.html's <head>:
 *
 * - the family token sheet (@platform/design's tokensCss, generated from its
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
          { tag: "style", attrs: { "data-pd-tokens": "" }, children: tokensCss(), injectTo: "head" },
          { tag: "script", children: `${code};${GLOBAL_NAME}.markLanePage()`, injectTo: "head" },
        ];
      },
    },
  };
}

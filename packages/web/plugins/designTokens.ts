import type { Plugin } from "vite";
// A path into the vendored mirror: the config runs under Node, and this entry
// is plain JS, so Node loads it as it is.
import { tokensStyleTag } from "../../../platform/packages/design/vite.js";

/**
 * Puts the family token sheet (@platform/design's tokensStyleTag, generated
 * from its PALETTE) into index.html's <head>, so the assistant's marketing
 * pages read the same --pd-* values Whisk does, with no second copy of a
 * colour.
 */
export function designTokensPlugin(): Plugin {
  return {
    name: "codecast-design-tokens",
    transformIndexHtml: {
      order: "pre",
      handler: () => [tokensStyleTag()],
    },
  };
}

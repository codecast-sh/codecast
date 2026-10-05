// Puts the family token sheet into an app's index.html <head>, so the page
// paints on the family's paper before any bundle loads, and a script in
// <body> can read a --pd-* value. It goes at the end of the head, never the
// start: <meta charset> must stay inside the document's first 1024 bytes.
// Plain JS that reads the checked-in tokens.css: a vite config runs under
// Node, which will not strip types from a node_modules import. tokens.test.ts
// keeps the file equal to tokensCss().
import { readFileSync } from "node:fs";

/** The <style> tag that carries tokens.css, as a vite HtmlTagDescriptor. */
export function tokensStyleTag() {
  return {
    tag: "style",
    attrs: { "data-pd-tokens": "" },
    children: readFileSync(new URL("./tokens.css", import.meta.url), "utf8"),
    injectTo: "head",
  };
}

/** Vite plugin: injects tokensStyleTag() into every HTML entry. */
export function designTokens() {
  return {
    name: "platform-design-tokens",
    transformIndexHtml: { order: "pre", handler: () => [tokensStyleTag()] },
  };
}

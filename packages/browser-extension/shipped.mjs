/**
 * The files that make up the extension as it ships: what release.mjs zips for
 * the Web Store, and what the CLI build embeds so a cloud host can load the
 * extension into its own Chrome (packages/cli/src/browser/hostExtension.ts).
 * Everything else in this directory is for developing it.
 */
export const SHIPPED = ["manifest.json", "background.js", "page.js", "options.html", "options.js", "popup.html", "popup.js", "offscreen.html", "offscreen.js", "status.js", "brand.css", "icons"];

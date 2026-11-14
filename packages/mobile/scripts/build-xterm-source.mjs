// Vendors web's @xterm/xterm build into lib/vendor/xtermSource.ts, which the
// phone terminal's WebView document inlines (lib/terminal/terminalHtml.ts).
// Run from packages/mobile: bun scripts/build-xterm-source.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const root = dirname(require.resolve("@xterm/xterm/package.json"));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const js = readFileSync(join(root, "lib/xterm.js"), "utf8").replace(/\n\/\/# sourceMappingURL=.*$/m, "");
const css = readFileSync(join(root, "css/xterm.css"), "utf8");
const out = `// Vendored @xterm/xterm@${version} lib/xterm.js and css/xterm.css (MIT, (c) The xterm.js authors).
// Runs only inside the phone terminal's WebView. Regenerate: bun scripts/build-xterm-source.mjs
// eslint-disable-next-line
export const XTERM_VERSION = ${JSON.stringify(version)};
// eslint-disable-next-line
export const XTERM_JS: string = ${JSON.stringify(js)};
// eslint-disable-next-line
export const XTERM_CSS: string = ${JSON.stringify(css)};
`;
await Bun.write(new URL("../lib/vendor/xtermSource.ts", import.meta.url), out);
console.log(`xterm ${version}: ${(out.length / 1024).toFixed(0)} KB`);

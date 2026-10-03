// The Changes page as text, for its guard tests: its source files and its own
// rules in globals.css, read once so every guard reads the same. The walk and
// the comment stripping are the shared guard ones (lib/__tests__/sourceWalk).
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import postcss from "postcss";
import { WEB_ROOT, codeLines, walkSources } from "../../../lib/__tests__/sourceWalk";

/** Source with its comment lines dropped, so a mention in prose never counts. */
export const code = (src: string) => codeLines(src).map((l) => l.line).join("\n");

/** Every source file the page renders from, the components and the route, as code. */
export const pageSources = (): { file: string; code: string }[] =>
  [join(WEB_ROOT, "components", "changes"), join(WEB_ROOT, "app", "changes")]
    .flatMap((dir) => walkSources(dir))
    .map((f) => ({ file: relative(WEB_ROOT, f), code: code(readFileSync(f, "utf8")) }));

/** One component of the page by file name, as code. */
export const pageSource = (name: string) => code(readFileSync(join(WEB_ROOT, "components", "changes", name), "utf8"));

/** globals.css parsed, comments removed. */
export const globalsRoot = postcss.parse(readFileSync(join(WEB_ROOT, "app", "globals.css"), "utf8"));
globalsRoot.walkComments((c) => {
  c.remove();
});

/** The page's own rules in globals.css: every top-level statement naming a `chg` class or keyframes. */
export const changesCss = globalsRoot.nodes
  .map((n) => n.toString())
  .filter((t) => /\bchg/i.test(t))
  .join("\n");

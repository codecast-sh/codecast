// CSS modules hash every animation name a module uses, so a module that
// names a keyframe from base.css without global() points at a rule that
// doesn't exist, and the animation silently never runs. Every animation in a
// module must name a keyframe defined in that file, or global(name) for one
// defined in base.css. Names come first in each animation, by convention.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

const src = new URL("..", import.meta.url).pathname;
const keyframes = (css: string) => new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
const globals = keyframes(readFileSync(`${src}styles/base.css`, "utf8"));

/** The first word of each comma-separated animation in a declaration. */
function animationNames(css: string): string[] {
  const names: string[] = [];
  for (const [, value] of css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    for (const part of value.split(/,(?![^(]*\))/)) names.push(part.trim().split(/\s+/)[0]);
  }
  return names;
}

describe("animation names in CSS modules", () => {
  const files = [...new Glob("**/*.module.css").scanSync(src)];
  test.each(files)("%s names only keyframes that exist", (file) => {
    const css = readFileSync(src + file, "utf8");
    const local = keyframes(css);
    const missing = animationNames(css).filter((name) => {
      if (name === "none") return false;
      const global = /^global\(([\w-]+)\)$/.exec(name);
      return global ? !globals.has(global[1]) : !local.has(name);
    });
    expect(missing).toEqual([]);
  });
});

/** Every @keyframes in a stylesheet, with whether it sits inside a
 *  prefers-reduced-motion: reduce block. */
function keyframeBlocks(css: string): { name: string; body: string; reduced: boolean }[] {
  const out: { name: string; body: string; reduced: boolean }[] = [];
  const walk = (text: string, reduced: boolean) => {
    const at = /@(keyframes\s+([\w-]+)\s*|media[^{]*)\{/g;
    let m: RegExpExecArray | null;
    while ((m = at.exec(text))) {
      let depth = 1;
      let i = at.lastIndex;
      while (depth > 0 && i < text.length) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0, i++;
      const body = text.slice(at.lastIndex, i - 1);
      if (m[2]) out.push({ name: m[2], body, reduced });
      else walk(body, reduced || /prefers-reduced-motion:\s*reduce/.test(m[1]));
      at.lastIndex = i;
    }
  };
  walk(css, false);
  return out;
}

const MOVES = /\b(transform|translate|scale|rotate)\s*:/;

describe("reduced motion", () => {
  const files = [...new Glob("**/*.css").scanSync(src)];
  test.each(files)("%s: every keyframe that moves has a still twin under reduce", (file) => {
    const blocks = keyframeBlocks(readFileSync(src + file, "utf8"));
    const still = new Set(blocks.filter((b) => b.reduced && !MOVES.test(b.body)).map((b) => b.name));
    const moving = blocks.filter((b) => !b.reduced && MOVES.test(b.body) && !still.has(b.name)).map((b) => b.name);
    expect(moving).toEqual([]);
  });
});

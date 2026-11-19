import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  REACT_COMPILER_PLUGIN,
  REACT_COMPILER_RUNTIME,
  REACT_COMPILER_SOURCES,
  inReactCompilerSources,
  reactCompilerBabelOptions,
  reactCompilerCompiles,
  reactCompilerOff,
  reactCompilerPathFilter,
  reactCompilerSources,
} from "./reactCompiler";
import { compileForBun, reactCompilerActive } from "../test-helpers/reactCompiler";

const WEB = path.resolve(import.meta.dir, "..");
const abs = (rel: string) => path.join(WEB, rel);
const LIST = ["components/conversation/", "components/AssignmentBadge.tsx"];

describe("the compiler's allowlist", () => {
  test("every entry names something that exists", () => {
    for (const entry of REACT_COMPILER_SOURCES) expect({ entry, exists: existsSync(abs(entry)) }).toEqual({ entry, exists: true });
  });

  test("a directory entry covers everything under it, a file entry only itself", () => {
    expect(inReactCompilerSources(abs("components/conversation/blocks/toolBlocks.tsx"), LIST)).toBe(true);
    expect(inReactCompilerSources("components/conversation/markdown.tsx", LIST)).toBe(true);
    expect(inReactCompilerSources(abs("components/AssignmentBadge.tsx"), LIST)).toBe(true);
    expect(inReactCompilerSources(abs("components/AssignmentBadgeMenu.tsx"), LIST)).toBe(false);
    expect(inReactCompilerSources(abs("components/conversationScroll.ts"), LIST)).toBe(false);
    expect(inReactCompilerSources(abs("components/MessageInput.tsx"), LIST)).toBe(false);
  });

  test("tests, native files, styles and anything outside the package are never compiled", () => {
    expect(inReactCompilerSources(abs("components/conversation/classify.test.ts"), LIST)).toBe(false);
    expect(inReactCompilerSources(abs("components/conversation/__tests__/x.tsx"), LIST)).toBe(false);
    expect(inReactCompilerSources(abs("components/conversation/row.native.tsx"), LIST)).toBe(false);
    expect(inReactCompilerSources(abs("components/conversation/conversationChat.css"), LIST)).toBe(false);
    expect(inReactCompilerSources(path.resolve(WEB, "..", "mobile", "components/conversation/x.tsx"), LIST)).toBe(false);
  });

  test("a Vite id's query is ignored", () => {
    expect(inReactCompilerSources(`${abs("components/conversation/markdown.tsx")}?t=1700000000000`, LIST)).toBe(true);
  });
});

describe("the switch", () => {
  const on = { REACT_COMPILER_SOURCES: LIST.join(",") };

  test("REACT_COMPILER=0 turns it off everywhere, whatever the list", () => {
    const off = { ...on, REACT_COMPILER: "0" };
    expect(reactCompilerOff(off)).toBe(true);
    expect(reactCompilerCompiles(abs("components/conversation/markdown.tsx"), off)).toBe(false);
    expect(reactCompilerBabelOptions(abs("components/conversation/markdown.tsx"), off)).toEqual({});
    expect(reactCompilerPathFilter(off).test(abs("components/conversation/markdown.tsx"))).toBe(false);
  });

  test("an empty list is off too", () => {
    expect(reactCompilerOff({ REACT_COMPILER_SOURCES: "" })).toBe(true);
  });

  test("REACT_COMPILER_SOURCES replaces the list, for measuring a candidate", () => {
    expect(reactCompilerSources({ REACT_COMPILER_SOURCES: "components/inbox/, hooks/useX.ts" })).toEqual(["components/inbox/", "hooks/useX.ts"]);
    expect(reactCompilerSources({})).toBe(REACT_COMPILER_SOURCES);
  });

  test("a listed file gets the compiler as its only babel plugin; any other file gets none, so the build skips babel for it", () => {
    const listed = reactCompilerBabelOptions(abs("components/conversation/markdown.tsx"), on) as { plugins: [string, object][] };
    expect(listed.plugins.map(([name]) => name)).toEqual([REACT_COMPILER_PLUGIN]);
    expect(reactCompilerBabelOptions(abs("components/MessageInput.tsx"), on)).toEqual({});
  });

  test("the path filter matches the list and nothing else", () => {
    const filter = reactCompilerPathFilter(on);
    expect(filter.test(abs("components/conversation/blocks/toolBlocks.tsx"))).toBe(true);
    expect(filter.test(abs("components/AssignmentBadge.tsx"))).toBe(true);
    expect(filter.test(abs("components/MessageInput.tsx"))).toBe(false);
    expect(filter.test(path.join(WEB, "node_modules/react/index.js"))).toBe(false);
  });
});

describe("compiling a file for bun", () => {
  const source = `
    export function Row({ title, onOpen }: { title: string; onOpen: (t: string) => void }) {
      const open = () => onOpen(title);
      return <button onClick={open}>{title}</button>;
    }
    export function Stamp({ at }: { at: number }) {
      "use no memo"; // reads the clock
      return <time>{Date.now() - at}</time>;
    }
  `;
  const out = compileForBun(abs("components/conversation/__fixture__.tsx"), source);

  test("a component is rewritten onto React's memo cache, with its types and JSX left for bun", () => {
    expect(out).toContain(`from "${REACT_COMPILER_RUNTIME}"`);
    expect(out).toMatch(/function Row\(t0\)/);
    expect(out).toContain("<button onClick=");
  });

  test('a component marked "use no memo" is left as written', () => {
    expect(out).toMatch(/function Stamp\(\{\s*at\s*\}: \{\s*at: number;?\s*\}\)/);
    expect(out).toContain("Date.now() - at");
  });
});

describe("bun's loader", () => {
  // Plain `bun test` must run the source as written, and REACT_COMPILER=1 must
  // really compile: a run that silently did neither would prove nothing.
  test(`a listed component loads ${reactCompilerActive ? "compiled, because REACT_COMPILER=1" : "as written, because REACT_COMPILER is not 1"}`, async () => {
    const { RowIcon } = await import("../components/conversation/blocks/ModernRow");
    expect(/\$\[\d+\]/.test(String(RowIcon))).toBe(reactCompilerActive);
  });

  test("a file off the list loads as written either way", async () => {
    const { cn } = await import("../lib/utils");
    expect(String(cn)).not.toContain("memo_cache_sentinel");
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OutputBundle } from "rollup";
import { uiFontHref, uiFontPreloadTag } from "./uiFontPreload";

const asset = (fileName: string) => ({ type: "asset", fileName, name: fileName, source: "" });
const bundle = (...names: string[]) => Object.fromEntries(names.map((n) => [n, asset(n)])) as unknown as OutputBundle;

/** Runs the tag's script against a stub document whose root has `classes`; returns the links it added. */
function run(script: string, classes: string[]): Array<Record<string, string>> {
  const added: Array<Record<string, string>> = [];
  const document = {
    documentElement: { classList: { contains: (c: string) => classes.includes(c) } },
    createElement: () => ({}) as Record<string, string>,
    head: { appendChild: (l: Record<string, string>) => added.push(l) },
  };
  new Function("document", script)(document);
  return added;
}

describe("the Modern interface face's preload", () => {
  const b = bundle(
    "assets/instrument-sans-latin-ext-wght-normal-Q1w2E3r4.woff2",
    "assets/instrument-sans-latin-wght-normal-Ab12_Cd3.woff2",
    "assets/newsreader-latin-wght-normal-Zz99Yy88.woff2",
  );

  test("names the hashed latin file under the build's base", () => {
    expect(uiFontHref(b, "/")).toBe("/assets/instrument-sans-latin-wght-normal-Ab12_Cd3.woff2");
    expect(uiFontHref(b, "https://cdn.example")).toBe("https://cdn.example/assets/instrument-sans-latin-wght-normal-Ab12_Cd3.woff2");
  });

  test("preloads only when <html> carries modern-style", () => {
    const tag = uiFontPreloadTag(b, "/");
    expect(tag?.tag).toBe("script");
    const script = String(tag!.children);
    expect(run(script, ["light", "modern-style"])).toEqual([
      { rel: "preload", as: "font", type: "font/woff2", crossOrigin: "", href: "/assets/instrument-sans-latin-wght-normal-Ab12_Cd3.woff2" },
    ]);
    expect(run(script, ["light"])).toEqual([]);
    expect(run(script, ["dark", "minimal-style"])).toEqual([]);
  });

  test("hints nothing when the bundle has no such face", () => {
    expect(uiFontPreloadTag(bundle("assets/index-abc.css"), "/")).toBeNull();
  });

  test("preloads the face the vendored font module bundles", () => {
    // If @platform/design stops bundling this file, the hint names nothing:
    // move the pattern with it.
    const fonts = readFileSync(join(import.meta.dir, "../../../platform/packages/design/fonts.js"), "utf8");
    expect(fonts).toContain('import "@fontsource-variable/instrument-sans/index.css"');
  });
});

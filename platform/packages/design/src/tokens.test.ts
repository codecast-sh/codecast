import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PALETTE, tokensCss } from "./index";

describe("tokens", () => {
  test("tokens.css is the rendering of tokens.ts", () => {
    const onDisk = readFileSync(join(import.meta.dir, "..", "tokens.css"), "utf8");
    expect(onDisk).toBe(tokensCss());
  });

  test("both themes define every colour", () => {
    expect(Object.keys(PALETTE.dark).sort()).toEqual(Object.keys(PALETTE.light).sort());
  });

  test("css names are kebab case under --pd-", () => {
    const css = tokensCss();
    expect(css).toContain("--pd-bg-raised: #fdfbf6;");
    expect(css).toContain("--pd-font-read:");
    expect(css).toContain("--pd-t-view:");
    expect(css).toContain(':root[data-theme="dark"], :root.dark {');
  });
});

import { describe, expect, test } from "bun:test";
import { ENTRY_PATH, needsTranspile } from "./files";
import { IMPORT_MAP } from "./runtime";
import { seedFiles } from "./seed";
import { transpile } from "./transpile";

function compiled(path: string, source: string): string {
  const out = transpile(path, source);
  if (!out.ok) throw new Error(out.error);
  return out.code;
}

/** Every module specifier a served file imports. */
function specifiers(code: string): string[] {
  return [...code.matchAll(/(?:^|[;\s])(?:import|export)\b[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)].map(
    (m) => m[1] ?? m[2],
  );
}

describe("transpile", () => {
  test("TSX gets both transforms: types gone, JSX on the automatic runtime", () => {
    const code = compiled("src/App.tsx", `type P = { n: number };\nexport const A = ({ n }: P) => <i>{n as number}</i>;`);
    expect(code).not.toContain("type P");
    expect(code).not.toContain(" as number");
    expect(code).toContain(`from "react/jsx-runtime"`);
  });

  test("modern syntax is left for the browser, not lowered", () => {
    const code = compiled("src/a.ts", "const x = a?.b ?? (await c);\nclass K { #p = 1 }");
    expect(code).toContain("a?.b ?? (await c)");
    expect(code).toContain("#p = 1");
  });

  test("production JSX carries no dev-only source info", () => {
    expect(compiled("src/A.jsx", "export default () => <b/>;")).not.toContain("__source");
  });

  test("files outside JSX/TS are never touched", () => {
    for (const path of ["index.html", "src/a.js", "src/s.css", "data.json"]) {
      expect(needsTranspile(path)).toBe(false);
      expect(compiled(path, "<b>{x}</b>")).toBe("<b>{x}</b>");
    }
  });
});

describe("served seed modules", () => {
  const files = seedFiles("Seed");
  const paths = new Set(files.map((f) => f.path));
  const served = files.filter((f) => f.path !== ENTRY_PATH && /\.(jsx?|tsx?)$/.test(f.path)).map((f) => ({ ...f, code: compiled(f.path, f.text) }));

  test("every bare import resolves through the import map", () => {
    const bare = served.flatMap((f) => specifiers(f.code)).filter((s) => !s.startsWith(".") && !s.startsWith("/"));
    expect(bare.length).toBeGreaterThan(0);
    for (const s of bare) expect(Object.keys(IMPORT_MAP.imports)).toContain(s);
  });

  test("every relative import names a file of the version", () => {
    for (const f of served) {
      for (const s of specifiers(f.code).filter((s) => s.startsWith("./"))) {
        const dir = f.path.slice(0, f.path.lastIndexOf("/") + 1);
        expect(paths.has(dir + s.slice(2))).toBe(true);
      }
    }
  });
});

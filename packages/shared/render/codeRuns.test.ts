import { describe, expect, test } from "bun:test";
import { splitCodeRuns } from "./codeRuns";

const code = (text: string) => splitCodeRuns(text).filter((r) => r.code).map((r) => r.text);

describe("splitCodeRuns", () => {
  test("joined runs give the text back", () => {
    for (const t of ["4a6e413b2c landed; live on web dp-12, waiting for backend.", "", "plain words", "tr-42 · Nightly audit"]) {
      expect(splitCodeRuns(t).map((r) => r.text).join("")).toBe(t);
    }
  });

  test("ids, session ids and hashes are code", () => {
    expect(code("4a6e413b2c landed; live on web dp-12, waiting for backend.")).toEqual(["4a6e413b2c", "dp-12"]);
    expect(code("tr-42 · Nightly audit")).toEqual(["tr-42"]);
    expect(code("@calling handed jx7abcd to Ashot")).toEqual(["jx7abcd"]);
    expect(code("Filed under ct-4102 and pl-88.")).toEqual(["ct-4102", "pl-88"]);
  });

  test("paths, files and flags are code", () => {
    expect(code("edited src/api/hooks.ts")).toEqual(["src/api/hooks.ts"]);
    expect(code("see packages/web/lib/stickyPrompt.ts:88 first")).toEqual(["packages/web/lib/stickyPrompt.ts:88"]);
    expect(code("open ~/code and ./a")).toEqual(["~/code", "./a"]);
    expect(code("update README.md")).toEqual(["README.md"]);
    expect(code("run it with --dry-run")).toEqual(["--dry-run"]);
  });

  test("words are not code", () => {
    expect(code("and/or 24/7 e-mail re-run deadbeef facade 1234567")).toEqual([]);
    expect(code("Checks failed")).toEqual([]);
    expect(code("Usage limit · resets 11:30pm")).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { parseQuickOpenQuery, quickOpenIndex, rankFiles } from "./quickOpen";

const table = (paths: string[]) => Object.fromEntries(paths.map((p) => [p, { dir: false }]));

describe("parseQuickOpenQuery", () => {
  test("line and column ride after the name", () => {
    expect(parseQuickOpenQuery("store:42")).toEqual({ text: "store", line: 42, column: undefined });
    expect(parseQuickOpenQuery("store.ts:42:5")).toEqual({ text: "store.ts", line: 42, column: 5 });
    expect(parseQuickOpenQuery(":12")).toEqual({ text: "", line: 12, column: undefined });
    expect(parseQuickOpenQuery("plain")).toEqual({ text: "plain" });
  });
});

describe("rankFiles", () => {
  const targets = quickOpenIndex(
    table(["src/store/index.ts", "store/notes.md", "packages/web/store/codeStore.ts", "lib/codeStoreHelpers/x.ts", "README.md", "docs/store.md"]),
  );

  test("a filename match beats a folder match", () => {
    const top = rankFiles(targets, "codestore", [])[0];
    expect(top.target.path).toBe("packages/web/store/codeStore.ts");
    const store = rankFiles(targets, "store", []).map((r) => r.target.path);
    expect(store.indexOf("docs/store.md")).toBeLessThan(store.indexOf("src/store/index.ts"));
  });

  test("a query with a slash matches paths", () => {
    expect(rankFiles(targets, "web/store", [])[0].target.path).toBe("packages/web/store/codeStore.ts");
  });

  test("recent files lead an empty query and lift near ties", () => {
    expect(rankFiles(targets, "", ["README.md", "docs/store.md"]).slice(0, 2).map((r) => r.target.path)).toEqual(["README.md", "docs/store.md"]);
    const lifted = rankFiles(targets, "store.md", ["store/notes.md"]);
    expect(lifted[0].target.path).toBe("docs/store.md");
  });

  test("20k files rank in under 16ms per keystroke", () => {
    const words = ["app", "lib", "store", "components", "code", "vault", "editor", "hooks", "utils", "server", "client", "shared"];
    const exts = [".ts", ".tsx", ".md", ".json", ".css", ".go", ".py"];
    const paths: string[] = [];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    while (paths.length < 20_000) {
      const depth = 1 + rnd(5);
      const parts = Array.from({ length: depth }, () => words[rnd(words.length)] + (rnd(3) ? "" : rnd(100)));
      paths.push(`${parts.join("/")}/${words[rnd(words.length)]}${words[rnd(words.length)]}${rnd(1000)}${exts[rnd(exts.length)]}`);
    }
    const big = quickOpenIndex(table(paths));
    const recent = paths.slice(0, 20);
    // Warm the JIT the way a session would after the first few keys.
    for (const q of ["s", "st", "sto"]) rankFiles(big, q, recent);
    const queries = ["c", "co", "cod", "code", "codes", "codest", "codesto", "codestor", "codestore", "vault/ed", "edhook", "zzzq"];
    const times: number[] = [];
    for (const q of queries) {
      const t0 = performance.now();
      rankFiles(big, q, recent);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)];
    const max = times[times.length - 1];
    console.log(`quick open 20k: p50 ${p50.toFixed(2)}ms, max ${max.toFixed(2)}ms`);
    expect(max).toBeLessThan(16);
  });
});

describe("quickOpenIndex", () => {
  const paths = Array.from({ length: 20_000 }, (_, i) => `pkg${i % 40}/dir${i % 300}/file${i}.ts`);
  const rows = (ps: string[], mtime: number) => Object.fromEntries(ps.map((p) => [p, { dir: false, mtime }]));

  test("a table copied with only row changes gives back the same index", () => {
    const first = quickOpenIndex(rows(paths, 1));
    const t0 = performance.now();
    const copy = quickOpenIndex(rows(paths, 2));
    const ms = performance.now() - t0;
    console.log(`quick open 20k: index after a table copy ${ms.toFixed(2)}ms`);
    expect(copy).toBe(first);
  });

  test("a new path prepares only itself, and the first rank after it stays under a frame", () => {
    // One file coming and going first, the way a session's index has been used.
    quickOpenIndex(rows([...paths, "pkg0/warm.ts"], 1));
    const first = quickOpenIndex(rows(paths, 1));
    rankFiles(first, "fil", []);
    const table = rows([...paths, "pkg1/new/fresh.ts"], 3);
    const t0 = performance.now();
    const grown = quickOpenIndex(table);
    const ranked = rankFiles(grown, "fresh", []);
    const ms = performance.now() - t0;
    console.log(`quick open 20k: index + first rank after a new file ${ms.toFixed(2)}ms`);
    expect(grown).not.toBe(first);
    expect(grown.find((t) => t.path === paths[5])).toBe(first.find((t) => t.path === paths[5]));
    expect(ranked[0].target.path).toBe("pkg1/new/fresh.ts");
    expect(ms).toBeLessThan(16);
  });
});

import { describe, expect, test } from "bun:test";

// Each import with a fresh query string is a new page load: a new module with
// an empty in-memory registry, reading the same localStorage.
async function loadPage(n: number) {
  return (await import(`../labelColors?page=${n}`)) as typeof import("../labelColors");
}

describe("label colors", () => {
  test("a name keeps its color across page loads that see names in a different order", async () => {
    const store = new Map<string, string>();
    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    };
    try {
      const names = ["codecast", "family", "union-mobile", "chief", "anchor", "growth", "mail"];
      const first = await loadPage(1);
      const before = Object.fromEntries(names.map((n) => [n, first.getLabelColor(n).dot]));
      const second = await loadPage(2);
      for (const n of [...names].reverse()) expect(second.getLabelColor(n).dot).toBe(before[n]);
      // Probing still keeps the first names on distinct colors.
      expect(new Set(Object.values(before)).size).toBe(names.length);
    } finally {
      delete (globalThis as any).window;
    }
  });
});

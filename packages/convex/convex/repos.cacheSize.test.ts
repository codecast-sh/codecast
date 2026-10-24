import { describe, expect, test } from "bun:test";
import { upsertCache } from "./repos";
import { makeFakeDb } from "./testDb";

// A blob just under the 1 MiB fetch cap became a 1.28 MiB row once
// JSON-encoded, over Convex's document limit, so every view of the file
// refetched it and failed the write (codecast-sh/codecast, 2026-10-23).
describe("repo cache rows fit in a document", () => {
  const write = (db: any, content: string) =>
    (upsertCache as any)._handler({ db }, { team_id: "team", repository: "o/r", kind: "blob", ref: "main", path: "big.json", sha: "abc", content, size: 1_000_000 });

  test("an oversized blob is stored as a truncated answer", async () => {
    const db = makeFakeDb({ repo_cache: [] });
    const text = '{"k": "v"}\n'.repeat(95_000); // ~1 MB raw, ~1.3 MB once encoded
    await write(db, JSON.stringify({ content: text, size: 1_000_000, truncated: false, sha: "abc" }));
    const row = db._tables.repo_cache[0];
    expect(new TextEncoder().encode(row.content).length).toBeLessThan(1024 * 1024);
    expect(row.truncated).toBe(true);
    expect(JSON.parse(row.content)).toEqual({ content: "", size: 1_000_000, truncated: true, sha: "abc" });
  });

  test("a blob that fits is stored as given", async () => {
    const db = makeFakeDb({ repo_cache: [] });
    const content = JSON.stringify({ content: "hello\n", size: 6, truncated: false, sha: "abc" });
    await write(db, content);
    expect(db._tables.repo_cache[0].content).toBe(content);
  });
});

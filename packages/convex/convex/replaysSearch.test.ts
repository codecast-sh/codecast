// `cast replay ls` over the store (replaysSearch.ts): every page read, every match counted.
import { describe, expect, test } from "bun:test";
import { patchReplay } from "./lib/replayIndex";
import { REPLAY_SEARCH_PAGE } from "./lib/replayReads";
import { ensureReplay } from "./lib/replayWrites";
import { importStatus, search } from "./replaysSearch";
import { h, teamSource, world } from "./replays.testkit";

const NOW = Date.now();

describe("search (cast replay ls)", () => {
  const scope = { workspace: "team", team_id: "team_1" };
  test("pages through every recording: matches past one page are all found and counted", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const n = REPLAY_SEARCH_PAGE + 50;
    for (let i = 0; i < n; i++) {
      // An import opens rows uncapped, as the bulk import does.
      const row = (await ensureReplay(w.internalCtx, source, `r${i}`, NOW, { capped: false }))!;
      await patchReplay(w.internalCtx, row, {
        started_at: NOW - i * 60_000,
        url: i % 7 === 0 ? `https://u.example.com/book/intro/t${i}` : "https://u.example.com/",
        // A later visit to the page counts too: shape.paths.
        ...(i === 3 ? { shape: { v: 3, active_ms: 9_000, pages: 2, rage_clicks: 0, strip: "", marks: [], paths: ["/", "/book/manage/x"] } } : {}),
        user: i === 5 ? { email: "Ada@Example.com", id: "d-5" } : { id: `d-${i}` },
        counts: { clicks: 0, errors: 0, failed_requests: i === 14 ? 2 : 0 },
      });
    }
    const all = async (args: Record<string, unknown>) => {
      const rows: any[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (;;) {
        const page = await h(search)(w.as("u1"), { ...scope, ...args, cursor });
        rows.push(...page.rows);
        pages++;
        if (page.done) return { rows, pages };
        cursor = page.cursor;
      }
    };
    const intro = await all({ url: "/book/intro" });
    expect(intro.pages).toBeGreaterThan(1);
    expect(intro.rows).toHaveLength(Math.ceil(n / 7));
    expect(intro.rows.at(-1).url).toContain("/book/intro/");
    expect((await all({ url: "*/book/intro/t7" })).rows.map((r: any) => r.short_id)).toHaveLength(1);
    expect((await all({ url: "/book/manage" })).rows).toHaveLength(1);
    expect((await all({ user: "ada@example.com" })).rows).toHaveLength(1);
    expect((await all({ user: "d-9" })).rows).toHaveLength(1);
    expect((await all({ failing: true, url: "/book/intro" })).rows).toHaveLength(1);
    expect((await all({ since: NOW - 10 * 60_000 - 1, until: NOW - 2 * 60_000 + 1 })).rows).toHaveLength(9);
    const status = await h(importStatus)(w.as("u1"), { ...scope, source: "shop" });
    expect(status.stored.oldest_at).toBe(NOW - (n - 1) * 60_000);
    expect(status.stored.newest_at).toBe(NOW);
  });
});


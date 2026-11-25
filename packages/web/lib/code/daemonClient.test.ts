import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CodeSearchEvent } from "@codecast/shared/contracts";
import { fetchGitBase, searchCode } from "./daemonClient";

const events: CodeSearchEvent[] = [
  { type: "file", path: "src/a.ts", lines: [{ line: 1, text: "const needle = 1; // é", ranges: [{ start: 6, end: 12 }] }] },
  { type: "file", path: "src/b.ts", lines: [{ line: 4, text: "needle", ranges: [{ start: 0, end: 6 }] }] },
  { type: "done", files: 2, matches: 2, truncated: false, elapsed_ms: 3, engine: "rg" },
];

let server: ReturnType<typeof Bun.serve>;
let lastUrl = "";
let cancelled = false;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      lastUrl = req.url;
      const url = new URL(req.url);
      if (url.pathname === "/code/git/base") return Response.json({ error: "unknown ref" }, { status: 404 });
      const bytes = new TextEncoder().encode(events.map((e) => JSON.stringify(e) + "\n").join(""));
      const hold = url.searchParams.get("q") === "hold";
      return new Response(
        new ReadableStream({
          async start(controller) {
            // Chunks that split lines (and a multi-byte character) mid-way.
            for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
            if (!hold) controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
    },
  });
});

afterAll(() => server.stop(true));

const ep = () => ({ port: server.port!, token: "t", deviceId: "d", tmux: false });

describe("searchCode", () => {
  test("parses a stream split anywhere and sends the flags as the daemon reads them", async () => {
    const got: CodeSearchEvent[] = [];
    for await (const e of searchCode(ep(), "v1", "needle", { caseSensitive: true, include: ["src", "*.ts"], regex: false })) got.push(e);
    expect(got).toEqual(events);
    const params = new URL(lastUrl).searchParams;
    expect(Object.fromEntries(params)).toEqual({ vault: "v1", q: "needle", case: "1", include: "src,*.ts" });
  });

  test("leaving the loop early cancels the stream", async () => {
    cancelled = false;
    for await (const e of searchCode(ep(), "v1", "hold")) {
      expect(e.type).toBe("file");
      break;
    }
    for (let i = 0; i < 50 && !cancelled; i++) await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).toBe(true);
  });
});

test("a refused request carries the status and the daemon's reason", async () => {
  await expect(fetchGitBase(ep(), "v1", "a.ts", "nope")).rejects.toMatchObject({ status: 404, message: "git base: 404 unknown ref" });
});

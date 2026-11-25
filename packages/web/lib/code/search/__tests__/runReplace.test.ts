// One replace at a time: a second trigger while the first is still writing
// must not plan against text the first already changed.
import { describe, expect, test } from "bun:test";
import type { DiskVersion } from "../../buffers";
import { EMPTY_PROJECT_QUERY } from "../query";
import { replaceRunning, runReplace } from "../runReplace";
import type { WriteBackIO } from "../writeBack";

function slowDisk(files: Record<string, string>) {
  const disk = new Map(Object.entries(files).map(([p, c]) => [p, { content: c, etag: "e0" }]));
  let n = 0;
  const io: WriteBackIO = {
    buffer: () => undefined,
    read: async (path): Promise<DiskVersion | null> => {
      const f = disk.get(path);
      return f ? { content: f.content, etag: f.etag, mtime: 1 } : null;
    },
    write: async (path, content) => {
      // The save round trip: long enough for a second click to land.
      await new Promise((r) => setTimeout(r, 20));
      const etag = `e${++n}`;
      disk.set(path, { content, etag });
      return { etag, mtime: n, size: content.length };
    },
    adopt: () => {},
    save: async () => "saved",
  } as WriteBackIO;
  return { io, disk };
}

describe("runReplace", () => {
  test("a second run while the first writes is refused, so a replacement that still matches lands once", async () => {
    const { io, disk } = slowDisk({ "a.ts": "foo bar\n" });
    const req = {
      vaultId: "v",
      query: { ...EMPTY_PROJECT_QUERY, text: "foo" },
      replacement: "foo2",
      preserveCase: false,
      targets: new Map([["a.ts", [{ line: 1, column: 0 }]]]),
      io,
    };
    const first = runReplace(req);
    expect(replaceRunning()).toBe(true);
    const second = await runReplace(req);
    expect(second).toBeNull();
    const outcomes = await first;
    expect(outcomes?.map((o) => o.status)).toEqual(["saved"]);
    expect(disk.get("a.ts")!.content).toBe("foo2 bar\n");
    expect(replaceRunning()).toBe(false);
  });

  test("the lock is released when a run fails, and the next run goes through", async () => {
    const { io, disk } = slowDisk({ "a.ts": "foo\n" });
    const failing: WriteBackIO = { ...io, write: async () => Promise.reject(new Error("boom")) };
    const base = { vaultId: "v", query: { ...EMPTY_PROJECT_QUERY, text: "foo" }, replacement: "bar", preserveCase: false, targets: new Map([["a.ts", [{ line: 1, column: 0 }]]]) };
    const failed = await runReplace({ ...base, io: failing });
    expect(failed?.[0].status).toBe("error");
    expect(replaceRunning()).toBe(false);
    const ok = await runReplace({ ...base, io });
    expect(ok?.[0].status).toBe("saved");
    expect(disk.get("a.ts")!.content).toBe("bar\n");
  });
});

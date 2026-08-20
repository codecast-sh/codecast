import { describe, expect, test } from "bun:test";
import { applyEditVersion } from "./artifactsHttp";
import { MAX_ARTIFACT_BYTES } from "./artifacts";

async function sha256Hex(s: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type AssetSeed = { path: string; storage_id: string; content_type: string; size: number; body: string };

// Hand-rolled action ctx in the style of artifacts.test.ts: just enough
// storage + runQuery/runMutation surface for applyEditVersion, recording
// every blob store/delete so assertions can inspect ordering.
function makeEditCtx(opts: { assets?: AssetSeed[] } = {}) {
  let n = 0;
  const stored: Array<{ id: string; type: string; blob: Blob }> = [];
  const storageDeletes: string[] = [];
  const queries: Array<Record<string, any>> = [];
  const mutations: Array<Record<string, any>> = [];
  const blobsById = new Map<string, Blob>();
  for (const a of opts.assets ?? []) blobsById.set(a.storage_id, new Blob([a.body], { type: a.content_type }));
  const ctx = {
    storage: {
      store: async (blob: Blob) => {
        const id = `st_${n++}`;
        stored.push({ id, type: blob.type, blob });
        blobsById.set(id, blob);
        return id;
      },
      get: async (id: string) => blobsById.get(id) ?? null,
      delete: async (id: string) => {
        storageDeletes.push(id);
      },
    },
    runQuery: async (_fn: unknown, args: Record<string, any>) => {
      queries.push(args);
      return (opts.assets ?? []).map(({ body: _body, ...row }) => row);
    },
    runMutation: async (_fn: unknown, args: Record<string, any>) => {
      mutations.push(args);
      return { version: 8 };
    },
  };
  return { ctx: ctx as never as Parameters<typeof applyEditVersion>[0], stored, storageDeletes, queries, mutations };
}

const baseArtifact = { _id: "a1" as never, version: 3, title: "T", content_hash: "old" };

describe("applyEditVersion", () => {
  test("html edit stores one doc blob and appends a version", async () => {
    const { ctx, stored, storageDeletes, mutations } = makeEditCtx();
    const out = await applyEditVersion(ctx, { ...baseArtifact }, "<h1>hi</h1>", "link editor");
    expect(out).toEqual({ version: 8 });
    expect(stored).toHaveLength(1);
    expect(stored[0].type).toBe("text/html; charset=utf-8");
    expect(storageDeletes).toEqual([]);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      artifact_id: "a1",
      storage_id: "st_0",
      size: new TextEncoder().encode("<h1>hi</h1>").byteLength,
      kind: "html",
      content_hash: await sha256Hex("<h1>hi</h1>"),
      edited_by: "link editor",
      assets: [],
    });
    expect(mutations[0].source_storage_id).toBeUndefined();
  });

  test("markdown edit stores the raw source blob and the rendered doc", async () => {
    const { ctx, stored, mutations } = makeEditCtx();
    const out = await applyEditVersion(ctx, { ...baseArtifact, kind: "markdown" }, "# Title", undefined);
    expect(out).toEqual({ version: 8 });
    expect(stored.map((s) => s.type)).toEqual(["text/markdown; charset=utf-8", "text/html; charset=utf-8"]);
    expect(await stored[0].blob.text()).toBe("# Title");
    expect(await stored[1].blob.text()).toContain("<h1");
    // The hash is over the SOURCE, so a rendering tweak never bumps versions.
    expect(mutations[0]).toMatchObject({
      kind: "markdown",
      source_storage_id: "st_0",
      storage_id: "st_1",
      content_hash: await sha256Hex("# Title"),
      edited_by: undefined,
    });
  });

  test("unchanged markdown short-circuits AFTER storing the source blob, then deletes it", async () => {
    const content = "# Same";
    const { ctx, stored, storageDeletes, mutations } = makeEditCtx();
    const out = await applyEditVersion(
      ctx,
      { ...baseArtifact, kind: "markdown", content_hash: await sha256Hex(content) },
      content,
      "link editor",
    );
    expect(out).toEqual({ version: 3, unchanged: true });
    // The source blob is stored before the hash comparison and cleaned up on
    // the short-circuit; the doc blob is never stored.
    expect(stored).toHaveLength(1);
    expect(stored[0].type).toBe("text/markdown; charset=utf-8");
    expect(storageDeletes).toEqual(["st_0"]);
    expect(mutations).toHaveLength(0);
  });

  test("unchanged html short-circuits with nothing stored or deleted", async () => {
    const { ctx, stored, storageDeletes, mutations } = makeEditCtx();
    const out = await applyEditVersion(ctx, { ...baseArtifact, content_hash: await sha256Hex("<p>x</p>") }, "<p>x</p>", undefined);
    expect(out).toEqual({ version: 3, unchanged: true });
    expect(stored).toHaveLength(0);
    expect(storageDeletes).toEqual([]);
    expect(mutations).toHaveLength(0);
  });

  test("bundle edit carries assets forward as blob COPIES with distinct storage ids", async () => {
    const assets: AssetSeed[] = [
      { path: "a.css", storage_id: "asset_a", content_type: "text/css", size: 6, body: "body{}" },
      { path: "b.js", storage_id: "asset_b", content_type: "text/javascript", size: 3, body: "x=1" },
    ];
    const { ctx, queries, mutations } = makeEditCtx({ assets });
    const out = await applyEditVersion(ctx, { ...baseArtifact, kind: "bundle" }, "<html>new</html>", undefined);
    expect(out).toEqual({ version: 8 });
    expect(queries).toEqual([{ artifact_id: "a1", version: 3 }]);
    const copied = mutations[0].assets as Array<{ path: string; storage_id: string; content_type: string; size: number }>;
    expect(copied).toEqual([
      { path: "a.css", storage_id: "st_1", content_type: "text/css", size: 6 },
      { path: "b.js", storage_id: "st_2", content_type: "text/javascript", size: 3 },
    ]);
    const ids = copied.map((a) => a.storage_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("asset_a");
    expect(ids).not.toContain("asset_b");
  });

  test("a bundle never takes the unchanged short-circuit", async () => {
    const content = "<html>same</html>";
    const { ctx, mutations } = makeEditCtx();
    const out = await applyEditVersion(
      ctx,
      { ...baseArtifact, kind: "bundle", content_hash: await sha256Hex(content) },
      content,
      undefined,
    );
    expect(out).toEqual({ version: 8 });
    expect(mutations).toHaveLength(1);
  });

  test("oversized content errors before any doc blob is stored", async () => {
    const { ctx, stored, mutations } = makeEditCtx();
    const out = await applyEditVersion(ctx, { ...baseArtifact }, "a".repeat(MAX_ARTIFACT_BYTES + 1), undefined);
    expect(out).toEqual({ error: "Content exceeds the 8MB limit" });
    expect(stored).toHaveLength(0);
    expect(mutations).toHaveLength(0);
  });
});

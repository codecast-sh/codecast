import { describe, expect, test } from "bun:test";
import { newSlug, upsertFromPublish, deleteFromCLI, brandArtifactHtml } from "./artifacts";

// Minimal hand-rolled ctx in the style of docs.test.ts: enough db surface for
// the handlers under test, recording writes so assertions can inspect them.
function makeCtx(rows: Array<Record<string, any>>, opts: { tokenUser?: string } = {}) {
  const byId = new Map(rows.map((r) => [r._id as string, r]));
  const patches: Array<{ id: string; patch: Record<string, any> }> = [];
  const inserts: Array<Record<string, any>> = [];
  const deletes: string[] = [];
  const storageDeletes: string[] = [];

  const query = (_table: string) => {
    let filtered = rows.filter((r) => !deletes.includes(r._id));
    return {
      withIndex(_name: string, cb: (q: any) => any) {
        const eqs: Record<string, any> = {};
        const q = {
          eq(field: string, value: any) {
            eqs[field] = value;
            return q;
          },
        };
        cb(q);
        filtered = filtered.filter((r) => Object.entries(eqs).every(([k, v]) => r[k] === v));
        return {
          first: async () => filtered[0] ?? null,
          collect: async () => filtered,
        };
      },
    };
  };

  return {
    ctx: {
      db: {
        query,
        get: async (id: string) => byId.get(id) ?? null,
        patch: async (id: string, patch: Record<string, any>) => {
          patches.push({ id, patch });
          Object.assign(byId.get(id)!, patch);
        },
        insert: async (_table: string, doc: Record<string, any>) => {
          const _id = `art_${inserts.length}`;
          inserts.push({ _id, ...doc });
          rows.push({ _id, ...doc });
          return _id;
        },
        delete: async (id: string) => {
          deletes.push(id);
        },
      },
      storage: {
        delete: async (id: string) => {
          storageDeletes.push(id);
        },
      },
    },
    patches,
    inserts,
    deletes,
    storageDeletes,
  };
}

const existingRow = {
  _id: "a1",
  slug: "abcdefghijkl",
  user_id: "u1",
  title: "Old title",
  source_path: "/tmp/report.html",
  storage_id: "st_old",
  size: 100,
  version: 3,
  created_at: 1000,
  updated_at: 2000,
};

describe("newSlug", () => {
  test("is 12 chars of url-safe base62", () => {
    for (let i = 0; i < 20; i++) {
      expect(newSlug()).toMatch(/^[A-Za-z0-9]{12}$/);
    }
  });
});

describe("upsertFromPublish", () => {
  test("republishing the same path updates in place and snapshots the old version", async () => {
    const { ctx, patches, storageDeletes, inserts } = makeCtx([{ ...existingRow }]);
    const result = await (upsertFromPublish as any)._handler(ctx, {
      user_id: "u1",
      storage_id: "st_new",
      title: "New title",
      size: 200,
      source_path: "/tmp/report.html",
      content_hash: "hash_new",
    });
    expect(result.slug).toBe("abcdefghijkl");
    expect(result.updated).toBe(true);
    expect(result.version).toBe(4);
    expect(result.url).toContain("/a/abcdefghijkl");
    // The superseded blob survives as a history row instead of being deleted.
    expect(storageDeletes).toEqual([]);
    expect(inserts.length).toBe(1);
    expect(inserts[0]).toMatchObject({
      artifact_id: "a1",
      version: 3,
      title: "Old title",
      storage_id: "st_old",
      size: 100,
      published_at: 2000,
    });
    expect(patches[0].patch).toMatchObject({
      storage_id: "st_new",
      title: "New title",
      size: 200,
      version: 4,
      content_hash: "hash_new",
    });
  });

  test("byte-identical republish is a no-op that drops the new blob", async () => {
    const { ctx, patches, storageDeletes, inserts } = makeCtx([
      { ...existingRow, content_hash: "same" },
    ]);
    const result = await (upsertFromPublish as any)._handler(ctx, {
      user_id: "u1",
      storage_id: "st_new",
      title: "New title",
      size: 100,
      source_path: "/tmp/report.html",
      content_hash: "same",
    });
    expect(result.version).toBe(3);
    expect(result.unchanged).toBe(true);
    expect(storageDeletes).toEqual(["st_new"]);
    expect(patches.length).toBe(0);
    expect(inserts.length).toBe(0);
  });

  test("history beyond the cap prunes the oldest snapshots", async () => {
    const versionRows = Array.from({ length: 21 }, (_, i) => ({
      _id: `v${i + 1}`,
      artifact_id: "a1",
      version: i + 1,
      title: `T${i + 1}`,
      storage_id: `st_v${i + 1}`,
      size: 10,
      published_at: 1000 + i,
    }));
    const { ctx, deletes, storageDeletes } = makeCtx([
      { ...existingRow, version: 22 },
      ...versionRows,
    ]);
    await (upsertFromPublish as any)._handler(ctx, {
      user_id: "u1",
      storage_id: "st_new",
      title: "New",
      size: 5,
      source_path: "/tmp/report.html",
      content_hash: "h",
    });
    // 21 existing + 1 new snapshot = 22 → two oldest pruned down to the cap of 20.
    expect(deletes).toEqual(["v1", "v2"]);
    expect(storageDeletes).toEqual(["st_v1", "st_v2"]);
  });

  test("a different user's identical path creates a separate artifact", async () => {
    const { ctx, inserts, storageDeletes } = makeCtx([{ ...existingRow }]);
    const result = await (upsertFromPublish as any)._handler(ctx, {
      user_id: "u2",
      storage_id: "st_new",
      title: "Mine",
      size: 50,
      source_path: "/tmp/report.html",
    });
    expect(result.updated).toBe(false);
    expect(result.version).toBe(1);
    expect(inserts.length).toBe(1);
    expect(storageDeletes.length).toBe(0);
  });

  test("force_new mints a fresh slug even when the path matches", async () => {
    const { ctx, inserts } = makeCtx([{ ...existingRow }]);
    const result = await (upsertFromPublish as any)._handler(ctx, {
      user_id: "u1",
      storage_id: "st_new",
      title: "Again",
      size: 10,
      source_path: "/tmp/report.html",
      force_new: true,
    });
    expect(result.updated).toBe(false);
    expect(result.slug).not.toBe("abcdefghijkl");
    expect(inserts.length).toBe(1);
  });

  test("no source_path always creates", async () => {
    const { ctx, inserts } = makeCtx([{ ...existingRow }]);
    const result = await (upsertFromPublish as any)._handler(ctx, {
      user_id: "u1",
      storage_id: "st_new",
      title: "Pathless",
      size: 10,
    });
    expect(result.updated).toBe(false);
    expect(inserts.length).toBe(1);
  });
});

describe("deleteFromCLI", () => {
  // verifyApiToken reads api_tokens through the same hand-rolled query surface:
  // seed a token row whose hashed lookup can't work here, so instead stub at the
  // db level by seeding the artifact rows AND intercepting the token query.
  function ctxWithAuth(rows: Array<Record<string, any>>) {
    const made = makeCtx(rows);
    const origQuery = made.ctx.db.query;
    made.ctx.db.query = (table: string) => {
      if (table === "api_tokens") {
        return {
          withIndex: () => ({
            first: async () => ({ _id: "tok1", user_id: "u1" }),
            collect: async () => [{ _id: "tok1", user_id: "u1" }],
          }),
        } as any;
      }
      return origQuery(table);
    };
    return made;
  }

  test("deletes by slug and removes the blob", async () => {
    const { ctx, deletes, storageDeletes } = ctxWithAuth([{ ...existingRow }]);
    const result = await (deleteFromCLI as any)._handler(ctx, { api_token: "t", target: "abcdefghijkl" });
    expect(result.deleted.slug).toBe("abcdefghijkl");
    expect(deletes).toEqual(["a1"]);
    expect(storageDeletes).toEqual(["st_old"]);
  });

  test("delete also removes history rows and their blobs", async () => {
    const past = { _id: "v1", artifact_id: "a1", version: 2, title: "Old", storage_id: "st_v2", size: 10, published_at: 1500 };
    const { ctx, deletes, storageDeletes } = ctxWithAuth([{ ...existingRow }, past]);
    await (deleteFromCLI as any)._handler(ctx, { api_token: "t", target: "abcdefghijkl" });
    expect(deletes.sort()).toEqual(["a1", "v1"]);
    expect(storageDeletes.sort()).toEqual(["st_old", "st_v2"]);
  });

  test("deletes by path basename when unambiguous", async () => {
    const { ctx, deletes } = ctxWithAuth([{ ...existingRow }]);
    const result = await (deleteFromCLI as any)._handler(ctx, { api_token: "t", target: "report.html" });
    expect(result.deleted.slug).toBe("abcdefghijkl");
    expect(deletes).toEqual(["a1"]);
  });

  test("ambiguous basename returns an error naming the candidates", async () => {
    const second = { ...existingRow, _id: "a2", slug: "zzzzzzzzzzzz", source_path: "/home/x/report.html" };
    const { ctx, deletes } = ctxWithAuth([{ ...existingRow }, second]);
    const result = await (deleteFromCLI as any)._handler(ctx, { api_token: "t", target: "report.html" });
    expect(result.error).toContain("matches 2 artifacts");
    expect(result.error).toContain("zzzzzzzzzzzz");
    expect(deletes.length).toBe(0);
  });

  test("no match returns an error", async () => {
    const { ctx } = ctxWithAuth([{ ...existingRow }]);
    const result = await (deleteFromCLI as any)._handler(ctx, { api_token: "t", target: "nope" });
    expect(result.error).toContain("No artifact matches");
  });
});

describe("brandArtifactHtml", () => {
  const opts = { title: "Q3 <Report>", author: "Ashot", updatedAt: 1700000000000, shareUrl: "https://codecast.sh/a/x1" };

  test("injects the bar after <body> and og meta after <head>", () => {
    const out = brandArtifactHtml("<html><head><title>T</title></head><body class=\"x\"><h1>hi</h1></body></html>", opts);
    expect(out.indexOf("og:title")).toBeGreaterThan(out.indexOf("<head>"));
    expect(out.indexOf("og:title")).toBeLessThan(out.indexOf("<title>"));
    expect(out.indexOf("__cc_bar")).toBeGreaterThan(out.indexOf("<body"));
    expect(out.indexOf('id="__cc_bar"')).toBeLessThan(out.indexOf("<h1>"));
    expect(out).toContain("<title>T</title>");
  });

  test("escapes the title everywhere it appears", () => {
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).toContain("Q3 &lt;Report&gt;");
    expect(out).not.toContain("Q3 <Report>");
  });

  test("prepends the bar when there is no body tag", () => {
    const out = brandArtifactHtml("<div>fragment</div>", opts);
    expect(out.startsWith("\n<style id=\"__cc_style\">")).toBe(true);
    expect(out).toContain("<div>fragment</div>");
    expect(out).not.toContain("og:title");
  });

  test("carries the share url into the copy button", () => {
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).toContain('data-url="https://codecast.sh/a/x1"');
  });

  test("without metaUrl there is no version chip and no polling config", () => {
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).not.toContain('id="__cc_ver"');
    expect(out).toContain('"metaUrl":""');
  });

  test("with metaUrl renders the version chip and embeds versions for the script", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      version: 5,
      currentVersion: 5,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
    });
    expect(out).toContain('id="__cc_ver"');
    expect(out).toContain(">v5 ▾<");
    expect(out).toContain('"metaUrl":"https://convex.codecast.sh/cli/a/x1?meta=1"');
    expect(out).toContain('"version":5');
    expect(out).toContain('"currentVersion":5');
    expect(out).not.toContain('id="__cc_latest"');
  });

  test("an old version shows the old marker and the latest link", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      version: 2,
      currentVersion: 5,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
    });
    expect(out).toContain(">v2 (old) ▾<");
    expect(out).toContain('id="__cc_latest"');
  });
});

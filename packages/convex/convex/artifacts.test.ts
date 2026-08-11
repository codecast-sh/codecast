import { describe, expect, test } from "bun:test";
import {
  newSlug,
  newSecret,
  upsertFromPublish,
  deleteFromCLI,
  lineDiff,
  accessSummary,
  submitComments,
  deliverPendingComments,
} from "./artifacts";
import { brandArtifactHtml } from "./artifactPages";
import { normalizeAssetPath } from "./artifactsHttp";

// Minimal hand-rolled ctx in the style of docs.test.ts: enough db surface for
// the handlers under test, recording writes so assertions can inspect them.
function makeCtx(rows: Array<Record<string, any>>, opts: { tokenUser?: string } = {}) {
  const byId = new Map(rows.map((r) => [r._id as string, r]));
  const patches: Array<{ id: string; patch: Record<string, any> }> = [];
  const inserts: Array<Record<string, any>> = [];
  const deletes: string[] = [];
  const storageDeletes: string[] = [];
  // Sub-mutations (notificationRouter.emit) recorded by args only.
  const mutations: Array<Record<string, any>> = [];

  const query = (_table: string) => {
    let filtered = rows.filter((r) => !deletes.includes(r._id) && (!r._table || r._table === _table));
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
        get: async (id: string) => byId.get(id) ?? rows.find((r) => r._id === id) ?? null,
        patch: async (id: string, patch: Record<string, any>) => {
          patches.push({ id, patch });
          const row = byId.get(id) ?? rows.find((r) => r._id === id);
          Object.assign(row!, patch);
        },
        insert: async (_table: string, doc: Record<string, any>) => {
          const _id = `art_${inserts.length}`;
          inserts.push({ _id, table: _table, ...doc });
          rows.push({ _id, _table, ...doc });
          return _id;
        },
        delete: async (id: string) => {
          deletes.push(id);
        },
        normalizeId: (_table: string, id: string) =>
          rows.some((r) => r._id === id && r._table === _table) ? id : null,
      },
      storage: {
        delete: async (id: string) => {
          storageDeletes.push(id);
        },
      },
      runMutation: async (_fn: unknown, args: Record<string, any>) => {
        mutations.push(args);
      },
    },
    patches,
    inserts,
    deletes,
    storageDeletes,
    mutations,
  };
}

const existingRow = {
  _table: "artifacts",
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

  test("newSecret is longer than a slug", () => {
    expect(newSecret()).toMatch(/^[A-Za-z0-9]{20}$/);
  });
});

describe("lineDiff", () => {
  test("equal texts produce only eq ops", () => {
    const { ops, truncated } = lineDiff("a\nb\nc", "a\nb\nc");
    expect(truncated).toBe(false);
    expect(ops.every((o) => o.t === "eq")).toBe(true);
    expect(ops.length).toBe(3);
  });

  test("a changed middle line yields del+add with stable context", () => {
    const { ops } = lineDiff("a\nb\nc", "a\nX\nc");
    expect(ops.map((o) => o.t)).toEqual(["eq", "del", "add", "eq"]);
    expect(ops[1].line).toBe("b");
    expect(ops[2].line).toBe("X");
  });

  test("pure insertion is adds only", () => {
    const { ops } = lineDiff("a\nc", "a\nb\nc");
    expect(ops.filter((o) => o.t === "add").map((o) => o.line)).toEqual(["b"]);
    expect(ops.filter((o) => o.t === "del").length).toBe(0);
  });

  test("caps pathological inputs", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const { truncated } = lineDiff(big, "other");
    expect(truncated).toBe(true);
  });
});

describe("normalizeAssetPath", () => {
  test("accepts clean relative paths", () => {
    expect(normalizeAssetPath("img/chart.png")).toBe("img/chart.png");
    expect(normalizeAssetPath("./css/app.css")).toBe("css/app.css");
    expect(normalizeAssetPath("a\\b\\c.js")).toBe("a/b/c.js");
  });

  test("rejects traversal, absolute, and reserved paths", () => {
    expect(normalizeAssetPath("../etc/passwd")).toBeNull();
    expect(normalizeAssetPath("/abs.js")).toBeNull();
    expect(normalizeAssetPath("_v/3/x.png")).toBeNull();
    expect(normalizeAssetPath("a/../b.js")).toBeNull();
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
      _table: "artifact_versions",
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
    const past = { _table: "artifact_versions", _id: "v1", artifact_id: "a1", version: 2, title: "Old", storage_id: "st_v2", size: 10, published_at: 1500 };
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

describe("comment discussion gating", () => {
  const artRow = { ...existingRow, owner_key: "sekrit", session_conversation_id: "conv1" };
  const batch = { author_name: "Viewer", version: 3, comments: [{ text: "nice page" }] };

  test("a viewer's comment is stored as discussion, never delivered", async () => {
    const { ctx, inserts } = makeCtx([{ ...artRow }]);
    const result = await (submitComments as any)._handler(ctx, { slug: artRow.slug, ...batch });
    expect(result).toMatchObject({ delivered: false, count: 1, as: null });
    expect(inserts[0]).toMatchObject({ table: "artifact_comments", text: "nice page", delivered: false });
  });

  test("an anonymous comment notifies the owner, with the viewer name and a deep link", async () => {
    const { ctx, inserts, mutations } = makeCtx([{ ...artRow }]);
    await (submitComments as any)._handler(ctx, { slug: artRow.slug, ...batch });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      event_type: "artifact_commented",
      entity_type: "artifact",
      entity_id: artRow.slug,
      actor_name: "Viewer",
      direct_recipient_id: "u1",
    });
    expect(mutations[0].actor_user_id).toBeUndefined();
    expect(mutations[0].link).toContain(`/a/${artRow.slug}?c=${inserts[0]._id}`);
  });

  test("a forged deliver request without the owner key still lands as discussion", async () => {
    const { ctx, inserts } = makeCtx([{ ...artRow }]);
    const result = await (submitComments as any)._handler(ctx, { slug: artRow.slug, deliver: true, owner_key: "wrong", ...batch });
    expect(result.delivered).toBe(false);
    expect(inserts[0]).toMatchObject({ delivered: false });
  });

  test("comments off rejects new posts", async () => {
    const { ctx, inserts } = makeCtx([{ ...artRow, comments_disabled: true }]);
    const result = await (submitComments as any)._handler(ctx, { slug: artRow.slug, ...batch });
    expect(result.error).toContain("Comments are off");
    expect(inserts).toEqual([]);
  });

  test("send-all is owner-only", async () => {
    const { ctx } = makeCtx([{ ...artRow }]);
    const noKey = await (deliverPendingComments as any)._handler(ctx, { slug: artRow.slug });
    expect(noKey.error).toContain("owner");
    const wrongKey = await (deliverPendingComments as any)._handler(ctx, { slug: artRow.slug, owner_key: "wrong" });
    expect(wrongKey.error).toContain("owner");
  });
});

describe("comment identity, threads, and notifications", () => {
  const artRow = { ...existingRow, owner_key: "sekrit" };
  // Owner u1 + teammates u2 (Sam, holds an identity token) and u3 (Riley).
  const teamRows = () => [
    { ...artRow },
    { _table: "users", _id: "u1", name: "Owner", email: "owner@x.com" },
    { _table: "users", _id: "u2", name: "Sam", github_username: "sam", github_avatar_url: "https://av/sam.png", email: "sam@x.com" },
    { _table: "users", _id: "u3", name: "Riley", github_username: "riley", image: "https://av/riley.png" },
    { _table: "team_memberships", _id: "m1", team_id: "t1", user_id: "u1" },
    { _table: "team_memberships", _id: "m2", team_id: "t1", user_id: "u2" },
    { _table: "team_memberships", _id: "m3", team_id: "t1", user_id: "u3" },
    { _table: "artifact_identities", _id: "idt1", token: "tok-sam", user_id: "u2", artifact_id: "a1" },
  ];

  test("a valid identity token stamps the account's name/avatar/user onto the comment", async () => {
    const { ctx, inserts } = makeCtx(teamRows());
    const result = await (submitComments as any)._handler(ctx, {
      slug: artRow.slug,
      author_name: "Spoofed Name",
      version: 3,
      identity_token: "tok-sam",
      comments: [{ text: "love this" }],
    });
    expect(result.as).toEqual({ name: "Sam", avatar: "https://av/sam.png" });
    expect(inserts[0]).toMatchObject({
      table: "artifact_comments",
      author_name: "Sam",
      author_user_id: "u2",
      author_avatar: "https://av/sam.png",
      author_email: "sam@x.com",
    });
  });

  test("a bad identity token degrades to the viewer-typed name", async () => {
    const { ctx, inserts } = makeCtx(teamRows());
    const result = await (submitComments as any)._handler(ctx, {
      slug: artRow.slug,
      author_name: "Drive-by",
      version: 3,
      identity_token: "tok-forged",
      comments: [{ text: "hello" }],
    });
    expect(result.as).toBeNull();
    expect(inserts[0]).toMatchObject({ author_name: "Drive-by" });
    expect(inserts[0].author_user_id).toBeUndefined();
  });

  test("a teammate's comment notifies the owner as that account", async () => {
    const { ctx, mutations } = makeCtx(teamRows());
    await (submitComments as any)._handler(ctx, {
      slug: artRow.slug,
      author_name: "",
      version: 3,
      identity_token: "tok-sam",
      comments: [{ text: "shipping it" }],
    });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      event_type: "artifact_commented",
      actor_user_id: "u2",
      direct_recipient_id: "u1",
    });
  });

  test("@mentions from a verified teammate notify the mentioned teammate, once", async () => {
    const { ctx, mutations } = makeCtx(teamRows());
    await (submitComments as any)._handler(ctx, {
      slug: artRow.slug,
      author_name: "",
      version: 3,
      identity_token: "tok-sam",
      comments: [{ text: "@riley what do you think? cc @riley" }],
    });
    const mention = mutations.filter((m) => m.event_type === "mention");
    expect(mention).toHaveLength(1);
    expect(mention[0]).toMatchObject({ direct_recipient_id: "u3", actor_user_id: "u2" });
    expect(mention[0].message).toContain("Sam mentioned you");
    // Owner still hears about the comment itself.
    expect(mutations.some((m) => m.event_type === "artifact_commented" && m.direct_recipient_id === "u1")).toBe(true);
  });

  test("@mentions from an anonymous viewer are ignored", async () => {
    const { ctx, mutations } = makeCtx(teamRows());
    await (submitComments as any)._handler(ctx, {
      slug: artRow.slug,
      author_name: "Rando",
      version: 3,
      comments: [{ text: "@riley spam spam" }],
    });
    expect(mutations.filter((m) => m.event_type === "mention")).toHaveLength(0);
    expect(mutations.filter((m) => m.event_type === "artifact_commented")).toHaveLength(1);
  });

  test("replies thread under the top-level comment and notify its author", async () => {
    const rows = [
      ...teamRows(),
      {
        _table: "artifact_comments", _id: "c1", artifact_id: "a1", batch_id: "b1",
        author_name: "Sam", author_user_id: "u2", text: "first", version: 3,
        status: "open", delivered: false, created_at: 10,
      },
    ];
    const { ctx, inserts, mutations } = makeCtx(rows);
    const result = await (submitComments as any)._handler(ctx, {
      slug: artRow.slug,
      author_name: "Guest",
      version: 3,
      parent_id: "c1",
      comments: [{ text: "agreed!" }],
    });
    expect(result.count).toBe(1);
    expect(inserts[0]).toMatchObject({ parent_comment_id: "c1", text: "agreed!" });
    const reply = mutations.filter((m) => m.event_type === "comment_reply");
    expect(reply).toHaveLength(1);
    expect(reply[0]).toMatchObject({ direct_recipient_id: "u2", actor_name: "Guest" });
    // Deep link targets the thread, so the page opens it selected.
    expect(reply[0].link).toContain("?c=c1");
    // Owner is notified too (distinct recipient from the thread author).
    expect(mutations.some((m) => m.event_type === "artifact_commented" && m.direct_recipient_id === "u1")).toBe(true);
  });

  test("replying to a reply attaches to the thread's top-level comment", async () => {
    const rows = [
      ...teamRows(),
      { _table: "artifact_comments", _id: "c1", artifact_id: "a1", batch_id: "b1", author_name: "A", text: "top", version: 3, status: "open", delivered: false, created_at: 10 },
      { _table: "artifact_comments", _id: "c2", artifact_id: "a1", batch_id: "b2", author_name: "B", text: "mid", version: 3, status: "open", delivered: false, created_at: 11, parent_comment_id: "c1" },
    ];
    const { ctx, inserts } = makeCtx(rows);
    await (submitComments as any)._handler(ctx, {
      slug: artRow.slug, author_name: "C", version: 3, parent_id: "c2", comments: [{ text: "deep" }],
    });
    expect(inserts[0]).toMatchObject({ parent_comment_id: "c1" });
  });

  test("a reply to a missing comment is rejected", async () => {
    const { ctx, inserts } = makeCtx(teamRows());
    const result = await (submitComments as any)._handler(ctx, {
      slug: artRow.slug, author_name: "C", version: 3, parent_id: "nope", comments: [{ text: "hi" }],
    });
    expect(result.error).toContain("gone");
    expect(inserts).toEqual([]);
  });

  test("the owner commenting via owner_key does not notify themselves", async () => {
    const { ctx, mutations } = makeCtx(teamRows());
    await (submitComments as any)._handler(ctx, {
      slug: artRow.slug, author_name: "Owner", version: 3, owner_key: "sekrit", deliver: false,
      comments: [{ text: "note to self" }],
    });
    expect(mutations).toHaveLength(0);
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

  test("always renders the minimize control and the restore pill", () => {
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).toContain('id="__cc_hide"');
    expect(out).toContain('id="__cc_pill"');
  });

  test("session chip renders only when a session is exposed", () => {
    const shown = brandArtifactHtml("<body></body>", { ...opts, sessionShortId: "jx1abcd", sessionTitle: "My session" });
    expect(shown).toContain('class="__cc_sess"');
    expect(shown).toContain("My session");
    const hidden = brandArtifactHtml("<body></body>", { ...opts, sessionShortId: null });
    expect(hidden).not.toContain('class="__cc_sess"');
  });

  test("accessSummary reports the session-link toggle", () => {
    const base = { password_hash: undefined, email_gate: undefined, expires_at: undefined, edit_mode: undefined };
    expect(accessSummary({ ...base } as never).show_session).toBe(true);
    expect(accessSummary({ ...base, hide_session: true } as never).show_session).toBe(false);
  });

  test("carries the share url into the bar config (no copy button on the bar)", () => {
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).toContain('"shareUrl":"https://codecast.sh/a/x1"');
    expect(out).not.toContain('id="__cc_copy"');
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
    expect(out).toContain(">v5 <svg");
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
    expect(out).toContain(">v2 (old) <svg");
    expect(out).toContain('id="__cc_latest"');
  });

  test("comment chip shows the open count and embeds it in the config", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
      commentCount: 3,
    });
    expect(out).toContain('id="__cc_ccount"');
    expect(out).toContain(">3</span>");
    expect(out).toContain('"comments":3');
  });

  test("zero comments renders an empty chip and a zero config count", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
      commentCount: 0,
    });
    expect(out).toContain('id="__cc_ccount"></span>');
    expect(out).toContain('"comments":0');
  });

  test("interactive bar ships the comments, manage, and history panels", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
    });
    expect(out).toContain('id="__cc_cpanel"');
    expect(out).toContain('id="__cc_mgr"');
    expect(out).toContain('id="__cc_hist"');
    expect(out).toContain("/cli/artifacts/comment");
    expect(out).toContain("/cli/artifacts/manage");
  });

  test("mobile styles: safe-area padding and bottom-sheet panels", () => {
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).toContain("env(safe-area-inset-bottom)");
    expect(out).toContain("env(safe-area-inset-left)");
    expect(out).toContain("border-radius: 16px 16px 0 0");
  });

  test("bar inline script parses as valid JavaScript", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      version: 2,
      currentVersion: 3,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
      commentCount: 2,
    });
    const scripts = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
  });
});

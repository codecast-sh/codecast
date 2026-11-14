// A whole-body doc write is computed from an earlier read. Between that read
// and the write a person can type in the editor, or another agent can write,
// and the write used to land over their change without a word (atrium study,
// idea 4). Every whole-body write now carries the revision it was computed
// from, the server refuses a stale one and names the newer edit, and nothing
// is written while the editor holds steps not yet saved to the doc.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { presentToken } from "@platform/auth/convex";
import { writeBrief } from "./orgHandoff";
import { markdownToDoc } from "./lib/docBody";

setDefaultTimeout(30_000);

const RAW_A = "agent_a_clisecret";
const RAW_B = "agent_b_clisecret";

const pmDoc = (...paras: string[]) => JSON.stringify({
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] },
    ...paras.map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
  ],
});

const backends: any[] = [];
afterEach(async () => { for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {}); });

async function world() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const riley = await ctx.db.insert("users", { name: "Riley" } as any);
    await ctx.db.insert("api_tokens", { user_id: riley, token_hash: await hashToken(RAW_A), name: "mac", created_at: now, last_used_at: now } as any);
    await ctx.db.insert("api_tokens", { user_id: riley, token_hash: await hashToken(RAW_B), name: "mac2", created_at: now, last_used_at: now } as any);
    const doc = await ctx.db.insert("docs", {
      user_id: riley, title: "Plan", content: "# Plan\n\nfirst line", doc_type: "note", source: "agent",
      created_at: now, updated_at: now,
    } as any);
    return { riley, doc };
  });
  const tokA = presentToken(RAW_A);
  const tokB = presentToken(RAW_B);
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const human = t.withIdentity({ subject: `${ids.riley}|session` });
  const read = async (tok: string) => (await post("/cli/docs/get", { api_token: tok, id: ids.doc })).body;
  const stored = async () => await t.run(async (ctx) => (await ctx.db.get(ids.doc))!.content as string);
  const deltas = async () => await t.run(async (ctx) => await ctx.db.query("doc_deltas").collect());
  // The editor opening the doc: the first snapshot it seeds from the markdown.
  const openEditor = async (...paras: string[]) => {
    await human.mutation(api.docSync.submitSnapshot, { id: ids.doc, version: 1, content: pmDoc(...paras) });
  };
  return { t, ids, tokA, tokB, post, human, read, stored, deltas, openEditor };
}

describe("whole-body doc writes carry the base they were computed from", () => {
  test("a read hands back a revision, and a write from it goes through and hands back the next one", async () => {
    const w = await world();
    const doc = await w.read(w.tokA);
    expect(typeof doc.revision).toBe("string");
    const r = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: "# Plan\n\nrewritten", base: doc.revision });
    expect(r.status).toBe(200);
    expect(await w.stored()).toBe("# Plan\n\nrewritten");
    expect(r.body.revision).toBe((await w.read(w.tokA)).revision);
    const again = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: "# Plan\n\nagain", base: r.body.revision });
    expect(again.status).toBe(200);
  });

  test("two agents: the second write from an old read is refused and names the first", async () => {
    const w = await world();
    const a = await w.read(w.tokA);
    const b = await w.read(w.tokB);
    const first = await w.post("/cli/docs/update", { api_token: w.tokB, id: w.ids.doc, content: "# Plan\n\nB's version", base: b.revision, session_id: "jx7bbbb" });
    expect(first.status).toBe(200);
    const second = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: "# Plan\n\nA's version", base: a.revision });
    expect(second.status).toBe(409);
    expect(second.body.reason).toBe("stale");
    expect(second.body.error).toMatch(/changed since you read it/);
    expect(second.body.error).toMatch(/Riley/);
    expect(second.body.error).toMatch(/cast doc show/);
    expect(await w.stored()).toBe("# Plan\n\nB's version");
  });

  test("a person's saved edit in the editor after the read is not overwritten", async () => {
    const w = await world();
    await w.openEditor("first line");
    const a = await w.read(w.tokA);
    // Riley types a line: the step, then the debounced snapshot.
    await w.human.mutation(api.docSync.submitSteps, { id: w.ids.doc, version: 1, clientId: "tab", steps: ["s"] });
    await w.human.mutation(api.docSync.submitSnapshot, { id: w.ids.doc, version: 2, content: pmDoc("first line", "Riley's line") });
    const r = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: "# Plan\n\nagent body", base: a.revision });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Riley edited it in the editor/);
    expect(await w.stored()).toContain("Riley's line");
  });

  test("a person typing right now (steps not yet saved) blocks whole-body writes and keeps the steps", async () => {
    const w = await world();
    await w.openEditor("first line");
    const a = await w.read(w.tokA);
    await w.human.mutation(api.docSync.submitSteps, { id: w.ids.doc, version: 1, clientId: "tab", steps: ["s"] });
    const r = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: "# Plan\n\nagent body", base: a.revision, wait_ms: 0 });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("live_edit");
    expect(r.body.error).toMatch(/Riley is editing it in the editor/);
    expect(await w.stored()).toBe("# Plan\n\nfirst line");
    expect((await w.deltas()).length).toBe(1);
  });

  test("an old client's write with no base still never lands over unsaved typing", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.human.mutation(api.docSync.submitSteps, { id: w.ids.doc, version: 1, clientId: "tab", steps: ["s"] });
    const r = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: "# Plan\n\nlegacy" });
    expect(r.status).toBe(409);
    expect((await w.deltas()).length).toBe(1);
  });

  test("--force overwrites on purpose", async () => {
    const w = await world();
    const a = await w.read(w.tokA);
    await w.post("/cli/docs/update", { api_token: w.tokB, id: w.ids.doc, content: "# Plan\n\nB", base: (await w.read(w.tokB)).revision });
    const r = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: "# Plan\n\nA wins", base: a.revision, force: true });
    expect(r.status).toBe(200);
    expect(await w.stored()).toBe("# Plan\n\nA wins");
  });

  test("a title or type change alone needs no base", async () => {
    const w = await world();
    const r = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, doc_type: "runbook" });
    expect(r.status).toBe(200);
  });
});

describe("find-and-replace runs on the server against the live doc", () => {
  test("patch applies on top of a person's saved edit instead of replacing it", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.human.mutation(api.docSync.submitSteps, { id: w.ids.doc, version: 1, clientId: "tab", steps: ["s"] });
    await w.human.mutation(api.docSync.submitSnapshot, { id: w.ids.doc, version: 2, content: pmDoc("first line", "Riley's line") });
    const r = await w.post("/cli/docs/patch", { api_token: w.tokA, id: w.ids.doc, old_string: "first", new_string: "opening" });
    expect(r.status).toBe(200);
    expect(await w.stored()).toBe("# Plan\n\nopening line\n\nRiley's line");
  });

  test("patch waits out unsaved typing rather than wiping it", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.human.mutation(api.docSync.submitSteps, { id: w.ids.doc, version: 1, clientId: "tab", steps: ["s"] });
    const r = await w.post("/cli/docs/patch", { api_token: w.tokA, id: w.ids.doc, old_string: "first", new_string: "opening", wait_ms: 0 });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("live_edit");
    expect((await w.deltas()).length).toBe(1);
  });

  test("replace_all replaces every occurrence server-side and reports the count", async () => {
    const w = await world();
    await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: "# Plan\n\ncat, cat and cat", base: (await w.read(w.tokA)).revision });
    const r = await w.post("/cli/docs/patch", { api_token: w.tokA, id: w.ids.doc, old_string: "cat", new_string: "dog", replace_all: true });
    expect(r.status).toBe(200);
    expect(r.body.replaced).toBe(3);
    expect(await w.stored()).toBe("# Plan\n\ndog, dog and dog");
  });

  test("a CLI write lands in the collab snapshot in the same transaction", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.post("/cli/docs/patch", { api_token: w.tokA, id: w.ids.doc, old_string: "first", new_string: "opening" });
    const snap = await w.human.query(api.docSync.getSnapshot, { id: w.ids.doc });
    expect(snap.content).toContain("opening line");
    expect(snap.version).toBeGreaterThan(1);
  });
});

describe("the other whole-body writers go through the same check", () => {
  test("plan --body: a write from an old read is refused, one from the current read lands in the editor too", async () => {
    const w = await world();
    const created = (await w.post("/cli/plans/create", { api_token: w.tokA, title: "Ship it", body: "# Ship it\n\nstep one" })).body;
    expect(typeof created.doc_revision).toBe("string");
    const a = (await w.post("/cli/plans/get", { api_token: w.tokA, short_id: created.short_id })).body;
    const b = (await w.post("/cli/plans/get", { api_token: w.tokB, short_id: created.short_id })).body;
    expect(a.doc_revision).toBe(created.doc_revision);
    await w.t.run(async (ctx) => { await ctx.db.insert("conversations", { user_id: w.ids.riley, session_id: "sess-b", short_id: "jx7bbbb", status: "active", agent_type: "claude_code", started_at: 1, updated_at: 1, message_count: 0 } as any); });
    const first = await w.post("/cli/plans/update", { api_token: w.tokB, short_id: created.short_id, body: "# Ship it\n\nB's steps", base: b.doc_revision, session_id: "sess-b" });
    expect(first.status).toBe(200);
    const stale = await w.post("/cli/plans/update", { api_token: w.tokA, short_id: created.short_id, body: "# Ship it\n\nA's steps", base: a.doc_revision });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed since you read it/);
    expect(stale.body.error).toMatch(/Riley \(session jx7bbbb\) wrote it/);
    const fresh = await w.post("/cli/plans/update", { api_token: w.tokA, short_id: created.short_id, body: "# Ship it\n\nA's steps", base: first.body.doc_revision });
    expect(fresh.status).toBe(200);
    const snap = await w.human.query(api.docSync.getSnapshot, { id: created.doc_id });
    expect(snap.content).toContain("A's steps");
  });

  test("brief edit: a person's saved edit since the read refuses the save", async () => {
    const w = await world();
    const now = Date.now();
    const { role, brief } = await w.t.run(async (ctx) => {
      const brief = await ctx.db.insert("docs", { user_id: w.ids.riley, title: "Brief: Infra", content: "Infra: watching deploys", doc_type: "brief", source: "agent", created_at: now, updated_at: now } as any);
      const role = await ctx.db.insert("org_roles", { name: "Infra", handle: "infra", host_user_id: w.ids.riley, scope_user_id: w.ids.riley, scope: { project_ids: [], plan_ids: [] }, status: "active", brief_doc_id: brief, created_at: now, updated_at: now } as any);
      return { role, brief };
    });
    const read = (await w.post("/cli/brief/get", { api_token: w.tokA, role_id: role })).body;
    expect(typeof read.brief_revision).toBe("string");
    await w.human.mutation(api.docSync.submitSnapshot, { id: brief, version: 1, content: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Infra: watching deploys" }] }] }) });
    await w.human.mutation(api.docSync.submitSteps, { id: brief, version: 1, clientId: "tab", steps: ["s"] });
    await w.human.mutation(api.docSync.submitSnapshot, { id: brief, version: 2, content: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Infra: paused deploys, Riley" }] }] }) });
    const r = await w.post("/cli/brief/edit", { api_token: w.tokA, role_id: role, content: "Infra: all green", base: read.brief_revision });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Riley edited it in the editor/);
    const ok = await w.post("/cli/brief/edit", { api_token: w.tokA, role_id: role, content: "Infra: all green", base: (await w.post("/cli/brief/get", { api_token: w.tokA, role_id: role })).body.brief_revision });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.brief_revision).toBe("string");
  });

  test("the assistant's write_doc never lands over unsaved typing", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.human.mutation(api.docSync.submitSteps, { id: w.ids.doc, version: 1, clientId: "tab", steps: ["s"] });
    await expect(w.t.mutation(internal.assistant.tools.workspace.writeDoc, { user_id: w.ids.riley, id: String(w.ids.doc), content: "replaced" } as any))
      .rejects.toThrow(/is editing it in the editor/);
    expect((await w.deltas()).length).toBe(1);
  });
});

describe("review round 9", () => {
  test("--force with the stored text still discards steps that never saved", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.human.mutation(api.docSync.submitSteps, { id: w.ids.doc, version: 1, clientId: "tab", steps: ["s"] });
    const r = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: "# Plan\n\nfirst line", force: true });
    expect(r.status).toBe(200);
    expect((await w.deltas()).length).toBe(0);
  });
});

describe("review round 6", () => {
  test("the collab reset rebuilds from the stored body and ignores text a caller hands it", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.t.mutation(api.docs.resetSync, { api_token: w.tokA, id: w.ids.doc, content: "# Plan\n\nold text from an old read" });
    expect(await w.stored()).toBe("# Plan\n\nfirst line");
    expect((await w.human.query(api.docSync.getSnapshot, { id: w.ids.doc })).content).toContain("first line");
  });
});

describe("review round 5", () => {
  test("a handoff's brief write never aborts over an open brief: it keeps the person's steps and writes the markdown", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.human.mutation(api.docSync.submitSteps, { id: w.ids.doc, version: 1, clientId: "tab", steps: ["s"] });
    await w.t.run(async (ctx) => { await writeBrief(ctx as any, { brief_doc_id: w.ids.doc, name: "Infra" }, "# Plan\n\nhanded over", Date.now()); });
    expect(await w.stored()).toBe("# Plan\n\nhanded over");
    expect((await w.deltas()).length).toBe(1);
  });

  test("headings deeper than the editor's three stay literal text", () => {
    const doc = markdownToDoc("#### Deep\n\n## Two");
    expect(doc.content![0]).toMatchObject({ type: "paragraph", content: [{ type: "text", text: "#### Deep" }] });
    expect(doc.content![1]).toMatchObject({ type: "heading", attrs: { level: 2 } });
  });
});

describe("review round 4", () => {
  test("the legacy collab reset refuses over unsaved typing", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.human.mutation(api.docSync.submitSteps, { id: w.ids.doc, version: 1, clientId: "tab", steps: ["s"] });
    await expect(w.t.mutation(api.docs.resetSync, { api_token: w.tokA, id: w.ids.doc, content: "old" })).rejects.toThrow(/is editing it in the editor/);
    expect((await w.deltas()).length).toBe(1);
  });

  test("a source-file upsert reaches the open editor and never lands over unsaved typing", async () => {
    const w = await world();
    const first = (await w.post("/cli/docs/create", { api_token: w.tokA, title: "Synced plan", content: "# Synced plan\n\nfrom the file", source_file: "/repo/plan.md" })).body;
    await w.human.mutation(api.docSync.submitSnapshot, { id: first.id, version: 1, content: pmDoc("from the file") });
    const again = await w.post("/cli/docs/create", { api_token: w.tokA, title: "Synced plan", content: "# Synced plan\n\nfile v2", source_file: "/repo/plan.md" });
    expect(again.status).toBe(200);
    expect((await w.human.query(api.docSync.getSnapshot, { id: first.id })).content).toContain("file v2");
    await w.human.mutation(api.docSync.submitSteps, { id: first.id, version: 2, clientId: "tab", steps: ["s"] });
    const blocked = await w.post("/cli/docs/create", { api_token: w.tokA, title: "Synced plan", content: "# Synced plan\n\nfile v3", source_file: "/repo/plan.md" });
    expect(blocked.body.reason).toBe("live_edit");
  });

  test("the assistant cannot rewrite whole a doc longer than read_doc shows", async () => {
    const w = await world();
    const long = "# Plan\n\n" + "word ".repeat(5000);
    await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: long, base: (await w.read(w.tokA)).revision });
    const read = await w.t.query(internal.assistant.tools.workspace.readDoc, { user_id: w.ids.riley, id: String(w.ids.doc) } as any);
    await expect(w.t.mutation(internal.assistant.tools.workspace.writeDoc, { user_id: w.ids.riley, id: String(w.ids.doc), content: "short", base: (read as any).revision } as any))
      .rejects.toThrow(/longer than read_doc shows/);
  });
});

describe("review round 2", () => {
  test("a body write that names no base is refused, for docs, plans and briefs", async () => {
    const w = await world();
    const doc = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: "# Plan\n\nblind" });
    expect(doc.status).toBe(409);
    expect(doc.body.reason).toBe("no_base");
    expect(doc.body.error).toMatch(/cast doc show/);
    const created = (await w.post("/cli/plans/create", { api_token: w.tokA, title: "Ship", body: "# Ship\n\none" })).body;
    const plan = await w.post("/cli/plans/update", { api_token: w.tokA, short_id: created.short_id, body: "# Ship\n\nblind" });
    expect(plan.body.reason).toBe("no_base");
    expect(await w.stored()).toBe("# Plan\n\nfirst line");
  });

  test("an empty body still needs its base", async () => {
    const w = await world();
    const r = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: "", doc_type: "runbook" });
    expect(r.body.reason).toBe("no_base");
  });
});

describe("live rig findings", () => {
  test("a cursor that just moved in the editor counts as typing the server has not received yet", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.human.mutation(api.docSync.updatePresence, { doc_id: String(w.ids.doc), cursor_pos: 12, anchor_pos: 12 });
    const r = await w.post("/cli/docs/patch", { api_token: w.tokA, id: w.ids.doc, old_string: "first", new_string: "opening", wait_ms: 0 });
    expect(r.body.reason).toBe("live_edit");
    expect(r.body.error).toMatch(/Riley is editing it in the editor/);
  });

  test("a find-and-replace never answers 'not found' from text the editor has moved past", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.human.mutation(api.docSync.submitSteps, { id: w.ids.doc, version: 1, clientId: "tab", steps: ["s"] });
    const r = await w.post("/cli/docs/patch", { api_token: w.tokA, id: w.ids.doc, old_string: "a line Riley just typed", new_string: "x", wait_ms: 0 });
    expect(r.body.reason).toBe("live_edit");
  });
});

describe("review round 1", () => {
  test("a title or type change hands back no revision to rewrite from", async () => {
    const w = await world();
    const r = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, doc_type: "runbook" });
    expect(r.body.revision).toBeUndefined();
  });

  test("a snapshot older than one already saved never moves the doc's text back", async () => {
    const w = await world();
    await w.openEditor("first line");
    await w.human.mutation(api.docSync.submitSteps, { id: w.ids.doc, version: 1, clientId: "tab", steps: ["s", "t"] });
    await w.human.mutation(api.docSync.submitSnapshot, { id: w.ids.doc, version: 3, content: pmDoc("first line", "newest") });
    await w.human.mutation(api.docSync.submitSnapshot, { id: w.ids.doc, version: 2, content: pmDoc("first line", "older") });
    expect(await w.stored()).toContain("newest");
  });

  test("bodies with deep headings and bare # lines write without hanging", async () => {
    const w = await world();
    const body = "# Plan\n\n#### Detail\n\n#tag\n\n######\n\ntext";
    const r = await w.post("/cli/docs/update", { api_token: w.tokA, id: w.ids.doc, content: body, base: (await w.read(w.tokA)).revision });
    expect(r.status).toBe(200);
    const snap = await w.human.query(api.docSync.getSnapshot, { id: w.ids.doc });
    expect(snap.content).toContain("Detail");
  });

  test("a stale plan body names the read the CLI takes its base from: the plan's doc", async () => {
    const w = await world();
    const created = (await w.post("/cli/plans/create", { api_token: w.tokA, title: "Ship", body: "# Ship\n\none" })).body;
    await w.post("/cli/plans/update", { api_token: w.tokB, short_id: created.short_id, body: "# Ship\n\ntwo", base: created.doc_revision });
    const r = await w.post("/cli/plans/update", { api_token: w.tokA, short_id: created.short_id, body: "# Ship\n\nthree", base: created.doc_revision });
    expect(r.body.error).toContain(`cast doc show ${created.doc_id}`);
  });

  test("the assistant's rewrite from an old read_doc is refused", async () => {
    const w = await world();
    const read = await w.t.query(internal.assistant.tools.workspace.readDoc, { user_id: w.ids.riley, id: String(w.ids.doc) } as any);
    await w.post("/cli/docs/update", { api_token: w.tokB, id: w.ids.doc, content: "# Plan\n\nB", base: (await w.read(w.tokB)).revision });
    await expect(w.t.mutation(internal.assistant.tools.workspace.writeDoc, { user_id: w.ids.riley, id: String(w.ids.doc), content: "# Plan\n\nassistant", base: (read as any).revision } as any))
      .rejects.toThrow(/read it again with read_doc/i);
    expect(await w.stored()).toBe("# Plan\n\nB");
  });
});

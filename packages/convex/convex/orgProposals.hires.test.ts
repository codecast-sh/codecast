import { describe, expect, test } from "bun:test";
import { performCreateProposal, performDecideHire } from "./orgProposals";
import { performSetHiresFreely } from "./orgRoles";
import { change, ctxOf, fixtures, GROWTH, MATE, ME, NOW, P, S1, S_GROWTH, spec, TEAM, tokenCtxOf } from "./orgProposals.testkit";

// Roles hiring their own permanent reports: a role proposes a new role under
// itself; a lead above it (or the person) decides; a role a person gave
// leeway brings its hires online itself.
describe("orgProposals hires", () => {
  const DOCS = "org_roles_docs";
  const S_DOCS = "conversations_standing_docs";
  const S_HAND = "conversations_docs_hand";
  const BOT_DOCS = "u".repeat(31) + "d";
  const hireFixtures = (docs: Record<string, any> = {}) => fixtures({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }, { _id: BOT_DOCS, name: "Docs" }],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    org_roles: [
      { _id: GROWTH, short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", trust: "direct", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchors_growth", created_by: ME, created_at: 1, updated_at: 1 },
      { _id: DOCS, short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Docs lead", handle: "docs", trust: "direct", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "role", role_id: GROWTH }, status: "active", anchor_id: "anchors_docs", created_by: ME, created_at: 1, updated_at: 1, ...docs },
    ],
    anchors: [
      { _id: "anchors_growth", name: "Growth lead", scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: MATE, org_role_id: GROWTH, conversation_id: S_GROWTH, status: "active" },
      { _id: "anchors_docs", name: "Docs lead", scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: BOT_DOCS, org_role_id: DOCS, conversation_id: S_DOCS, status: "active" },
    ],
    conversations: [
      { _id: S1, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Org analyzer", short_id: "jxanaly", session_id: "s1", project_path: "/repo", updated_at: NOW, created_at: 1, message_count: 3 },
      { _id: S_GROWTH, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Growth lead", short_id: "jxgrowt", session_id: "s_growth", project_path: "/repo/growth", standing_role_id: GROWTH, anchor_id: "anchors_growth", persistent: true, updated_at: NOW, created_at: 1, message_count: 0 },
      { _id: S_DOCS, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Docs lead", short_id: "jxdocsl", session_id: "s_docs", project_path: "/repo", standing_role_id: DOCS, anchor_id: "anchors_docs", persistent: true, updated_at: NOW, created_at: 1, message_count: 0 },
      { _id: S_HAND, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Docs hand", short_id: "jxdhand", session_id: "s_hand", project_path: "/repo", org_role_id: DOCS, updated_at: NOW, created_at: 1, message_count: 0 },
    ],
    pending_messages: [],
  });
  const hire = (handle = "docs-api", over: Record<string, any> = {}) => change({ kind: "role", name: "API docs", handle, reports_to: "@docs", ...over });
  const postHire = (db: any, changes = [hire()]) => performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s_docs", spec: spec(changes, { title: "Hire an API docs owner", mode: "request" }) });
  const messagesTo = async (db: any, conv: string) => (await db.query("pending_messages").collect()).filter((m: any) => String(m.conversation_id) === conv);
  const roleNamed = async (db: any, handle: string) => (await db.query("org_roles").collect()).find((r: any) => r.handle === handle);

  test("a sub-lead's hire stays open and its card reaches the lead above it", async () => {
    const db = hireFixtures();
    const r = await postHire(db);
    expect(r).toMatchObject({ status: "open", author: { kind: "role", id: DOCS }, routed_to: "growth" });
    const [msg] = await messagesTo(db, S_GROWTH);
    // The op-N line on its own draws the card in the lead's thread.
    expect(msg.content).toMatch(/\n\nop-1\n\n/);
    expect(msg.content).toContain("cast org hire op-1 --approve");
    expect(await roleNamed(db, "docs-api")).toBeUndefined();
  });

  test("a top lead's hire posts in its own thread, which is already the person's card", async () => {
    const db = hireFixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s_growth", spec: spec([change({ kind: "role", name: "SEO", handle: "seo", reports_to: "@growth" })], { mode: "request" }) });
    expect(r.status).toBe("open");
    expect(r.routed_to).toBeUndefined();
    expect(await db.query("pending_messages").collect()).toEqual([]);
  });

  test("the lead above approves from its standing session: the role comes online under the hirer, and the hirer is told", async () => {
    const db = hireFixtures();
    const p = await postHire(db);
    const out = await performDecideHire(tokenCtxOf(db), ME as any, { proposal: p.short_id, verdict: "accept", from_session: "s_growth", provision: false });
    expect(out).toMatchObject({ applied: 1, resolved: true, decided_by: { role: "growth", self: false } });
    expect(await roleNamed(db, "docs-api")).toMatchObject({ reports_to: { kind: "role", role_id: DOCS }, status: "active" });
    const row = (await db.query("org_proposal_changes").collect())[0];
    expect(row).toMatchObject({ status: "applied", reply: { verdict: "approve", text: "Approved by @growth" } });
    expect((await messagesTo(db, S_DOCS)).map((m: any) => m.content).join("\n")).toContain("@growth approved your hire of @docs-api");
  });

  test("a lead rejects with a word: the hire is skipped and the hirer reads why", async () => {
    const db = hireFixtures();
    const p = await postHire(db);
    const out = await performDecideHire(tokenCtxOf(db), ME as any, { proposal: p.short_id, verdict: "skip", from_session: "s_growth", text: "Fold it into your own area for now" });
    expect(out).toMatchObject({ resolved: true, applied: 0 });
    expect((await db.query("org_proposal_changes").collect())[0]).toMatchObject({ status: "skipped", reply: { verdict: "reject", text: "Fold it into your own area for now" } });
    expect(await roleNamed(db, "docs-api")).toBeUndefined();
    expect((await messagesTo(db, S_DOCS)).map((m: any) => m.content).join("\n")).toContain("Fold it into your own area for now");
  });

  test("refused: the hirer itself without leeway, its hand, a plain session, and a lead deciding a change that is not a hire", async () => {
    const db = hireFixtures();
    const p = await postHire(db);
    const decide = (from_session: string, proposal = p.short_id) => performDecideHire(tokenCtxOf(db), ME as any, { proposal, verdict: "accept", from_session, provision: false });
    await expect(decide("s_docs")).rejects.toThrow("does not bring its own hires online");
    await expect(decide("s_hand")).rejects.toThrow("Only a role's standing session decides a hire");
    await expect(decide("s1")).rejects.toThrow("Only a role's standing session decides a hire");
    const other = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s_docs", spec: spec([hire(), change({ kind: "budget", handle: "docs", caps: { wakes_per_day: 99 } })], { mode: "request" }) });
    expect(other.routed_to).toBeUndefined();
    await expect(decide("s_growth", other.short_id)).rejects.toThrow("is not a hire");
    // The person's own path is untouched: the browser still decides anything.
    expect((await db.query("org_proposal_changes").collect()).filter((c: any) => c.status !== "proposed")).toEqual([]);
  });

  test("a role below the hirer may not approve its hire", async () => {
    const db = hireFixtures();
    const p = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s_growth", spec: spec([change({ kind: "role", name: "SEO", handle: "seo", reports_to: "@growth" })], { mode: "request" }) });
    await expect(performDecideHire(tokenCtxOf(db), ME as any, { proposal: p.short_id, verdict: "accept", from_session: "s_docs", provision: false })).rejects.toThrow("@docs is not above @growth");
  });

  test("with leeway a person gave it, the role's hire comes online as it is posted", async () => {
    const db = hireFixtures({ hires_freely: true });
    const r = await postHire(db);
    expect(r).toMatchObject({ status: "resolved", applied: true });
    expect(await roleNamed(db, "docs-api")).toMatchObject({ reports_to: { kind: "role", role_id: DOCS } });
    expect((await db.query("org_proposal_changes").collect())[0]).toMatchObject({ status: "applied", reply: { text: "Brought online by @docs" } });
    // Nobody to ask, so nothing is routed.
    expect(await messagesTo(db, S_GROWTH)).toEqual([]);
  });

  test("leeway to hire is a person's switch, logged", async () => {
    const db = hireFixtures();
    expect((await performSetHiresFreely(ctxOf(db), ME as any, { role_id: DOCS, on: true })).hires_freely).toBe(true);
    expect((await db.query("org_role_history").collect()).at(-1)).toMatchObject({ field: "hires_freely", old_value: "false", new_value: "true" });
    expect((await performSetHiresFreely(ctxOf(db), ME as any, { role_id: DOCS, on: false })).hires_freely).toBe(false);
  });
});

describe("a hire carries the answers its template cannot go without", () => {
  const D = "a".repeat(64);
  const manifest = { schemaVersion: 2, id: "growth", version: "2.0.0", name: "CMO", description: "d", role: { name: "CMO", handle: "{{instance}}-cmo", charter: "org/charter.md" }, routines: [],
    inputs: [{ key: "product.domain", label: "Apex domain", kind: "string", required: true }, { key: "metric.window_days", label: "Window", kind: "number", required: true, default: 7 }, { key: "accounts.ads", label: "Ads key", kind: "secret", required: true }] };
  const templates = [{ _id: "org_templates_growth", template_id: "growth", workspace: "codecast", name: "CMO", description: "d", latest: { version: "2.0.0", digest: D }, releases: [{ version: "2.0.0", digest: D, status: "stable", manifest }], manifest, created_by: ME, created_at: 1, updated_at: 1 }];
  const hireSpec = (config: Record<string, string>) => spec([
    change({ kind: "role", name: "CMO", handle: "billing-cmo", scope: { projects: ["pr-2"], plans: [] }, reports_to: "me" }),
    change({ kind: "hire", handle: "billing-cmo", template: "growth", version: "2.0.0", digest: D, instance: "billing-growth", project: "pr-2", config }),
  ], { title: "Hire CMO on Billing", mode: "request", asks: [{ title: "Hire CMO on Billing", why: "d", effect: "e", seqs: [1, 2] }] });
  test("an agent's hire that leaves one blank is refused, naming it, before anything is written; a default or a secret never counts as blank", async () => {
    const db = fixtures({ org_templates: templates });
    await expect(performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: hireSpec({}) })).rejects.toThrow("The hire of growth as billing-growth leaves answers it needs blank: Apex domain (product.domain). Ask the person for them and put them in the hire's config.");
    expect(await db.query("org_proposals").collect()).toEqual([]);
    const posted = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: hireSpec({ "product.domain": "acme.io" }) });
    expect(posted.short_id).toMatch(/^op-/);
  });
});

// buildDay under convex-test (docs/proposals/changes-page.md T4): a seeded day
// of commits, sessions and one private session goes through the real paged
// reads, the gate and the writes. Rows land with their facts, the private
// session never reaches a story or the inputs side table, a rerun writes
// nothing, a late commit keeps its story's key, and prose survives growth but
// not the loss or narrowing of a session.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ChangeCommit } from "@codecast/shared/changes";
import { editionStats } from "./changes";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./changes.ts": () => import("./changes"),
};

const REPO = "acme/app";
const DATE = "2026-10-02";
const at = (hhmm: string) => Date.parse(`${DATE}T${hhmm}:00Z`);
const SECRET = "the walrus protocol";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = at("00:00");
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: now, invite_code: "acme" } as any);
    const other = await ctx.db.insert("teams", { name: "Other", created_at: now, invite_code: "other" } as any);
    const user = (name: string) => ctx.db.insert("users", { name } as any);
    const ana = await user("Ana");
    const ben = await user("Ben");
    for (const u of [ana, ben]) {
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now - 1, visibility: "full" } as any);
    }
    const conv = (owner: Id<"users">, shortId: string, fields: Record<string, unknown> = {}) => ctx.db.insert("conversations", {
      user_id: owner, team_id: team, agent_type: "claude_code", session_id: `s-${shortId}`, short_id: shortId, title: `session ${shortId}`,
      started_at: at("08:00"), updated_at: at("08:00"), message_count: 3, is_private: false, status: "active", project_path: "/repo", ...fields,
    } as any);
    const vis = await conv(ana, "jx7aaaa");
    const priv = await conv(ben, "jx7bbbb", { is_private: true, title: `private ${SECRET}` });
    const insight = (conversation: Id<"conversations">, actor: Id<"users">, summary: string, outcome = "progress") => ctx.db.insert("session_insights", {
      conversation_id: conversation, team_id: team, actor_user_id: actor, source: "idle", generated_at: at("09:45"),
      summary, headline: summary, outcome_type: outcome, themes: [],
    } as any);
    await insight(vis, ana, "Line pages for the web app");
    await insight(priv, ben, `Worked on ${SECRET}`, "blocked");

    const pr = (number: number, linked: Id<"conversations">[]) => ctx.db.insert("pull_requests", {
      team_id: team, github_pr_id: 1000 + number, repository: REPO, number, title: `PR ${number}`, body: "", state: "open",
      author_github_username: "ana", linked_session_ids: linked, created_at: now, updated_at: now,
    } as any);
    const visPr = await pr(1, [vis]);
    const privPr = await pr(2, [priv]);
    await ctx.db.insert("pull_request_sessions", { pull_request_id: visPr, conversation_id: vis });
    await ctx.db.insert("pull_request_sessions", { pull_request_id: privPr, conversation_id: priv });
    return { team, other, ana, ben, vis, priv, visPr, privPr };
  });

  const commit = (sha: string, message: string, time: string, files: string[], fields: Record<string, unknown> = {}) =>
    t.run(async (ctx) => ctx.db.insert("commits", {
      sha, message, author_name: "Ana", author_email: "ana@acme.dev", timestamp: at(time),
      files_changed: files.length, insertions: 10 * files.length, deletions: 2 * files.length,
      repository: REPO, team_id: ids.team, branch: "main",
      files: files.map((filename) => ({ filename, status: "modified", additions: 10, deletions: 2, changes: 12 })),
      ...fields,
    } as any));

  await commit("a1", "feat(web): line pages", "09:00", ["packages/web/line.tsx", "packages/web/page.tsx"], { conversation_id: ids.vis });
  await commit("a2", "fix(web): line page scroll", "09:30", ["packages/web/line.tsx"], { conversation_id: ids.vis });
  await commit("b1", "fix(cli): retry the upload\n\nWhy it broke.\n\nCodecast-Session: jx7bbbb", "10:00", ["packages/cli/upload.ts"], {
    conversation_id: ids.priv, author_name: "Ben", author_email: "ben@acme.dev", pr_id: ids.privPr,
  });
  await commit("d1", "docs: refresh the guide", "11:00", ["docs/guide.md"], { author_name: "Cy", author_email: "cy@acme.dev" });
  await commit("r1", "chore(cli): bump version to 1.2.3", "12:00", ["packages/cli/package.json"]);
  // None of these belong to the day of acme/app in this team.
  await commit("x1", "feat: elsewhere", "09:10", ["src/a.ts"], { repository: "acme/other" });
  await commit("x2", "wip: scratch", "09:20", ["packages/web/x.ts"], { branch: "worktree-agent-abc" });
  await commit("x3", "feat(web): yesterday", "09:00", ["packages/web/y.ts"], { timestamp: at("09:00") - 24 * 3_600_000 });
  await commit("x4", "feat(web): other team", "09:00", ["packages/web/z.ts"], { team_id: ids.other });

  const build = () => t.action(internal.changes.buildDay, { team_id: ids.team, repository: REPO, date: DATE });
  const stories = () => t.run(async (ctx) => ctx.db
    .query("change_stories")
    .withIndex("by_team_repo_date", (q) => q.eq("team_id", ids.team).eq("repository", REPO).eq("date", DATE))
    .collect());
  const inputs = () => t.run(async (ctx) => ctx.db.query("change_story_inputs").collect());
  const digest = () => t.run(async (ctx) => ctx.db
    .query("digests")
    .withIndex("by_team_repo_scope_date", (q) => q.eq("team_id", ids.team).eq("repository", REPO).eq("scope", "day").eq("date", DATE))
    .first());
  const byShas = async (sha: string) => (await stories()).find((s) => s.commit_shas.includes(sha))!;
  return { t, ids, commit, build, stories, inputs, digest, byShas };
}

describe("changes.buildDay", () => {
  test("writes one row per story with its facts, from this team's repository and day only", async () => {
    const { ids, build, stories, byShas, digest } = await setup();
    const result = await build();

    const rows = await stories();
    const shas = rows.flatMap((s) => s.commit_shas).sort();
    expect(shas).toEqual(["a1", "a2", "b1", "d1"]);
    expect(result.stories).toBe(rows.length);
    expect(result.pending.length).toBe(rows.length);

    const web = await byShas("a1");
    expect(web.commit_shas).toEqual(["a1", "a2"]);
    expect(web.area).toBe("web");
    expect(web.conversation_ids).toEqual([ids.vis]);
    expect(web.actor_user_ids).toEqual([ids.ana]);
    expect(web.pr_ids).toEqual([ids.visPr]);
    expect(web.headline).toBe("Line pages");
    expect(web.dek).toBe("Line page scroll");
    expect(web.prose_status).toBe("pending");
    expect(web.on_default_branch).toBe(true);
    expect(web.insertions).toBe(30);

    // The cli fix shipped in the release commit after it; the release commit is not a story.
    const cli = await byShas("b1");
    expect(cli.release).toEqual({ surface: "cli", version: "1.2.3", sha: "r1", at: at("12:00") });
    expect(rows.some((s) => s.commit_shas.includes("r1"))).toBe(false);

    const docs = await byShas("d1");
    expect(docs.importance).toBe(1);

    const facts = await digest();
    expect(facts?.status).toBe("facts");
    expect(facts?.stats).toEqual({ commits: 5, stories: rows.length, releases: 1, people: 3, sessions: 1, private_sessions: 1 });
    expect(facts?.headline).toBe(`5 commits, 1 release, ${rows.length} stories`);
    expect(facts?.releases).toEqual([{ surface: "cli", version: "1.2.3", sha: "r1", at: at("12:00") }]);
  });

  test("a private session reaches no story, no inputs row and no text", async () => {
    const { t, ids, build, stories, inputs, byShas } = await setup();
    await build();

    const cli = await byShas("b1");
    expect(cli.conversation_ids).toEqual([]);
    expect(cli.actor_user_ids).toEqual([]);
    expect(cli.private_session_count).toBe(1);
    // Its pull request rides on the private session, so it is withheld too, and its blocked insight raises nothing.
    expect(cli.pr_ids).toEqual([]);
    expect(cli.risks.map((r) => r.code)).not.toContain("blocked");
    // The commit's own text is team-readable and stays.
    expect(cli.headline).toBe("Retry the upload");

    const rows = await stories();
    expect(rows.flatMap((s) => s.conversation_ids)).not.toContain(ids.priv);
    expect(rows.flatMap((s) => s.actor_user_ids)).not.toContain(ids.ben);
    expect((await inputs()).map((i) => i.conversation_id)).toEqual([ids.vis]);

    const everything = JSON.stringify(await t.run(async (ctx) => ({
      stories: await ctx.db.query("change_stories").collect(),
      digests: await ctx.db.query("digests").collect(),
    })));
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("jx7bbbb");
  });

  test("a rerun over the same rows writes nothing", async () => {
    const { build, stories, inputs, digest } = await setup();
    await build();
    const before = { stories: await stories(), inputs: await inputs(), digest: await digest() };
    const again = await build();
    expect(again.changed).toBe(0);
    expect(again.deleted).toBe(0);
    expect(await stories()).toEqual(before.stories);
    expect(await inputs()).toEqual(before.inputs);
    expect(await digest()).toEqual(before.digest);
  });

  test("a late commit joins its story under the same key; prose stays and is marked for rewriting", async () => {
    const { t, ids, commit, build, byShas } = await setup();
    await build();
    const first = await byShas("a1");
    await t.run(async (ctx) => ctx.db.patch(first._id, {
      headline: "Line pages arrive", dek: "Prose dek", body: "Prose body.", why_source: "session", prose_status: "written", generated_at: at("10:00"),
    }));

    await commit("a3", "fix(web): line page focus", "13:00", ["packages/web/page.tsx"], { conversation_id: ids.vis });
    const result = await build();
    const grown = await byShas("a3");
    expect(grown._id).toBe(first._id);
    expect(grown.story_key).toBe(first.story_key);
    expect(grown.commit_shas).toEqual(["a1", "a2", "a3"]);
    expect(grown.inputs_hash).not.toBe(first.inputs_hash);
    expect(grown.prose_status).toBe("pending");
    expect(grown.headline).toBe("Line pages arrive");
    expect(result.pending).toContain(first._id);

    // A rebuild with nothing new keeps the prose while it waits.
    await build();
    expect((await byShas("a3")).headline).toBe("Line pages arrive");
  });

  test("a story that loses a session falls back to layer 0 text and drops its inputs row", async () => {
    const { t, ids, commit, build, byShas, inputs } = await setup();
    // A second shared session working the same task joins the first one's story.
    const second = await t.run(async (ctx) => {
      const task = await ctx.db.insert("tasks", {
        user_id: ids.ana, workspace: `team:${ids.team}`, short_id: "ct-1", title: "Line pages", task_type: "task", status: "open",
        priority: "medium", blocks: [], source: "human", attempt_count: 0, retry_count: 0, max_retries: 3, created_at: at("08:00"), updated_at: at("08:00"),
      } as any);
      await ctx.db.patch(ids.vis, { active_task_id: task } as any);
      return await ctx.db.insert("conversations", {
        user_id: ids.ben, team_id: ids.team, agent_type: "claude_code", session_id: "s-jx7cccc", short_id: "jx7cccc", title: "session jx7cccc",
        started_at: at("08:00"), updated_at: at("08:00"), message_count: 3, is_private: false, status: "active", project_path: "/repo", active_task_id: task,
      } as any);
    });
    await commit("c1", "feat(web): line page share", "14:00", ["packages/web/share.tsx"], { conversation_id: second });
    await build();
    const merged = await byShas("c1");
    expect(merged.commit_shas).toEqual(["a1", "a2", "c1"]);
    expect([...merged.conversation_ids].sort()).toEqual([ids.vis, second].sort());
    await t.run(async (ctx) => ctx.db.patch(merged._id, {
      headline: "Prose naming jx7cccc", body: "Prose body.", why_source: "session", risk_lines: {}, prose_status: "written",
    }));

    await t.run(async (ctx) => ctx.db.patch(second, { is_private: true }));
    await build();
    const after = await byShas("a1");
    expect(after._id).toBe(merged._id);
    expect(after.conversation_ids).toEqual([ids.vis]);
    expect(after.headline).toBe("Line pages");
    expect(after.body).toBeUndefined();
    expect(after.why_source).toBeUndefined();
    expect(after.risk_lines).toBeUndefined();
    expect(after.prose_status).toBe("pending");
    expect((await inputs()).map((i) => i.conversation_id)).toEqual([ids.vis]);
  });

  test("a session that narrows from full to summary resets the prose built from it", async () => {
    const { t, ids, build, byShas, inputs } = await setup();
    await build();
    expect((await inputs()).find((i) => i.conversation_id === ids.vis)?.mode).toBe("full");
    const web = await byShas("a1");
    await t.run(async (ctx) => ctx.db.patch(web._id, {
      headline: "Prose quoting a turn", body: "Prose body.", why_source: "session", risk_lines: {}, prose_status: "written",
    }));

    await t.run(async (ctx) => ctx.db.patch(ids.vis, { team_visibility: "summary" } as any));
    await build();
    const after = await byShas("a1");
    expect(after.conversation_ids).toEqual([ids.vis]);
    expect(after.headline).toBe("Line pages");
    expect(after.body).toBeUndefined();
    expect(after.why_source).toBeUndefined();
    expect(after.prose_status).toBe("pending");
    expect((await inputs()).find((i) => i.conversation_id === ids.vis)?.mode).toBe("summary");

    // Widening back keeps whatever prose is written at the narrower mode.
    await t.run(async (ctx) => ctx.db.patch(web._id, { headline: "Summary prose", why_source: "session", prose_status: "written" }));
    await t.run(async (ctx) => ctx.db.patch(ids.vis, { team_visibility: undefined } as any));
    await build();
    expect((await byShas("a1")).headline).toBe("Summary prose");
  });

  test("a story whose commits are gone is deleted with its inputs rows", async () => {
    const { t, build, stories, byShas, inputs } = await setup();
    await build();
    const web = await byShas("a1");
    await t.run(async (ctx) => {
      for (const c of await ctx.db.query("commits").collect()) if (c.sha === "a1" || c.sha === "a2") await ctx.db.delete(c._id);
    });
    const result = await build();
    expect(result.deleted).toBe(1);
    expect((await stories()).some((s) => s._id === web._id)).toBe(false);
    expect(await inputs()).toEqual([]);
  });
});

describe("changes.editionStats", () => {
  const by = (sha: string, author_name: string, author_email: string): ChangeCommit =>
    ({ sha, subject: "fix: x", author_name, author_email, timestamp: at("10:00"), branch: "main", insertions: 1, deletions: 0, areas: {} });

  test("one person committing under two emails is one person, the way the page's chips count them", () => {
    const commits = [by("a", "Sam Rao", "sam@work.example"), by("b", "Sam Rao", "sam@home.example"), by("c", "sam rao ", "sam@work.example"), by("d", "Ada Li", "ada@work.example")];
    expect(editionStats(commits, {}, [], "main", new Set(), 0).people).toBe(2);
    expect(editionStats(commits.slice(0, 3), {}, [], "main", new Set(), 0).people).toBe(1);
  });

  test("a commit with no author name counts by its email", () => {
    expect(editionStats([by("a", "", "one@x.example"), by("b", " ", "two@x.example")], {}, [], "main", new Set(), 0).people).toBe(2);
  });
});

describe("authors", () => {
  test("a commit's story names the visible session that edited its files before it, beside the committer, and never a private one", async () => {
    const { t, ids, build, byShas } = await setup();
    const author = await t.run(async (ctx) => {
      const author = await ctx.db.insert("conversations", {
        user_id: ids.ana, team_id: ids.team, agent_type: "claude_code", session_id: "s-jx7cccc", short_id: "jx7cccc", title: "author",
        started_at: at("07:00"), updated_at: at("08:40"), message_count: 9, is_private: false, status: "active", git_root: "/repo",
      } as any);
      await ctx.db.insert("session_insights", {
        conversation_id: author, team_id: ids.team, actor_user_id: ids.ana, source: "idle", generated_at: at("08:45"),
        summary: "Built line pages", headline: "Built line pages", outcome_type: "shipped", themes: [],
      } as any);
      const edit = async (conv: any, key: string, time: string) => {
        const message = await ctx.db.insert("messages", { conversation_id: conv, message_uuid: key, role: "assistant", content: "edit", timestamp: at(time) } as any);
        await ctx.db.insert("file_changes", { conversation_id: conv, change_key: key, message_id: message, seq: 0, file_path: "/repo/packages/web/line.tsx", change_type: "edit", timestamp: at(time) } as any);
      };
      await edit(author, "e-author", "08:30");
      // The private session edited the same file: it never names a story.
      await edit(ids.priv, "e-priv", "08:35");
      // An edit after the commit wrote nothing in it.
      await edit(author, "e-late", "11:00");
      return author;
    });
    await build();
    const story = await byShas("a1");
    expect(story.conversation_ids.map(String)).toEqual([String(ids.vis), String(author)]);
    expect(story.conversation_ids.map(String)).not.toContain(String(ids.priv));
  });

  test("a squash merge with no session trailer takes the sessions its pull request links", async () => {
    const { ids, commit, build, stories } = await setup();
    await commit("sq1", "Stop telling a caller to get what the card never asked for (#1)", "15:00", ["packages/api/feedback.ts"], { pr_id: ids.visPr });
    await build();
    const story = (await stories()).find((x) => x.commit_shas.includes("sq1"))!;
    expect(story.conversation_ids.map(String)).toContain(String(ids.vis));
    expect(story.pr_ids.map(String)).toContain(String(ids.visPr));
  });

  test("a slice of a batch commit names only the session whose edits are in its area", async () => {
    const { t, ids, commit, build, stories } = await setup();
    const sessions = await t.run(async (ctx) => {
      const make = async (short: string, at0: string) => {
        const conv = await ctx.db.insert("conversations", {
          user_id: ids.ana, team_id: ids.team, agent_type: "claude_code", session_id: `s-${short}`, short_id: short, title: short,
          started_at: at(at0), updated_at: at("13:00"), message_count: 9, is_private: false, status: "active", git_root: "/repo",
        } as any);
        await ctx.db.insert("session_insights", {
          conversation_id: conv, team_id: ids.team, actor_user_id: ids.ana, source: "idle", generated_at: at("13:00"),
          summary: short, headline: short, outcome_type: "shipped", themes: [],
        } as any);
        return conv;
      };
      const edit = async (conv: any, key: string, path: string, time: string) => {
        const message = await ctx.db.insert("messages", { conversation_id: conv, message_uuid: key, role: "assistant", content: "edit", timestamp: at(time) } as any);
        await ctx.db.insert("file_changes", { conversation_id: conv, change_key: key, message_id: message, seq: 0, file_path: `/repo/${path}`, change_type: "edit", timestamp: at(time) } as any);
      };
      const webAuthor = await make("jx7wwww", "06:00");
      const apiAuthor = await make("jx7pppp", "06:00");
      for (let i = 0; i < 4; i++) await edit(webAuthor, `w${i}`, `packages/web/sweep${i}.tsx`, "07:30");
      for (let i = 0; i < 4; i++) await edit(apiAuthor, `p${i}`, `packages/api/sweep${i}.ts`, "07:40");
      return { webAuthor, apiAuthor };
    });
    const files = [...[0, 1, 2, 3].map((i) => `packages/web/sweep${i}.tsx`), ...[0, 1, 2, 3].map((i) => `packages/api/sweep${i}.ts`), "docs/sweep.md"];
    await commit("sw", "chore: sweep before the cut", "08:00", files);
    await build();
    const all = await stories();
    const web = all.find((x) => x.commit_shas.includes("sw") && x.area === "web")!;
    const api = all.find((x) => x.commit_shas.includes("sw") && x.area === "api")!;
    expect(web.conversation_ids.map(String)).toContain(String(sessions.webAuthor));
    expect(web.conversation_ids.map(String)).not.toContain(String(sessions.apiAuthor));
    expect(api.conversation_ids.map(String)).toContain(String(sessions.apiAuthor));
    expect(api.conversation_ids.map(String)).not.toContain(String(sessions.webAuthor));
  });

  test("a subagent that wrote the files is an author with no insight of its own, and brings its parent", async () => {
    const { t, ids, build, byShas } = await setup();
    const { parent, worker } = await t.run(async (ctx) => {
      const session = (short: string, extra: Record<string, unknown> = {}) => ctx.db.insert("conversations", {
        user_id: ids.ana, team_id: ids.team, agent_type: "claude_code", session_id: `s-${short}`, short_id: short, title: short,
        started_at: at("07:00"), updated_at: at("08:40"), message_count: 9, is_private: false, status: "active", git_root: "/repo", ...extra,
      } as any);
      const parent = await session("jx7pare");
      await ctx.db.insert("session_insights", {
        conversation_id: parent, team_id: ids.team, actor_user_id: ids.ana, source: "idle", generated_at: at("08:45"),
        summary: "Launched the line pages", headline: "Launched the line pages", outcome_type: "shipped", themes: [],
      } as any);
      const worker = await session("jx7work", { is_subagent: true, parent_conversation_id: parent });
      const message = await ctx.db.insert("messages", { conversation_id: worker, message_uuid: "e-worker", role: "assistant", content: "edit", timestamp: at("08:30") } as any);
      await ctx.db.insert("file_changes", { conversation_id: worker, change_key: "e-worker", message_id: message, seq: 0, file_path: "/repo/packages/web/line.tsx", change_type: "write", timestamp: at("08:30") } as any);
      return { parent, worker };
    });
    await build();
    const story = await byShas("a1");
    expect(story.conversation_ids.map(String)).toEqual(expect.arrayContaining([String(worker), String(parent)]));
  });

  test("a past day finds its author under a later week's sessions", async () => {
    const { t, ids, build, byShas } = await setup();
    const author = await t.run(async (ctx) => {
      const session = (title: string, root: string, start: number) => ctx.db.insert("conversations", {
        user_id: ids.ana, team_id: ids.team, agent_type: "claude_code", session_id: `s-${title}`, short_id: title.slice(0, 7), title,
        started_at: start, updated_at: start + 3600_000, message_count: 9, is_private: false, status: "active", git_root: root,
      } as any);
      const author = await session("jx7cccc", "/repo-wt", at("07:00"));
      await ctx.db.insert("session_insights", {
        conversation_id: author, team_id: ids.team, actor_user_id: ids.ana, source: "idle", generated_at: at("08:45"),
        summary: "Built line pages", headline: "Built line pages", outcome_type: "shipped", themes: [],
      } as any);
      const message = await ctx.db.insert("messages", { conversation_id: author, message_uuid: "e-author", role: "assistant", content: "edit", timestamp: at("08:30") } as any);
      await ctx.db.insert("file_changes", { conversation_id: author, change_key: "e-author", message_id: message, seq: 0, file_path: "/repo-wt/packages/web/line.tsx", change_type: "edit", timestamp: at("08:30") } as any);
      // A busy week later, each session in a checkout of its own.
      for (let i = 0; i < 210; i++) {
        const later = at("00:00") + 7 * 86_400_000 + i * 60_000;
        const conv = await session(`later-${i}`, `/later-${i}`, later);
        await ctx.db.insert("session_insights", {
          conversation_id: conv, team_id: ids.team, actor_user_id: ids.ana, source: "idle", generated_at: later,
          summary: "Later work", headline: "Later work", outcome_type: "progress", themes: [],
        } as any);
      }
      return author;
    });
    await build();
    const story = await byShas("a1");
    expect(story.conversation_ids.map(String)).toContain(String(author));
  });
});


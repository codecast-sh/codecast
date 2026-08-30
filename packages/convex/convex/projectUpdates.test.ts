import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  webPost,
  webComment,
  webList,
  webEdit,
  webDelete,
  webTimeline,
} from "./projectUpdates";

function auth(userId: string | null) {
  return {
    async getUserIdentity() {
      return userId ? { subject: `${userId}|session` } : null;
    },
  };
}

function ctx(userId: string | null, tables: Record<string, any[]>) {
  return {
    auth: auth(userId),
    db: makeFakeDb(tables),
    scheduler: { runAfter: async () => null },
    runMutation: async () => null,
  } as any;
}

const OWNER = "u_owner";
const MEMBER = "u_member";
const STRANGER = "u_stranger";
const TEAM = "t_team";
const PROJECT = "project_p";
const WS = `team:${TEAM}`;

function baseTables(extra: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    users: [
      { _id: OWNER, name: "Owner" },
      { _id: MEMBER, name: "Member" },
      { _id: STRANGER, name: "Stranger" },
    ],
    teams: [{ _id: TEAM, name: "Team" }],
    team_memberships: [
      { _id: "m_owner", user_id: OWNER, team_id: TEAM, role: "admin" },
      { _id: "m_member", user_id: MEMBER, team_id: TEAM, role: "member" },
    ],
    projects: [
      {
        _id: PROJECT,
        user_id: OWNER,
        team_id: TEAM,
        title: "Launch",
        status: "active",
        created_at: 1000,
        updated_at: 1000,
      },
    ],
    project_updates: [],
    project_update_comments: [],
    counters: [],
    tasks: [],
    task_history: [],
    task_comments: [],
    plans: [],
    docs: [],
    ...extra,
  };
}

describe("project updates: posting", () => {
  test("a team member posts and the parent project is bumped", async () => {
    const tables = baseTables();
    const c = ctx(MEMBER, tables);
    const res = await (webPost as any)._handler(c, {
      project_id: PROJECT,
      body: "Shipped the burndown chart.",
      title: "Week 3",
    });
    expect(res.short_id).toBe("pu-1");
    const row = tables.project_updates[0];
    expect(row.author).toBe("Member");
    expect(row.author_kind).toBe("user");
    expect(row.kind).toBe("update");
    expect(tables.projects[0].updated_at).toBe(row.created_at);
  });

  test("a stranger cannot post", async () => {
    await expect(
      (webPost as any)._handler(ctx(STRANGER, baseTables()), {
        project_id: PROJECT,
        body: "hi",
      }),
    ).rejects.toThrow("Project not found");
  });

  test("an empty body is rejected", async () => {
    await expect(
      (webPost as any)._handler(ctx(MEMBER, baseTables()), {
        project_id: PROJECT,
        body: "   ",
      }),
    ).rejects.toThrow("empty");
  });

  test("an oversized body is truncated, not rejected", async () => {
    const tables = baseTables();
    await (webPost as any)._handler(ctx(MEMBER, tables), {
      project_id: PROJECT,
      body: "x".repeat(30_000),
    });
    expect(tables.project_updates[0].body.length).toBe(20_000);
  });
});

describe("project updates: comments", () => {
  function withUpdate(extra: Record<string, any[]> = {}) {
    return baseTables({
      project_updates: [
        {
          _id: "update_1",
          project_id: PROJECT,
          short_id: "pu-9",
          user_id: OWNER,
          author: "Owner",
          author_user_id: OWNER,
          author_kind: "user",
          kind: "update",
          body: "First post",
          created_at: 2000,
          updated_at: 2000,
        },
      ],
      ...extra,
    });
  }

  test("a member comments; update and project both bump", async () => {
    const tables = withUpdate();
    await (webComment as any)._handler(ctx(MEMBER, tables), {
      update_id: "update_1",
      text: "Congrats!",
    });
    const comment = tables.project_update_comments[0];
    expect(comment.author).toBe("Member");
    expect(comment.project_id).toBe(PROJECT);
    expect(tables.project_updates[0].updated_at).toBe(comment.created_at);
    expect(tables.projects[0].updated_at).toBe(comment.created_at);
  });

  test("a stranger cannot comment", async () => {
    await expect(
      (webComment as any)._handler(ctx(STRANGER, withUpdate()), {
        update_id: "update_1",
        text: "hi",
      }),
    ).rejects.toThrow("Update not found");
  });

  test("webList returns updates newest-first with their comments; stranger gets null", async () => {
    const tables = withUpdate({
      project_updates: [
        {
          _id: "update_1", project_id: PROJECT, user_id: OWNER, author: "Owner",
          author_kind: "user", kind: "update", body: "older", created_at: 2000, updated_at: 2000,
        },
        {
          _id: "update_2", project_id: PROJECT, user_id: OWNER, author: "Owner",
          author_kind: "user", kind: "digest", body: "newer", created_at: 3000, updated_at: 3000,
        },
      ],
      project_update_comments: [
        {
          _id: "cmt_1", update_id: "update_1", project_id: PROJECT, author: "Member",
          author_kind: "user", text: "nice", created_at: 2500,
        },
      ],
    });
    const rows = await (webList as any)._handler(ctx(MEMBER, tables), { project_id: PROJECT });
    expect(rows.map((r: any) => r.body)).toEqual(["newer", "older"]);
    expect(rows[1].comments).toHaveLength(1);
    expect(rows[0].comments).toHaveLength(0);

    const denied = await (webList as any)._handler(ctx(STRANGER, tables), { project_id: PROJECT });
    expect(denied).toBeNull();
  });

  test("only the author edits; author or project owner deletes (with comments)", async () => {
    const tables = withUpdate({
      project_update_comments: [
        {
          _id: "cmt_1", update_id: "update_1", project_id: PROJECT, author: "Member",
          author_kind: "user", text: "nice", created_at: 2500,
        },
      ],
    });
    // Member is not the author.
    await expect(
      (webEdit as any)._handler(ctx(MEMBER, tables), { id: "update_1", body: "hijack" }),
    ).rejects.toThrow("Update not found");
    // The author edits.
    await (webEdit as any)._handler(ctx(OWNER, tables), { id: "update_1", body: "edited" });
    expect(tables.project_updates[0].body).toBe("edited");
    expect(tables.project_updates[0].edited_at).toBeGreaterThan(0);

    // A member who is neither author nor project owner cannot delete.
    await expect(
      (webDelete as any)._handler(ctx(MEMBER, tables), { id: "update_1" }),
    ).rejects.toThrow("Update not found");
    // The author deletes; the comment goes with it.
    await (webDelete as any)._handler(ctx(OWNER, tables), { id: "update_1" });
    expect(tables.project_updates).toHaveLength(0);
    expect(tables.project_update_comments).toHaveLength(0);
  });
});

describe("project timeline", () => {
  function richTables() {
    return baseTables({
      project_updates: [
        {
          _id: "update_1", project_id: PROJECT, short_id: "pu-1", user_id: OWNER,
          author: "Owner", author_kind: "user", kind: "update",
          body: "Kickoff", created_at: 5000, updated_at: 5000,
        },
      ],
      project_update_comments: [
        {
          _id: "cmt_1", update_id: "update_1", project_id: PROJECT, author: "Member",
          author_kind: "user", text: "Let's go", created_at: 5500,
        },
      ],
      tasks: [
        {
          _id: "task_a", user_id: OWNER, workspace: WS, project_id: PROJECT,
          short_id: "ct-1", title: "Build it", status: "in_progress", priority: "high",
          created_at: 2000, updated_at: 6000,
        },
        {
          // Closed before task_history existed: no history rows, but closed_at set.
          _id: "task_b", user_id: OWNER, workspace: WS, project_id: PROJECT,
          short_id: "ct-2", title: "Old win", status: "done", priority: "medium",
          created_at: 1500, updated_at: 4000, closed_at: 4000,
        },
      ],
      task_history: [
        {
          _id: "hist_1", task_id: "task_a", user_id: OWNER, actor_type: "user",
          action: "updated", field: "status", old_value: "open", new_value: "in_progress",
          created_at: 3000,
        },
        {
          // Non-status rows stay out of the feed.
          _id: "hist_2", task_id: "task_a", user_id: OWNER, actor_type: "user",
          action: "updated", field: "priority", old_value: "low", new_value: "high",
          created_at: 3100,
        },
      ],
      task_comments: [
        {
          _id: "tc_1", task_id: "task_a", author: "Member", author_user_id: MEMBER,
          text: "On it", comment_type: "progress", created_at: 3500,
        },
      ],
      plans: [
        {
          _id: "plan_1", short_id: "pl-1", user_id: OWNER, workspace: WS,
          project_id: PROJECT, title: "The plan", status: "active", created_at: 1200,
          entries: [
            { type: "decision", timestamp: 4500, content: "Chose SVG", author: "Owner" },
          ],
        },
      ],
      docs: [
        {
          _id: "doc_1", user_id: OWNER, workspace: WS, project_id: PROJECT,
          title: "Design notes", doc_type: "note", created_at: 4800,
        },
      ],
    });
  }

  test("merges every source, newest first", async () => {
    const events = await (webTimeline as any)._handler(ctx(MEMBER, richTables()), {
      project_id: PROJECT,
    });
    const types = events.map((e: any) => `${e.type}@${e.ts}`);
    expect(types).toEqual([
      "update_comment@5500",
      "update_posted@5000",
      "doc_created@4800",
      "plan_entry@4500",
      "task_status@4000",
      "task_comment@3500",
      "task_status@3000",
      "task_created@2000",
      "task_created@1500",
      "plan_created@1200",
      "project_created@1000",
    ]);
  });

  test("stranger gets null; since and limit narrow the feed", async () => {
    const denied = await (webTimeline as any)._handler(ctx(STRANGER, richTables()), {
      project_id: PROJECT,
    });
    expect(denied).toBeNull();

    const recent = await (webTimeline as any)._handler(ctx(MEMBER, richTables()), {
      project_id: PROJECT,
      since: 4900,
    });
    expect(recent.every((e: any) => e.ts >= 4900)).toBe(true);
    expect(recent.map((e: any) => e.type)).toEqual(["update_comment", "update_posted"]);

    const limited = await (webTimeline as any)._handler(ctx(MEMBER, richTables()), {
      project_id: PROJECT,
      limit: 3,
    });
    expect(limited).toHaveLength(3);
  });

  test("synthesizes a close for pre-history done tasks, without doubling logged ones", async () => {
    const events = await (webTimeline as any)._handler(ctx(MEMBER, richTables()), {
      project_id: PROJECT,
    });
    const statusEvents = events.filter((e: any) => e.type === "task_status");
    // task_a: one logged transition. task_b: one synthesized close. No dupes.
    expect(statusEvents).toHaveLength(2);
    const synth = statusEvents.find((e: any) => e.task.short_id === "ct-2");
    expect(synth.new_value).toBe("done");
    expect(synth.actor_kind).toBe("system");
    expect(synth.ts).toBe(4000);
  });

  test("a stranger's task inside an accessible project stays hidden", async () => {
    const tables = richTables();
    tables.tasks.push({
      _id: "task_secret", user_id: STRANGER, workspace: `user:${STRANGER}`,
      project_id: PROJECT, short_id: "ct-99", title: "Private errand",
      status: "open", created_at: 9000, updated_at: 9000,
    });
    const events = await (webTimeline as any)._handler(ctx(MEMBER, tables), {
      project_id: PROJECT,
    });
    expect(events.some((e: any) => e.task?.short_id === "ct-99")).toBe(false);
  });
});

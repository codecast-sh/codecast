// The codecast tools under convex-test (plan pl-840): tasks, docs, memory and
// routines run the web's own paths as the conversation's owner, stay inside
// the person's own workspace, and the routine rules of their plan hold. Then
// toolsFor: only the tools the person's Google grants allow, and a note for
// what is missing.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { runTool, type Tool } from "@platform/agent";
import schema from "../../schema";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { codecastTools } from "./codecast";
import { MEMORY_DOC_TITLE } from "./workspace";
import { connectionNote, googleAccess, toolsFor } from "./index";
import { googleDepsFor } from "./google";
import { SEARCH_MAX_PER_TURN } from "./web";
import { CALENDAR_EVENTS_SCOPE, GMAIL_MODIFY_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from "../../googleOAuth";

setDefaultTimeout(120_000);

const modules = {
  "../../_generated/server.ts": () => import("../../_generated/server"),
  "../../assistant/entry.ts": () => import("../entry"),
  "../../assistant/tools/workspace.ts": () => import("./workspace"),
  "../../agentTasks.ts": () => import("../../agentTasks"),
  "../../conversations.ts": () => import("../../conversations"),
  "../../managedSessions.ts": () => import("../../managedSessions"),
  "../../messages.ts": () => import("../../messages"),
  "../../tasks.ts": () => import("../../tasks"),
  "../../docs.ts": () => import("../../docs"),
  "../../googleOAuth.ts": () => import("../../googleOAuth"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const user = await t.run((ctx) => ctx.db.insert("users", {}));
  const other = await t.run((ctx) => ctx.db.insert("users", {}));
  const started = await t.withIdentity({ subject: user }).mutation(api.assistant.entry.startConversation, { title: "Help" });
  const deps = {
    runQuery: (ref: any, args: any) => t.query(ref, args),
    runMutation: (ref: any, args: any) => t.mutation(ref, args),
    userId: user,
    conversationId: started.conversation_id,
  };
  const tools = codecastTools(deps);
  const call = async (name: string, args: unknown = {}) => {
    const tool = tools.find((x) => x.name === name)!;
    const result = await runTool(tool, args, { callId: `call-${name}` });
    return { text: result.content.map((c) => (c.type === "text" ? c.text : "")).join(""), details: result.details as any };
  };
  return { t, user, other, conversationId: started.conversation_id, deps, tools, call };
}

describe("tasks", () => {
  test("create, list and update run as the owner, in the personal workspace", async () => {
    const { t, user, call } = await setup();
    const made = await call("create_task", { title: "Renew passport", priority: "high", description: "Before March" });
    const id = made.details.task_id as string;
    expect(id).toMatch(/^ct-/);

    const row = await t.run(async (ctx) => (await ctx.db.query("tasks").collect())[0]);
    expect(row).toMatchObject({ user_id: user, workspace: `user:${user}`, title: "Renew passport", priority: "high", status: "open", source: "human" });

    const listed = await call("list_tasks");
    expect(listed.text).toContain("<untrusted-");
    expect(listed.text).toContain('"title": "Renew passport"');
    expect(listed.details).toEqual({ tasks: 1 });

    const updated = await call("update_task", { id, status: "done" });
    expect(updated.text).toBe(`Updated task ${id}: done, high priority.`);
    expect((await call("list_tasks")).text).toContain("No tasks.");
    expect((await call("list_tasks", { filter: "done" })).details).toEqual({ tasks: 1 });
    const history = await t.run((ctx) => ctx.db.query("task_history").collect());
    expect(history.map((h) => h.action)).toEqual(["created", "updated"]);
  });

  test("list_tasks shows what the person's board shows: no mined suggestions, no unpromoted insights; done means finished", async () => {
    const { t, call } = await setup();
    const keep = (await call("create_task", { title: "Call the plumber" })).details.task_id;
    const dropped = (await call("create_task", { title: "Old idea" })).details.task_id;
    await call("update_task", { id: dropped, status: "dropped" });
    for (const title of ["Suggested", "Insight"]) await call("create_task", { title });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("tasks").collect()) {
        if (row.title === "Suggested") await ctx.db.patch(row._id, { triage_status: "suggested" });
        if (row.title === "Insight") await ctx.db.patch(row._id, { source: "insight" });
      }
    });
    const open = (await call("list_tasks")).text;
    expect(open).toContain(keep);
    expect(open).not.toContain("Suggested");
    expect(open).not.toContain("Insight");
    const done = (await call("list_tasks", { filter: "done" })).text;
    expect(done).toContain(dropped);
    expect((await call("list_tasks", { filter: "all" })).details).toEqual({ tasks: 2 });
  });

  test("a task outside the person's own workspace is neither listed nor changed", async () => {
    const { t, call } = await setup();
    const { details } = await call("create_task", { title: "Team thing" });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("tasks").collect())[0];
      await ctx.db.patch(row._id, { workspace: "team:someteam" });
    });
    expect((await call("list_tasks")).text).toContain("No tasks.");
    await expect(call("update_task", { id: details.task_id, status: "done" })).rejects.toThrow("in your own list");
  });

  test("a task synced with an issue is refused, and nothing is pushed to the issue", async () => {
    const { t, call } = await setup();
    const { details } = await call("create_task", { title: "Fix the login bug" });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("tasks").collect())[0];
      await ctx.db.patch(row._id, {
        external: { provider: "github", id: "1", identifier: "me/app#7", url: "https://github.com/me/app/issues/7", remote_updated_at: 1, synced_at: 1 },
      });
    });
    await expect(call("update_task", { id: details.task_id, description: "the person's last 10 emails" })).rejects.toThrow(
      `Task ${details.task_id} is linked to the GitHub issue me/app#7`,
    );
    const row = await t.run(async (ctx) => (await ctx.db.query("tasks").collect())[0]);
    expect(row.description).toBeUndefined();
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("pushTask"))).toEqual([]);
  });

  test("a task shared by link is refused and left unchanged", async () => {
    const { t, call } = await setup();
    const { details } = await call("create_task", { title: "Plan the party" });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("tasks").collect())[0];
      await ctx.db.patch(row._id, { share_token: crypto.randomUUID() });
    });
    await expect(call("update_task", { id: details.task_id, description: "the person's inbox" })).rejects.toThrow(
      `Task ${details.task_id} is shared by link`,
    );
    const row = await t.run(async (ctx) => (await ctx.db.query("tasks").collect())[0]);
    expect(row.description).toBeUndefined();
  });
});

describe("docs and memory", () => {
  test("write_doc creates and appends; read_doc finds by id or title", async () => {
    const { call } = await setup();
    const made = await call("write_doc", { title: "Trip to Lisbon", content: "Flights booked." });
    const id = made.details.doc_id;
    expect((await call("write_doc", { id, content: "Hotel: Alfama." })).text).toBe(`Added to doc ${id}.`);
    const byId = await call("read_doc", { id });
    expect(byId.text).toContain("<untrusted-");
    expect(byId.text).toContain("# Trip to Lisbon");
    expect(byId.text).toContain("Flights booked.\n\nHotel: Alfama.");
    const byTitle = await call("read_doc", { query: "Lisbon" });
    expect(byTitle.details).toEqual({ doc_id: id });
    expect((await call("read_doc", { query: "Tokyo" })).text).toContain("No doc of yours");
    await expect(call("write_doc", { content: "no title" })).rejects.toThrow("needs a title");
  });

  test("replacing a doc's text is its own tool, which asks", async () => {
    const { tools, call } = await setup();
    const id = (await call("write_doc", { title: "Packing", content: "Socks." })).details.doc_id;
    expect(tools.find((x) => x.name === "write_doc")!.risk).toBe("read");
    expect(tools.find((x) => x.name === "replace_doc")!.risk).toBe("write");
    await call("replace_doc", { id, content: "Shirts." });
    const read = await call("read_doc", { id });
    expect(read.text).toContain("Shirts.");
    expect(read.text).not.toContain("Socks.");
  });

  test("a doc shared by link takes no append; replace_doc, which asks, still works", async () => {
    const { t, call } = await setup();
    const id = (await call("write_doc", { title: "Notes for the vendor", content: "Delivery Tuesday." })).details.doc_id;
    await t.run((ctx) => ctx.db.patch(id as Id<"docs">, { share_token: crypto.randomUUID() }));
    await expect(call("write_doc", { id, content: "Summary of this week's inbox" })).rejects.toThrow(
      'Doc "Notes for the vendor" is shared by link',
    );
    expect((await call("read_doc", { id })).text).not.toContain("inbox");
    await call("replace_doc", { id, content: "Delivery Wednesday." });
    expect((await call("read_doc", { id })).text).toContain("Delivery Wednesday.");
  });

  test("another person's doc cannot be read or written", async () => {
    const { t, other, call } = await setup();
    const theirs = await t.run((ctx) => ctx.db.insert("docs", {
      user_id: other, workspace: `user:${other}`, title: "Private", content: "secret", doc_type: "note", source: "human", created_at: 1, updated_at: 1,
    }));
    await expect(call("read_doc", { id: theirs })).rejects.toThrow("No doc with that id");
    await expect(call("write_doc", { id: theirs, content: "x" })).rejects.toThrow("No doc with that id");
  });

  test("remember keeps one doc per person, and recall reads it back as data", async () => {
    const { t, user, call } = await setup();
    expect((await call("recall")).text).toContain("Nothing remembered yet.");
    await call("remember", { fact: "Prefers  short\nreplies" });
    await call("remember", { fact: "Partner is Sam" });
    const docs = await t.run((ctx) => ctx.db.query("docs").collect());
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ title: MEMORY_DOC_TITLE, user_id: user, workspace: `user:${user}`, source: "agent", source_file: `assistant-memory:${user}` });
    const recalled = await call("recall");
    expect(recalled.text).toContain("<untrusted-");
    expect(recalled.text).toContain("- Prefers short replies\n- Partner is Sam");
  });

  test("remember refuses a memory doc shared by link", async () => {
    const { t, call } = await setup();
    const docId = (await call("remember", { fact: "Partner is Sam" })).details.doc_id;
    await t.run((ctx) => ctx.db.patch(docId as Id<"docs">, { share_token: crypto.randomUUID() }));
    await expect(call("remember", { fact: "Salary is 90k" })).rejects.toThrow(`"${MEMORY_DOC_TITLE}" is shared by link`);
    expect((await call("recall")).text).not.toContain("Salary");
  });
});

describe("memory doc lookup", () => {
  test("archiving the memory doc makes the assistant forget, and remember starts a fresh visible doc", async () => {
    const { t, call } = await setup();
    const first = (await call("remember", { fact: "Allergic to peanuts" })).details.doc_id;
    await t.run((ctx) => ctx.db.patch(first, { archived_at: Date.now() }));
    expect((await call("recall")).text).toContain("Nothing remembered yet.");
    const second = (await call("remember", { fact: "Likes window seats" })).details.doc_id;
    expect(second).not.toBe(first);
    const fresh = await t.run((ctx) => ctx.db.get(second));
    expect(fresh?.archived_at).toBeUndefined();
    const recalled = (await call("recall")).text;
    expect(recalled).toContain("Likes window seats");
    expect(recalled).not.toContain("peanuts");
  });

  test("another person's doc with the same source_file neither hides nor replaces the person's memory", async () => {
    const { t, user, other, call } = await setup();
    // A squatter's doc carrying the person's memory key, one before theirs and one after.
    const squat = () => t.run((ctx) => ctx.db.insert("docs", {
      user_id: other, workspace: `user:${other}`, title: "x", content: "- planted", doc_type: "note", source: "human",
      source_file: `assistant-memory:${user}`, created_at: 2, updated_at: 2,
    }));
    await squat();
    await call("remember", { fact: "Partner is Sam" });
    await squat();
    expect((await call("recall")).text).toContain("Partner is Sam");
    expect((await call("recall")).text).not.toContain("planted");
    await call("remember", { fact: "Runs on Sundays" });
    const mine = await t.run(async (ctx) => (await ctx.db.query("docs").collect()).filter((d) => d.user_id === user));
    expect(mine).toHaveLength(1);
    expect(mine[0].content).toContain("- Partner is Sam\n- Runs on Sundays");
  });
});

describe("routines", () => {
  test("a routine is a trigger bound to this conversation, listed and cancelled here", async () => {
    const { t, user, conversationId, call } = await setup();
    const set = await call("schedule_routine", { instruction: "Summarize my unread mail", title: "Morning mail", first_run: "2030-01-02T08:00:00-08:00", repeat_every_hours: 24 });
    const id = set.details.routine_id;
    const row = await t.run(async (ctx) => (await ctx.db.query("agent_tasks").collect())[0]);
    expect(row).toMatchObject({
      user_id: user,
      originating_conversation_id: conversationId,
      created_by_conversation_id: conversationId,
      agent_type: HOSTED_AGENT_TYPE,
      schedule_type: "recurring",
      interval_ms: 24 * 3_600_000,
      run_at: Date.parse("2030-01-02T16:00:00Z"),
      status: "scheduled",
      title: "Morning mail",
    });
    expect((await call("list_routines")).text).toContain(`"id": "${id}"`);
    expect((await call("cancel_routine", { id })).text).toBe(`Cancelled routine ${id}.`);
    expect((await call("list_routines")).text).toContain("No routines on this conversation.");
    await expect(call("cancel_routine", { id: "tr-nope" })).rejects.toThrow("No routine tr-nope");
  });

  test("the plan's rules hold: the free plan repeats at most daily", async () => {
    const { call } = await setup();
    await expect(call("schedule_routine", { instruction: "Check mail", first_run: "2030-01-02T08:00:00Z", repeat_every_hours: 2 })).rejects.toThrow("at most once every day");
    await expect(call("schedule_routine", { instruction: "Check mail", first_run: "tomorrow 8am" })).rejects.toThrow("UTC offset");
  });

  test("routines only go on the person's own hosted conversation", async () => {
    const { t, other, deps } = await setup();
    const local = await t.run((ctx) => ctx.db.insert("conversations", {
      user_id: deps.userId, agent_type: "claude_code", session_id: "s-local", started_at: 1, updated_at: 1, message_count: 0, status: "active",
    } as any));
    const theirs = codecastTools({ ...deps, userId: other });
    const onLocal = codecastTools({ ...deps, conversationId: local as Id<"conversations"> });
    const args = { instruction: "x", first_run: "2030-01-02T08:00:00Z" };
    const schedule = (tools: Tool[]) => runTool(tools.find((x) => x.name === "schedule_routine")!, args, { callId: "c" });
    await expect(schedule(theirs)).rejects.toThrow("your own assistant conversation");
    await expect(schedule(onLocal)).rejects.toThrow("your own assistant conversation");
  });

  test("risk levels: only rewriting a doc and scheduling a routine pass the gate", async () => {
    const { tools } = await setup();
    expect(tools.filter((x) => x.risk === "write").map((x) => x.name)).toEqual(["replace_doc", "schedule_routine"]);
  });
});

/** Runs `fn` with these env vars set (undefined unsets one), then puts them back. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const put = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  put(vars);
  try {
    return await fn();
  } finally {
    put(before);
  }
}
const GOOGLE_ENV = { GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret" };

describe("toolsFor", () => {
  const google = { token: async () => ({ ok: false as const, code: "not_connected" as const, error: "no" }) };

  test("without Google: codecast and web tools, and a note offering to connect", async () => {
    const { user, conversationId, deps } = await setup();
    const set = await toolsFor(deps, user, conversationId, { google });
    const names = set.tools.map((x) => x.name);
    expect(names).toContain("list_tasks");
    expect(names).toContain("fetch_page");
    expect(names.some((n) => ["search_mail", "list_events", "send_mail"].includes(n))).toBe(false);
    expect(set.note).toContain("has not connected Google");
  });

  test("on a server with no Google client: no Google tools, and a note that offers nothing to connect", async () => {
    const { t, user, conversationId, deps } = await setup();
    await t.run((ctx) => ctx.db.insert("google_installations", {
      scope_user_id: user, email: "me@gmail.com", refresh_token_enc: "v1.x.y", granted_scopes: [GMAIL_MODIFY_SCOPE, CALENDAR_EVENTS_SCOPE], created_at: 1, updated_at: 1,
    }));
    const set = await withEnv({ GOOGLE_OAUTH_CLIENT_ID: undefined, GOOGLE_OAUTH_CLIENT_SECRET: undefined }, () => toolsFor(deps, user, conversationId));
    const names = set.tools.map((x) => x.name);
    expect(names).toContain("list_tasks");
    expect(names.some((n) => ["search_mail", "list_events", "send_mail"].includes(n))).toBe(false);
    expect(set.note).toContain("not available on this server");
    expect(set.note).not.toContain("Connections");
    // With the client set, the same person gets their Google tools back.
    const configured = await withEnv(GOOGLE_ENV, () => toolsFor(deps, user, conversationId));
    expect(configured.tools.map((x) => x.name)).toContain("send_mail");
    expect(configured.note).toBe("");
  });

  test("a read-only Gmail connection offers reading only; a pending one offers nothing", async () => {
    const { t, user, conversationId, deps } = await setup();
    await t.run((ctx) => ctx.db.insert("google_installations", {
      scope_user_id: user, email: "me@gmail.com", refresh_token_enc: "v1.x.y", granted_scopes: [GMAIL_READONLY_SCOPE], created_at: 1, updated_at: 1,
    }));
    await t.run((ctx) => ctx.db.insert("google_installations", {
      scope_user_id: user, email: "pending@gmail.com", refresh_token_enc: "v1.x.y", granted_scopes: [GMAIL_MODIFY_SCOPE, CALENDAR_EVENTS_SCOPE],
      pending_confirm_hash: "h", created_at: 2, updated_at: 2,
    }));
    const set = await toolsFor(deps, user, conversationId, { google });
    const names = set.tools.map((x) => x.name);
    expect(names.filter((n) => ["search_mail", "read_thread", "draft_reply", "send_mail", "archive", "list_events"].includes(n))).toEqual(["search_mail", "read_thread"]);
    expect(set.note).toBe(
      "Google is connected, but you cannot draft, archive or label mail (allow gmail.modify), or send mail (allow gmail.send), or see or change their calendar (allow calendar.events). If they ask for that, offer to allow it from Connections.",
    );
  });

  test("full grants on one account allow everything and leave nothing to offer", () => {
    const access = googleAccess([{ email: "me@gmail.com", granted_scopes: [GMAIL_MODIFY_SCOPE, CALENDAR_EVENTS_SCOPE] }]);
    expect(access).toEqual({ connected: true, email: "me@gmail.com", others: [], read_mail: true, modify_mail: true, send_mail: true, calendar: true });
    expect(connectionNote(access, true)).toBe("");
  });

  test("two accounts: the turn works in the one that allows the most, and abilities never mix", async () => {
    // Newest first, as connectionScopesForUser returns them.
    const personal = { email: "me@gmail.com", granted_scopes: [GMAIL_READONLY_SCOPE] };
    const work = { email: "me@work.example", granted_scopes: [GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE] };
    const calendarOnly = { email: "cal@gmail.com", granted_scopes: [GMAIL_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE] };
    const access = googleAccess([personal, work, calendarOnly]);
    expect(access).toEqual({ connected: true, email: "me@work.example", others: ["me@gmail.com", "cal@gmail.com"], read_mail: true, modify_mail: true, send_mail: true, calendar: false });
    expect(connectionNote(access, true)).toBe(
      "Google is connected, but you cannot see or change their calendar (allow calendar.events). If they ask for that, offer to allow it from Connections. " +
        "You work in the Google account me@work.example only; me@gmail.com, cal@gmail.com are connected too, but you cannot use them yet.",
    );
    // On a tie the newest wins.
    expect(googleAccess([personal, { ...personal, email: "older@gmail.com" }]).email).toBe("me@gmail.com");

    // toolsFor asks every token for that one account, whatever the scope.
    const { t, user, conversationId, deps } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("google_installations", { scope_user_id: user, email: personal.email, refresh_token_enc: "v1.x.y", granted_scopes: personal.granted_scopes, created_at: 3, updated_at: 3 });
      await ctx.db.insert("google_installations", { scope_user_id: user, email: work.email, refresh_token_enc: "v1.x.y", granted_scopes: work.granted_scopes, created_at: 2, updated_at: 2 });
    });
    const set = await toolsFor(deps, user, conversationId, { google });
    expect(set.tools.map((x) => x.name)).toContain("send_mail");
    expect(set.tools.map((x) => x.name)).not.toContain("list_events");
  });

  test("the token getter names the turn's account on every scope", () =>
    withEnv(GOOGLE_ENV, async () => {
      const asked: any[] = [];
      const ctx = { runQuery: async (_ref: any, args: any) => (asked.push(args), { ok: false, code: "not_connected" }), runMutation: async () => null };
      const deps = googleDepsFor(ctx, "u1", "me@work.example");
      await deps.token(GMAIL_READONLY_SCOPE);
      await deps.token(GMAIL_SEND_SCOPE, { force: true });
      expect(asked).toEqual([
        { user_id: "u1", scope: GMAIL_READONLY_SCOPE, email: "me@work.example" },
        { user_id: "u1", scope: GMAIL_SEND_SCOPE, email: "me@work.example" },
      ]);
    }));

  test("toolsFor pins the turn to a healthy account when the newest one's last refresh failed", () =>
    withEnv(GOOGLE_ENV, async () => {
      const { t, user, conversationId, deps } = await setup();
      const scopes = [GMAIL_MODIFY_SCOPE, CALENDAR_EVENTS_SCOPE];
      await t.run(async (ctx) => {
        await ctx.db.insert("google_installations", { scope_user_id: user, email: "dead@gmail.com", refresh_token_enc: "v1.x.y", granted_scopes: scopes, created_at: 9, updated_at: 9, last_error: "invalid_grant", last_error_kind: "revoked" });
        await ctx.db.insert("google_installations", { scope_user_id: user, email: "live@gmail.com", refresh_token_enc: "v1.x.y", granted_scopes: scopes, created_at: 1, updated_at: 1 });
      });
      // The real googleDepsFor (no google override): record which account each token ask names.
      const asked: any[] = [];
      const recording = { ...deps, runQuery: (ref: any, args: any) => ("scope" in (args ?? {}) && asked.push(args), deps.runQuery(ref, args)) };
      const set = await toolsFor(recording, user, conversationId, { fetch: (async () => new Response("{}")) as any });
      expect(set.note).toContain("You work in the Google account live@gmail.com only; dead@gmail.com is connected too");
      const search = set.tools.find((x) => x.name === "search_mail")!;
      await runTool(search, { query: "is:unread" }, { callId: "c" }).catch(() => undefined);
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((a) => a.email === "live@gmail.com")).toBe(true);
    }));

  test("the turn's gate asks before fetch_page opens a URL the person did not give", async () => {
    const { user, conversationId, deps } = await setup();
    const { gate } = await toolsFor(deps, user, conversationId, { google });
    const rows = [{ role: "user" as const, content: "What does https://ferry.example/times say?" }];
    const fetchCall = (url: string) => gate(rows)({ id: "c", name: "fetch_page", input: { url }, risk: "write" });
    expect(await fetchCall("https://ferry.example/times")).toBe("allow");
    expect(await fetchCall("https://evil.example/?d=secret")).toBe("ask");
    expect(await gate(rows)({ id: "c", name: "recall", input: {}, risk: "read" })).toBe("allow");
    expect(await gate(rows)({ id: "c", name: "send_mail", input: {}, risk: "write" })).toBe("ask");
  });

  test("the turn's gate refuses search_web past the cap, counting runs before a resume", async () => {
    const { user, conversationId, deps } = await setup();
    const { gate } = await toolsFor(deps, user, conversationId, { google });
    const earlier = Array.from({ length: SEARCH_MAX_PER_TURN }, (_, i) => ({ id: `s${i}`, name: "search_web", input: { query: `q${i}` } }));
    const rows = [
      { role: "user" as const, content: "Find me a ferry" },
      { role: "assistant" as const, tool_calls: [...earlier, { id: "next", name: "search_web", input: { query: "one more" } }] },
    ];
    const search = (id: string) => gate(rows)({ id, name: "search_web", input: {}, risk: "read" });
    expect(await search(`s${SEARCH_MAX_PER_TURN - 1}`)).toBe("allow");
    expect(await search("next")).toEqual({ verdict: "refuse", reason: `No more than ${SEARCH_MAX_PER_TURN} web searches in one turn` });
  });

  test("every tool name is unique and every outside-content tool is fenced", async () => {
    const { t, user, conversationId, deps } = await setup();
    await t.run((ctx) => ctx.db.insert("google_installations", {
      scope_user_id: user, email: "me@gmail.com", refresh_token_enc: "v1.x.y", granted_scopes: [GMAIL_MODIFY_SCOPE, CALENDAR_EVENTS_SCOPE], created_at: 1, updated_at: 1,
    }));
    await withEnv({ ANTHROPIC_API_KEY: "sk-test" }, async () => {
      const { tools, note } = await toolsFor(deps, user, conversationId, { google });
      const names = tools.map((x) => x.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toHaveLength(24);
      expect(note).toBe("");
      const fenced = tools.filter((x) => x.source).map((x) => x.name).sort();
      expect(fenced).toEqual(["draft_reply", "fetch_page", "list_events", "list_routines", "list_tasks", "read_doc", "read_thread", "recall", "search_mail", "search_web", "update_event"]);
    });
  });
});

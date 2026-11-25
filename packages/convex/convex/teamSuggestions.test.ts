import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { performSessionSend } from "./pendingMessages";
import { dismissGuestSuggestionFor, listPending, sendGuestSuggestionFor } from "./guestSuggestions";
import { getPendingPermissions, updatePermissionStatus } from "./permissions";
import {
  PROPOSAL_TTL_MS,
  TEAM_PENDING_MAX,
  attendingOwner,
  canonicalAnswer,
  listMine,
  sendMineNowFor,
  proposeAnswerFor,
  proposePermissionFor,
  settlePermissionProposals,
  withdrawTeamSuggestionFor,
} from "./teamSuggestions";

const run = (fn: any) => fn._handler ?? fn.handler;

// Riley runs c1, shared with team t1; Jordan is on the team; Avery is the
// team's admin; Sam is not on it.
function world(opts: { rileyHere?: boolean; rileyIdle?: boolean; conv?: Record<string, any> } = {}) {
  const now = Date.now();
  let clock = 1_000_000;
  const db = makeFakeDb({
    users: [
      { _id: "uRiley", name: "Riley", active_team_id: "t1" },
      { _id: "uJordan", name: "Jordan", active_team_id: "t1" },
      { _id: "uAvery", name: "Avery", active_team_id: "t1" },
      { _id: "uSam", name: "Sam", active_team_id: "t1" },
      { _id: "uBot", name: "Bot", is_bot: true },
    ],
    teams: [{ _id: "t1", name: "T" }],
    team_memberships: [
      { _id: "m1", user_id: "uRiley", team_id: "t1", role: "member", visibility: "full" },
      { _id: "m2", user_id: "uJordan", team_id: "t1", role: "member", visibility: "full" },
      { _id: "m3", user_id: "uBot", team_id: "t1", role: "member", visibility: "full" },
      { _id: "m4", user_id: "uAvery", team_id: "t1", role: "admin", visibility: "full" },
    ],
    conversations: [{
      _id: "c1", user_id: "uRiley", team_id: "t1", short_id: "jxriley", session_id: "s1", title: "Fix the build",
      is_private: false, status: "active", ...opts.conv,
    }],
    user_presence: opts.rileyHere === false ? [] : [{
      _id: "p1", user_id: "uRiley", surface: "desktop", focused: true, updated_at: now,
      last_seen: now - 5_000, last_input_at: opts.rileyIdle ? now - 10 * 60_000 : now - 5_000,
      viewing_conversation_id: "c1", viewing_since: now - 60_000,
    }],
    devices: [],
    messages: [],
    guest_suggestions: [],
    pending_messages: [],
    pending_permissions: [],
    managed_sessions: [],
    session_owners: [],
    notifications: [],
    entity_subscriptions: [],
    authority_events: [],
    collab_grants: [],
    share_redemptions: [],
  }, { indexes: schemaIndexes(schema as any), creationTime: () => ++clock });
  const as = (userId: string | null) => ({
    db,
    auth: { getUserIdentity: async () => (userId ? { subject: `${userId}|s`, tokenIdentifier: userId } : null) },
    scheduler: { runAfter: async () => {} },
  });
  return { db, as, now };
}

const QUESTIONS = [{ question: "Which database?", header: "DB", options: [{ label: "Postgres (Recommended)" }, { label: "SQLite" }] }];
const pick = (key: string, display = "whatever the client says") => JSON.stringify({ __cc_poll: true, keys: [key], display });

async function ask(w: ReturnType<typeof world>, id = "toolu_1", questions: any[] = QUESTIONS) {
  await w.db.insert("messages", {
    conversation_id: "c1", role: "assistant", timestamp: Date.now(), message_uuid: id,
    tool_calls: [{ id, name: "AskUserQuestion", input: JSON.stringify({ questions }) }],
  });
}
async function answerInTranscript(w: ReturnType<typeof world>, id = "toolu_1") {
  await w.db.insert("messages", { conversation_id: "c1", role: "user", timestamp: Date.now() + 1, tool_results: [{ tool_use_id: id, content: "SQLite" }] });
}

const send = (w: ReturnType<typeof world>, from: string, body: string) =>
  performSessionSend(w.as(from) as any, from as any, { to: "c1", body, direct: true });

describe("a teammate's message while the owner is in the session", () => {
  test("waits as a suggestion instead of reaching the session", async () => {
    const w = world();
    const res = await send(w, "uJordan", "try the flaky test first");
    expect(res.message_id).toBeNull();
    expect(res.suggestion_id).toBeTruthy();
    expect(res.arrives).toBe("with_owner");
    expect(await w.db.query("pending_messages").collect()).toEqual([]);
    const pending = await run(listPending)(w.as("uRiley"), { conversation_id: "c1" });
    expect(pending.map((r: any) => [r.guest_name, r.author_user_id, r.body])).toEqual([["Jordan", "uJordan", "try the flaky test first"]]);
    const mine = await run(listMine)(w.as("uJordan"), { conversation_id: "c1" });
    expect(mine.map((r: any) => r.status)).toEqual(["pending"]);
  });

  test("goes straight in when no owner is attending", async () => {
    for (const w of [world({ rileyHere: false }), world({ rileyIdle: true })]) {
      const res = await send(w, "uJordan", "hello");
      expect(res.message_id).toBeTruthy();
      expect((await w.db.query("pending_messages").collect()).length).toBe(1);
    }
  });

  test("waits even on a session an older client switched off, and the owner's own words go straight in", async () => {
    const w = world();
    await w.db.patch("c1", { team_suggestions: false });
    expect((await send(w, "uJordan", "a")).message_id).toBeNull();
    expect((await send(w, "uRiley", "c")).message_id).toBeTruthy();
  });

  test("the primary owner counts as attending; a teammate or an assigned owner viewing does not", async () => {
    const w = world({ rileyHere: false });
    await w.db.insert("user_presence", {
      user_id: "uSam", surface: "desktop", focused: true, updated_at: w.now, last_seen: w.now, last_input_at: w.now, viewing_conversation_id: "c1",
    });
    expect(await attendingOwner(w.as(null) as any, await w.db.get("c1"), w.now)).toBeNull();
    await w.db.insert("session_owners", { conversation_id: "c1", user_id: "uSam", added_by: "uRiley", added_at: w.now });
    expect(await attendingOwner(w.as(null) as any, await w.db.get("c1"), w.now)).toBeNull();
    await w.db.patch("c1", { owner_user_id: "uSam" });
    expect(await attendingOwner(w.as(null) as any, await w.db.get("c1"), w.now)).toBe("uSam");
  });

  test("owner sends it as the teammate's words; an edit is what goes in and what the author sees", async () => {
    const w = world();
    const { suggestion_id } = await send(w, "uJordan", "run teh tests");
    await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(suggestion_id), "run the tests");
    const [row] = await w.db.query("pending_messages").collect();
    expect(row.content).toBe('<user-message from="Jordan, edited by Riley">\nrun the tests\n</user-message>');
    expect(row.from_user_id).toBe("uJordan");
    const [mine] = await run(listMine)(w.as("uJordan"), { conversation_id: "c1" });
    expect([mine.status, mine.body, mine.edited]).toEqual(["sent", "run the tests", true]);
  });

  test("dismiss and withdraw: the author sees a dismissal, a withdrawal leaves their list", async () => {
    const w = world();
    const a = await send(w, "uJordan", "one");
    const b = await send(w, "uJordan", "two");
    await dismissGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(a.suggestion_id));
    await expect(withdrawTeamSuggestionFor(w.as("uSam") as any, "uSam" as any, String(b.suggestion_id))).resolves.toEqual({ status: "gone" });
    await withdrawTeamSuggestionFor(w.as("uJordan") as any, "uJordan" as any, String(b.suggestion_id));
    const mine = await run(listMine)(w.as("uJordan"), { conversation_id: "c1" });
    expect(mine.map((r: any) => [r.body, r.status])).toEqual([["one", "dismissed"]]);
    expect(await run(listMine)(w.as("uRiley"), { conversation_id: "c1" })).toEqual([]);
  });

  test("a teammate may have only so many waiting", async () => {
    const w = world();
    for (let i = 0; i < TEAM_PENDING_MAX; i++) await send(w, "uJordan", `m${i}`);
    await expect(send(w, "uJordan", "more")).rejects.toThrow(/waiting/);
  });

  test("bots, raw sends and role sessions are never held", async () => {
    const w = world();
    expect((await performSessionSend(w.as("uBot") as any, "uBot" as any, { to: "c1", body: "x", direct: true })).message_id).toBeTruthy();
    const r = world({ conv: { standing_role_id: "role1" } });
    expect((await send(r, "uJordan", "x")).message_id).toBeTruthy();
  });

  test("a stranger cannot reach the session either way", async () => {
    const w = world();
    await expect(send(w, "uSam", "x")).rejects.toThrow(/No session/);
  });
});

describe("proposed answers", () => {
  test("a teammate proposes an answer; the owner submits it as their own reply", async () => {
    const w = world();
    await ask(w);
    await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("1"));
    // A new pick replaces the old one.
    const { suggestion_id } = await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("2", "Postgres"));
    const pending = await run(listPending)(w.as("uRiley"), { conversation_id: "c1" });
    // The display is the server's reading of the keys, never the proposer's.
    expect(pending.map((r: any) => [r.kind, r.tool_use_id, JSON.parse(r.body).display])).toEqual([["answer", "toolu_1", "SQLite"]]);
    await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(suggestion_id));
    const [row] = await w.db.query("pending_messages").collect();
    expect(JSON.parse(row.content)).toEqual({ __cc_poll: true, keys: ["2"], display: "SQLite" });
    expect(row.from_user_id).toBe("uRiley");
    expect((await run(listMine)(w.as("uJordan"), { conversation_id: "c1" }))[0].status).toBe("sent");
  });

  test("anything a question card would not send is refused", async () => {
    const w = world();
    await ask(w);
    const propose = (body: string) => proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", body);
    for (const body of [
      "plain words",
      JSON.stringify({ __cc_poll: true, steps: [{ key: "1", text: "rm -rf /" }], display: "SQLite" }),
      JSON.stringify({ __cc_poll: true, keys: ["9"] }),
      JSON.stringify({ __cc_poll: true, keys: ["1", "2"] }),
      JSON.stringify({ __cc_poll: true, keys: ["Escape"] }),
      JSON.stringify({ __cc_poll: true, keys: ["Enter"] }),
    ]) await expect(propose(body)).rejects.toThrow(/isn't an answer/);
    // Prose is allowed, and the owner sees all of it.
    await propose(JSON.stringify({ __cc_poll: true, text: "neither, use DuckDB", display: "SQLite" }));
    const [row] = await run(listPending)(w.as("uRiley"), { conversation_id: "c1" });
    expect(JSON.parse(row.body).display).toBe("neither, use DuckDB");
  });

  test("multi-question and multi-select keys read back as the labels they press", () => {
    const qs = [
      { question: "a", options: [{ label: "A1" }, { label: "A2" }], multiSelect: true },
      { question: "b", options: [{ label: "B1" }, { label: "B2" }] },
    ];
    expect(canonicalAnswer(JSON.stringify({ __cc_poll: true, keys: ["1", "2", "Right", "2", "Enter"] }), qs)?.display).toBe("A1, A2, B2");
    expect(canonicalAnswer(JSON.stringify({ __cc_poll: true, keys: ["1", "Right"] }), qs)).toBeNull();
    expect(canonicalAnswer(JSON.stringify({ __cc_poll: true, keys: ["1", "1", "2", "Right", "2", "Enter"] }), qs)).toBeNull();
    expect(canonicalAnswer(JSON.stringify({ __cc_poll: true, text: "x".repeat(1001) }), qs)).toBeNull();
    const confirm = [{ question: "ok?", isConfirmation: true, options: [{ label: "Yes" }, { label: "No" }] }];
    expect(canonicalAnswer(JSON.stringify({ __cc_poll: true, keys: ["Escape"] }), confirm)?.display).toBe("No");
  });

  test("a question with its answer in the transcript takes no proposal, and a waiting one is never sent", async () => {
    const w = world();
    await ask(w);
    const { suggestion_id } = await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("1"));
    await answerInTranscript(w);
    await expect(proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("2"))).rejects.toThrow(/already answered/);
    // Answered on the card itself: the author reads that it closed.
    expect((await run(listMine)(w.as("uJordan"), { conversation_id: "c1" }))[0].status).toBe("closed");
    expect(await run(listPending)(w.as("uRiley"), { conversation_id: "c1" })).toEqual([]);
    expect(await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(suggestion_id))).toEqual({ status: "closed" });
    expect(await w.db.query("pending_messages").collect()).toEqual([]);
    await expect(proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_nope", pick("1"))).rejects.toThrow(/already answered/);
  });

  test("submitting one proposal settles its rivals for that question", async () => {
    const w = world();
    await ask(w);
    await w.db.insert("team_memberships", { user_id: "uSam", team_id: "t1", role: "member", visibility: "full" });
    const a = await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("1"));
    await proposeAnswerFor(w.as("uSam") as any, "uSam" as any, "c1", "toolu_1", pick("2"));
    await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(a.suggestion_id));
    expect((await run(listMine)(w.as("uSam"), { conversation_id: "c1" }))[0].status).toBe("closed");
  });

  test("the owner and strangers cannot propose", async () => {
    const w = world();
    await expect(proposeAnswerFor(w.as("uRiley") as any, "uRiley" as any, "c1", "t", "x")).rejects.toThrow(/directly/);
    await expect(proposeAnswerFor(w.as("uSam") as any, "uSam" as any, "c1", "t", "x")).rejects.toThrow(/can't/);
  });

  test("an assigned owner, who cannot press the card, proposes like a teammate and cannot submit", async () => {
    const w = world();
    await ask(w);
    await w.db.insert("session_owners", { conversation_id: "c1", user_id: "uSam", added_by: "uRiley", added_at: Date.now() });
    const { suggestion_id } = await proposeAnswerFor(w.as("uSam") as any, "uSam" as any, "c1", "toolu_1", pick("1"));
    expect((await run(listPending)(w.as("uRiley"), { conversation_id: "c1" })).length).toBe(1);
    await expect(sendGuestSuggestionFor(w.as("uSam") as any, "uSam" as any, String(suggestion_id))).rejects.toThrow(/runner/);
    expect(await w.db.query("pending_messages").collect()).toEqual([]);
  });

  test("the person moving on, or a terminal countdown passing, closes the question", async () => {
    const w = world();
    await ask(w);
    await w.db.insert("messages", { conversation_id: "c1", role: "user", timestamp: Date.now() + 5, content: "skip that, go ahead" });
    await expect(proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("1"))).rejects.toThrow(/already answered/);
    const t = world();
    await ask(t, "toolu_2", QUESTIONS);
    const [m] = await t.db.query("messages").collect();
    await t.db.patch(m._id, { tool_calls: [{ id: "toolu_2", name: "AskUserQuestion", input: JSON.stringify({ questions: QUESTIONS, deniesAt: Date.now() - 1 }) }] });
    await expect(proposeAnswerFor(t.as("uJordan") as any, "uJordan" as any, "c1", "toolu_2", pick("1"))).rejects.toThrow(/already answered/);
  });

  test("a proposal past its time leaves both lists", async () => {
    const w = world();
    await ask(w);
    const { suggestion_id } = await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("1"));
    await w.db.patch(String(suggestion_id), { created_at: Date.now() - PROPOSAL_TTL_MS - 1 });
    expect(await run(listPending)(w.as("uRiley"), { conversation_id: "c1" })).toEqual([]);
    expect(await run(listMine)(w.as("uJordan"), { conversation_id: "c1" })).toEqual([]);
  });

  test("a withdraw that beats the server echo finds the row by its client key", async () => {
    const w = world();
    await ask(w);
    await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("1"), "prop_abc");
    await withdrawTeamSuggestionFor(w.as("uJordan") as any, "uJordan" as any, "prop_abc", "c1");
    expect(await run(listPending)(w.as("uRiley"), { conversation_id: "c1" })).toEqual([]);
    expect(await withdrawTeamSuggestionFor(w.as("uSam") as any, "uSam" as any, "prop_abc", "c1")).toEqual({ status: "gone" });
  });
});

describe("after the owner leaves", () => {
  test("send now takes the suggestion back and sends it once", async () => {
    const w = world();
    const { suggestion_id } = await send(w, "uJordan", "ship it");
    await w.db.patch("p1", { viewing_conversation_id: undefined });
    const res = await sendMineNowFor(w.as("uJordan") as any, "uJordan" as any, String(suggestion_id));
    expect(res).toEqual({ status: "withdrawn", suggested: false });
    expect((await w.db.query("pending_messages").collect()).map((m: any) => m.content)).toEqual(['<user-message from="Jordan">\nship it\n</user-message>']);
    expect(await sendMineNowFor(w.as("uJordan") as any, "uJordan" as any, String(suggestion_id))).toEqual({ status: "withdrawn", suggested: false });
    expect((await w.db.query("pending_messages").collect()).length).toBe(1);
  });

  test("send now on a suggestion the owner already sent sends nothing more", async () => {
    const w = world();
    const { suggestion_id } = await send(w, "uJordan", "ship it");
    await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(suggestion_id));
    expect((await sendMineNowFor(w.as("uJordan") as any, "uJordan" as any, String(suggestion_id))).status).toBe("sent");
    expect((await w.db.query("pending_messages").collect()).length).toBe(1);
  });

  test("a joint turn is refused rather than parked under one name", async () => {
    const w = world();
    const joint = '<user-message from="Jordan">\na\n</user-message>\n<user-message from="Sam">\nb\n</user-message>';
    await expect(send(w, "uJordan", joint)).rejects.toThrow(/together/);
  });
});

describe("proposed permission answers", () => {
  async function withPermission(w: ReturnType<typeof world>) {
    return await w.db.insert("pending_permissions", {
      conversation_id: "c1", session_id: "s1", tool_name: "Bash", arguments_preview: "rm -rf dist", status: "pending", created_at: Date.now(),
    });
  }

  test("an answer matching the proposal reads as sent, a contrary one as dismissed", async () => {
    const w = world();
    const pid = await withPermission(w);
    await proposePermissionFor(w.as("uJordan") as any, "uJordan" as any, String(pid), "approved");
    await settlePermissionProposals(w.as(null) as any, await w.db.get(pid), "approved");
    expect((await run(listMine)(w.as("uJordan"), { conversation_id: "c1" }))[0].status).toBe("sent");

    const pid2 = await withPermission(w);
    await proposePermissionFor(w.as("uJordan") as any, "uJordan" as any, String(pid2), "approved");
    await settlePermissionProposals(w.as(null) as any, await w.db.get(pid2), "denied");
    expect((await run(listMine)(w.as("uJordan"), { conversation_id: "c1" })).map((r: any) => r.status)).toEqual(["sent", "dismissed"]);
  });

  test("a cancelled request takes its proposals with it; an answered one takes no new ones", async () => {
    const w = world();
    const pid = await withPermission(w);
    await proposePermissionFor(w.as("uJordan") as any, "uJordan" as any, String(pid), "denied");
    await settlePermissionProposals(w.as(null) as any, await w.db.get(pid), "cancelled");
    expect((await run(listMine)(w.as("uJordan"), { conversation_id: "c1" })).map((r: any) => r.status)).toEqual(["closed"]);
    await w.db.patch(pid, { status: "approved" });
    await expect(proposePermissionFor(w.as("uJordan") as any, "uJordan" as any, String(pid), "denied")).rejects.toThrow(/already/);
  });

  test("team members see pending prompts; a share link's grantee does not", async () => {
    const w = world();
    await withPermission(w);
    expect((await run(getPendingPermissions)(w.as("uJordan"), { conversation_id: "c1", as_proposer: true })).length).toBe(1);
    await w.db.patch("c1", { share_token: "tok" });
    await w.db.insert("share_redemptions", { conversation_id: "c1", user_id: "uSam", token: "tok", created_at: Date.now() });
    await w.db.insert("collab_grants", { conversation_id: "c1", grantee_user_id: "uSam", status: "granted", created_at: Date.now() });
    expect(await run(getPendingPermissions)(w.as("uSam"), { conversation_id: "c1", as_proposer: true })).toEqual([]);
  });

  test("a permission proposal is never sent as a message", async () => {
    const w = world();
    const pid = await withPermission(w);
    const { suggestion_id } = await proposePermissionFor(w.as("uJordan") as any, "uJordan" as any, String(pid), "approved");
    await expect(sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(suggestion_id))).rejects.toThrow(/card/);
  });
});

test("a prompt the cron expired or any writer ended takes its proposals off both lists", async () => {
  const w = world();
  const pid = await w.db.insert("pending_permissions", {
    conversation_id: "c1", session_id: "s1", tool_name: "Bash", arguments_preview: "ls", status: "pending", created_at: Date.now(),
  });
  await proposePermissionFor(w.as("uJordan") as any, "uJordan" as any, String(pid), "approved");
  expect((await run(listPending)(w.as("uRiley"), { conversation_id: "c1" })).length).toBe(1);
  await w.db.patch(pid, { status: "cancelled" });
  expect(await run(listPending)(w.as("uRiley"), { conversation_id: "c1" })).toEqual([]);
  expect((await run(listMine)(w.as("uJordan"), { conversation_id: "c1" })).map((r: any) => r.status)).toEqual(["closed"]);
});

test("a queued send that waited as a suggestion still waits for the turn's end once sent", async () => {
  const w = world();
  const res = await performSessionSend(w.as("uJordan") as any, "uJordan" as any, { to: "c1", body: "after this turn", direct: true, queue: true });
  await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(res.suggestion_id));
  const [row] = await w.db.query("pending_messages").collect();
  expect(row.queued).toBe(true);
});

test("a teammate who left the team is not sent in their name later", async () => {
  const w = world();
  const { suggestion_id } = await send(w, "uJordan", "hi");
  await w.db.delete("m2");
  expect(await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(suggestion_id))).toEqual({ status: "closed" });
  expect(await w.db.query("pending_messages").collect()).toEqual([]);
});

test("teammates read pending prompts with secrets redacted and none of the runner's rule data", async () => {
  const w = world();
  await w.db.insert("pending_permissions", {
    conversation_id: "c1", session_id: "s1", tool_name: "Bash", status: "pending", created_at: Date.now(),
    arguments_preview: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' x", suggestions: [{ rule: 1 }],
  });
  const [row] = await run(getPendingPermissions)(w.as("uJordan"), { conversation_id: "c1", as_proposer: true });
  expect(row.arguments_preview).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  expect(row.suggestions).toBeUndefined();
  const [own] = await run(getPendingPermissions)(w.as("uRiley"), { conversation_id: "c1" });
  expect(own.suggestions).toEqual([{ rule: 1 }]);
});

describe("who sees prompts and whose words an answer carries", () => {
  test("a teammate at summary level sees no prompts and proposes nothing", async () => {
    const w = world({ conv: { team_visibility: "summary" } });
    await ask(w);
    await w.db.insert("pending_permissions", { conversation_id: "c1", session_id: "s1", tool_name: "Bash", arguments_preview: "ls", status: "pending", created_at: Date.now() });
    expect(await run(getPendingPermissions)(w.as("uJordan"), { conversation_id: "c1", as_proposer: true })).toEqual([]);
    await expect(proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("1"))).rejects.toThrow(/can't/);
  });

  test("the primary owner of a session someone else runs proposes on its prompts; only the runner answers them", async () => {
    const w = world({ conv: { owner_user_id: "uSam" } });
    const pid = await w.db.insert("pending_permissions", { conversation_id: "c1", session_id: "s1", tool_name: "Bash", arguments_preview: "ls", status: "pending", created_at: Date.now() });
    await proposePermissionFor(w.as("uSam") as any, "uSam" as any, String(pid), "approved");
    await expect(proposePermissionFor(w.as("uRiley") as any, "uRiley" as any, String(pid), "approved")).rejects.toThrow(/directly/);
    const [row] = await run(getPendingPermissions)(w.as("uSam"), { conversation_id: "c1", as_proposer: true });
    expect(row.suggestions).toBeUndefined();
  });

  test("blocks the agent wrote after its question leave it open; the person's next turn closes it", async () => {
    const w = world();
    await ask(w);
    await w.db.insert("messages", { conversation_id: "c1", role: "assistant", timestamp: Date.now() + 2, content: "", tool_calls: [{ id: "toolu_par", name: "Read", input: "{}" }] });
    await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("1"));
    await w.db.insert("messages", { conversation_id: "c1", role: "user", timestamp: Date.now() + 3, content: "never mind, do X" });
    await expect(proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("2"))).rejects.toThrow(/already answered/);
  });

  test("a prose answer the owner sends names whose words it is", async () => {
    const w = world();
    await ask(w);
    const { suggestion_id } = await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", JSON.stringify({ __cc_poll: true, text: "use DuckDB" }));
    await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(suggestion_id));
    const [row] = await w.db.query("pending_messages").collect();
    expect(JSON.parse(row.content).text).toBe("use DuckDB\n\n(Jordan's answer)");
  });
});

test("an answer the owner gave on the card a moment ago blocks a proposal's second answer", async () => {
  const w = world();
  await ask(w);
  const { suggestion_id } = await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("2"));
  await w.db.insert("pending_messages", { conversation_id: "c1", from_user_id: "uRiley", owner_user_id: "uRiley", content: pick("1"), status: "pending", created_at: Date.now() });
  expect((await run(listMine)(w.as("uJordan"), { conversation_id: "c1" }))[0].status).toBe("closed");
  expect(await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(suggestion_id))).toEqual({ status: "closed" });
  expect((await w.db.query("pending_messages").collect()).length).toBe(1);
  await expect(proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("1"))).rejects.toThrow(/already answered/);
});

test("a client that does not ask as a proposer gets only the runner's prompts, as before", async () => {
  const w = world();
  await w.db.insert("pending_permissions", { conversation_id: "c1", session_id: "s1", tool_name: "Bash", arguments_preview: "ls", status: "pending", created_at: Date.now() });
  expect(await run(getPendingPermissions)(w.as("uJordan"), { conversation_id: "c1" })).toEqual([]);
  expect((await run(getPendingPermissions)(w.as("uRiley"), { conversation_id: "c1" })).length).toBe(1);
});

test("an owner whose tab stopped reporting no longer holds messages, whatever their machine's input", async () => {
  const w = world();
  await w.db.patch("p1", { last_seen: Date.now() - 10 * 60_000 });
  await w.db.insert("devices", { user_id: "uRiley", device_id: "d1", last_seen: Date.now(), last_input_at: Date.now() });
  expect((await send(w, "uJordan", "hi")).message_id).toBeTruthy();
});

test("an earlier question's queued answer does not close the current one", async () => {
  const w = world();
  await w.db.insert("pending_messages", { conversation_id: "c1", from_user_id: "uRiley", owner_user_id: "uRiley", content: pick("1"), status: "pending", created_at: Date.now() - 60_000 });
  await ask(w);
  const { suggestion_id } = await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("2"));
  expect(await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(suggestion_id))).toEqual({ status: "sent" });
});

test("a prose answer cannot start a shell or slash command", () => {
  for (const text of ["!rm -rf ~", "/model opus"]) expect(canonicalAnswer(JSON.stringify({ __cc_poll: true, text }), QUESTIONS)).toBeNull();
});

test("nobody is offered a proposal on a bot-run session's prompts", async () => {
  const w = world({ conv: { user_id: "uBot", owner_user_id: "uRiley" } });
  await w.db.insert("pending_permissions", { conversation_id: "c1", session_id: "s1", tool_name: "Bash", arguments_preview: "ls", status: "pending", created_at: Date.now() });
  expect(await run(getPendingPermissions)(w.as("uRiley"), { conversation_id: "c1", as_proposer: true })).toEqual([]);
});

test("a share link's grantee is never held: no roster tells them the owner is here", async () => {
  const w = world();
  await w.db.patch("c1", { share_token: "tok" });
  await w.db.insert("share_redemptions", { conversation_id: "c1", user_id: "uSam", token: "tok", created_at: Date.now() });
  await w.db.insert("collab_grants", { conversation_id: "c1", grantee_user_id: "uSam", owner_user_id: "uRiley", status: "granted", created_at: Date.now() });
  const res = await send(w, "uSam", "hi");
  expect(res.message_id).toBeTruthy();
  expect(res.suggestion_id).toBeUndefined();
});

test("a delivered answer still closes its question until the transcript shows the result", async () => {
  const w = world();
  await ask(w);
  const { suggestion_id } = await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("2"));
  await w.db.insert("pending_messages", { conversation_id: "c1", from_user_id: "uRiley", owner_user_id: "uRiley", content: pick("1"), status: "delivered", created_at: Date.now() });
  expect(await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(suggestion_id))).toEqual({ status: "closed" });
});

test("many re-picks never push a waiting message out of its author's list", async () => {
  const w = world();
  await ask(w);
  await send(w, "uJordan", "the waiting one");
  for (let i = 0; i < 25; i++) await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick(i % 2 ? "1" : "2"));
  const mine = await run(listMine)(w.as("uJordan"), { conversation_id: "c1" });
  expect(mine.some((r: any) => r.body === "the waiting one" && r.status === "pending")).toBe(true);
});

test("a teammate working in another team sends straight in: their composer cannot see the owner", async () => {
  const w = world();
  await w.db.patch("uJordan", { active_team_id: "t2" });
  expect((await send(w, "uJordan", "hi")).message_id).toBeTruthy();
});

test("a plain reply queued after the question answers it too", async () => {
  const w = world();
  await ask(w);
  const { suggestion_id } = await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("2"));
  await w.db.insert("pending_messages", { conversation_id: "c1", from_user_id: "uRiley", owner_user_id: "uRiley", content: "the first one", status: "pending", created_at: Date.now() });
  expect(await sendGuestSuggestionFor(w.as("uRiley") as any, "uRiley" as any, String(suggestion_id))).toEqual({ status: "closed" });
});

test("a refused prose answer says why", async () => {
  const w = world();
  await ask(w);
  await expect(proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", JSON.stringify({ __cc_poll: true, text: "/tmp is fine" }))).rejects.toThrow(/can't start with/);
  await expect(proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", JSON.stringify({ __cc_poll: true, text: "x".repeat(1001) }))).rejects.toThrow(/under 1000/);
});

// An admin of the session's team outranks its runner there: they never
// suggest or propose, while a member still does.
describe("an admin of the session's team steers it directly", () => {
  const permission = (w: ReturnType<typeof world>) => w.db.insert("pending_permissions", {
    conversation_id: "c1", session_id: "s1", tool_name: "Bash", arguments_preview: "rm -rf dist", status: "pending", created_at: Date.now(),
  });
  const answer = (w: ReturnType<typeof world>, who: string, pid: any, extra: Record<string, unknown> = {}) =>
    run(updatePermissionStatus)(w.as(who), { permission_id: pid, status: "approved", ...extra });

  test("their message goes straight in while the owner is attending; a member's still waits", async () => {
    const w = world();
    const admin = await send(w, "uAvery", "ship it");
    expect(admin.suggestion_id).toBeUndefined();
    expect(admin.message_id).toBeTruthy();
    expect((await w.db.query("pending_messages").collect()).map((r: any) => r.from_user_id)).toEqual(["uAvery"]);
    const member = await send(w, "uJordan", "wait");
    expect(member.message_id).toBeNull();
    expect(member.suggestion_id).toBeTruthy();
  });

  test("they answer the open question themselves and are refused as a proposer", async () => {
    const w = world();
    await ask(w);
    await expect(proposeAnswerFor(w.as("uAvery") as any, "uAvery" as any, "c1", "toolu_1", pick("1"))).rejects.toThrow(/admin.*directly/);
    expect(await w.db.query("guest_suggestions").collect()).toEqual([]);
    // A member still proposes.
    await proposeAnswerFor(w.as("uJordan") as any, "uJordan" as any, "c1", "toolu_1", pick("1"));
  });

  test("they approve or deny a pending permission directly; a member must propose", async () => {
    const w = world();
    const pid = await permission(w);
    await expect(proposePermissionFor(w.as("uAvery") as any, "uAvery" as any, String(pid), "approved")).rejects.toThrow(/admin.*directly/);
    await expect(answer(w, "uJordan", pid)).rejects.toThrow(/Unauthorized/);
    await proposePermissionFor(w.as("uJordan") as any, "uJordan" as any, String(pid), "approved");
    await answer(w, "uAvery", pid);
    const row = await w.db.get(pid);
    expect([row.status, row.resolved_by]).toEqual(["approved", "uAvery"]);
    // The member's matching proposal settles as it does when the runner answers.
    expect((await run(listMine)(w.as("uJordan"), { conversation_id: "c1" })).map((r: any) => r.status)).toEqual(["sent"]);
  });

  test("keeping a rule stays the runner's; a summary-level session's prompts stay out of reach", async () => {
    const w = world();
    const pid = await permission(w);
    await expect(answer(w, "uAvery", pid, { remember: true })).rejects.toThrow(/runner/);
    expect((await w.db.get(pid)).status).toBe("pending");
    const s = world({ conv: { team_visibility: "summary" } });
    await expect(answer(s, "uAvery", await permission(s))).rejects.toThrow(/Unauthorized/);
  });

  test("they read the runner's prompt rows without the rule data; a member reads the redacted ones", async () => {
    const w = world();
    const secret = "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' x";
    await w.db.insert("pending_permissions", {
      conversation_id: "c1", session_id: "s1", tool_name: "Bash", arguments_preview: secret, status: "pending", created_at: Date.now(),
      safety_check: true, removals: [{ path: "dist" }], intent: "clean the build", subagent_type: "builder",
      suggestions: [{ rule: 1 }], rule_request: { permission: "bash", always: ["rm *"] },
    });
    const [admin] = await run(getPendingPermissions)(w.as("uAvery"), { conversation_id: "c1", as_proposer: true });
    expect([admin.safety_check, admin.removals, admin.intent, admin.subagent_type, admin.arguments_preview])
      .toEqual([true, [{ path: "dist" }], "clean the build", "builder", secret]);
    expect("suggestions" in admin || "rule_request" in admin).toBe(false);
    const [member] = await run(getPendingPermissions)(w.as("uJordan"), { conversation_id: "c1", as_proposer: true });
    expect([member.safety_check, member.intent]).toEqual([undefined, undefined]);
    expect(member.arguments_preview).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  });

  test("a bot-run session's prompts stay its runner's: the admin neither sees nor answers them", async () => {
    const w = world({ conv: { user_id: "uBot", owner_user_id: "uRiley" } });
    const pid = await permission(w);
    expect(await run(getPendingPermissions)(w.as("uAvery"), { conversation_id: "c1", as_proposer: true })).toEqual([]);
    await expect(answer(w, "uAvery", pid)).rejects.toThrow(/Unauthorized/);
    expect((await w.db.get(pid)).status).toBe("pending");
  });

  test("on a role's standing session the admin proposes like any teammate", async () => {
    const w = world({ conv: { standing_role_id: "role1" } });
    await ask(w);
    await proposeAnswerFor(w.as("uAvery") as any, "uAvery" as any, "c1", "toolu_1", pick("1"));
    await expect(answer(w, "uAvery", await permission(w))).rejects.toThrow(/Unauthorized/);
  });

  test("an admin of another team is a member here", async () => {
    const w = world();
    await w.db.patch("m4", { role: "member" });
    await w.db.insert("team_memberships", { user_id: "uAvery", team_id: "t2", role: "admin", visibility: "full" });
    expect((await send(w, "uAvery", "x")).suggestion_id).toBeTruthy();
  });
});

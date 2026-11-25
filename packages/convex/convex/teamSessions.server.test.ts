// Team sessions, the server rules (team sessions spec, step 1). A team session
// is one the team owns (a session_team_owners row): no person owns it, it is in
// every member's inbox, anyone may write in it without claiming it, everyone is
// told when it needs input and the alerts clear once someone answers, and each
// person's dismiss, stash, snooze and pin are their own while kill ends it for
// everyone. All of it behind the team's Team sessions feature.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addSessionOwner, setSessionOwners } from "./sessionOwnership";
import { addSessionOwnerRow, isSessionOwner, ownerRowsForUser, teamOwnerRowsForUser, sessionOwnerRow, setSessionOwnerRows } from "./sessionOwners";
import { applyHoldChange } from "./sessionOwnership";
import { makeChangeTrackedDb } from "./changeLog";
import { performUndo } from "./orgChanges";
import { answerTeamSessionFromTranscript } from "./messages";
import { turnOpener } from "./lib/userSend";
import { applyPatches, dispatch } from "./dispatch";
import { computeInboxSessions, stampInboxViewerFields } from "./conversations";
import { enqueuePendingMessage, performSessionSend } from "./pendingMessages";
import { cliSetSessionVisibility, setPrivacy } from "./conversations";
import { updatePermissionStatus } from "./permissions";
import { patchConversationVisibility } from "./lib/conversationVisibility";
import { deliverSessionNotificationToParties } from "./lib/sessionNotify";

const ASHOT = "u".repeat(31) + "a";
const JASON = "u".repeat(31) + "j";
const SAM = "u".repeat(31) + "s";
const BOT = "u".repeat(31) + "b";
const CONV = "c".repeat(32);
const TEAM = "t".repeat(32);

function world(opts: { flag?: boolean; owners?: string[] } = {}) {
  const db = makeFakeDb({
    users: [
      { _id: ASHOT, name: "Ashot", notifications_enabled: true, active_team_id: TEAM },
      { _id: JASON, name: "Jason", notifications_enabled: true, active_team_id: TEAM },
      { _id: SAM, name: "Sam", notifications_enabled: true, active_team_id: TEAM },
      { _id: BOT, name: "Mr Bot", is_bot: true },
    ],
    teams: [{ _id: TEAM, name: "Union", invite_code: "U", created_at: 1, ...(opts.flag === false ? {} : { features: { team_sessions: true } }) }],
    team_memberships: [ASHOT, JASON, SAM, BOT].map((id) => ({ _id: `m-${id}`, team_id: TEAM, user_id: id, role: "member", visibility: "full" })),
    conversations: [{ _id: CONV, short_id: "jx7team", session_id: "sess-team", user_id: JASON, team_id: TEAM, is_private: true, title: "Fee judge rewrite", status: "active", agent_type: "claude_code", updated_at: 1 }],
    session_owners: (opts.owners ?? [JASON]).map((id, i) => ({ _id: `so-${i}`, conversation_id: CONV, user_id: id, added_by: id, added_at: i + 1, seen_at: i + 1 })),
    session_team_owners: [],
    session_viewer_triage: [],
    org_change_batches: [],
    org_changes: [],
    pending_permissions: [],
    org_roles: [],
    tasks: [],
    authority_events: [],
    notifications: [],
    push_outbox: [],
    pending_messages: [],
    directory_team_mappings: [],
    rate_limits: [],
    change_log: [],
    local_view_heads: [],
    devices: [],
    daemon_commands: [],
  });
  const ctxAs = (userId: string): any => ({
    db,
    auth: { getUserIdentity: async () => ({ subject: `${userId}|session`, tokenIdentifier: "t" }) },
    scheduler: { runAfter: async () => undefined },
    runMutation: async () => undefined,
    runQuery: async () => undefined,
  });
  return { db, ctxAs, conv: () => db._tables.conversations.find((c: any) => c._id === CONV) };
}

const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, { session_id: CONV, ...args });
const makeTeam = (w: ReturnType<typeof world>, by = JASON) => invoke(setSessionOwners, w.ctxAs(by), { owners: ["everyone"] });

describe("making a team session", () => {
  test("is refused while the team has Team sessions off", async () => {
    const w = world({ flag: false });
    await expect(makeTeam(w)).rejects.toThrow();
    expect(w.db._tables.session_team_owners).toHaveLength(0);
  });

  test("the team owns it, no person does, and the team reads it whole", async () => {
    const w = world();
    await makeTeam(w);
    expect(w.db._tables.session_team_owners).toHaveLength(1);
    expect(w.db._tables.session_owners).toHaveLength(0);
    expect(w.conv()).toMatchObject({ is_private: false, team_visibility: "full" });
    for (const id of [ASHOT, JASON, SAM]) expect(await isSessionOwner(w as any, CONV as any, id as any)).toBe(true);
    // In every member's inbox.
    expect((await ownerRowsForUser(w as any, SAM as any, 50)).rows.map((r) => String(r.conversation_id))).toEqual([CONV]);
  });

  test("Take ownership puts it back in one person's hands", async () => {
    const w = world();
    await makeTeam(w);
    await invoke(setSessionOwners, w.ctxAs(SAM), { owners: ["me"] });
    expect(w.db._tables.session_team_owners).toHaveLength(0);
    expect(w.db._tables.session_owners.map((r: any) => r.user_id)).toEqual([SAM]);
    expect(await isSessionOwner(w as any, CONV as any, ASHOT as any)).toBe(false);
  });
});

describe("triage on a team session is each person's own", () => {
  test("Sam's dismiss, stash, snooze and pin move it for Sam only", async () => {
    const w = world();
    await makeTeam(w);
    const at = 1_000;
    await applyPatches(w.ctxAs(SAM), SAM as any, { conversations: { [CONV]: { inbox_dismissed_at: at, inbox_pinned_at: at + 1, inbox_snoozed_until: at + 2 } } });
    expect(w.conv().inbox_dismissed_at).toBeUndefined();
    expect(w.conv().inbox_pinned_at).toBeUndefined();
    const samRow: any = {}; const ashotRow: any = {};
    await stampInboxViewerFields(samRow, w.conv(), SAM as any, await sessionOwnerRow(w as any, CONV as any, SAM as any), (id) => w.db.get(id));
    await stampInboxViewerFields(ashotRow, w.conv(), ASHOT as any, await sessionOwnerRow(w as any, CONV as any, ASHOT as any), (id) => w.db.get(id));
    expect(samRow).toMatchObject({ inbox_dismissed_at: at, inbox_pinned_at: at + 1, is_pinned: true, inbox_snoozed_until: at + 2 });
    expect(ashotRow).toMatchObject({ inbox_dismissed_at: null, inbox_pinned_at: null, is_pinned: false });
    // Undoing clears Sam's own stamp.
    await applyPatches(w.ctxAs(SAM), SAM as any, { conversations: { [CONV]: { inbox_dismissed_at: null } } });
    const again: any = {};
    await stampInboxViewerFields(again, w.conv(), SAM as any, await sessionOwnerRow(w as any, CONV as any, SAM as any), (id) => w.db.get(id));
    expect(again.inbox_dismissed_at).toBeNull();
  });

  test("a kill ends it for everyone", async () => {
    const w = world();
    await makeTeam(w);
    await applyPatches(w.ctxAs(SAM), SAM as any, { conversations: { [CONV]: { inbox_killed_at: 5, inbox_dismissed_at: 5 } } }, { forceKill: true });
    expect(w.conv().inbox_killed_at).toBe(5);
    expect(w.db._tables.session_viewer_triage).toHaveLength(0);
  });

  test("a session nobody made a team session keeps the shared stamps", async () => {
    const w = world();
    await applyPatches(w.ctxAs(JASON), JASON as any, { conversations: { [CONV]: { inbox_dismissed_at: 7 } } });
    expect(w.conv().inbox_dismissed_at).toBe(7);
  });
});

describe("writing in a team session", () => {
  test("never claims it, and clears the rest of the team's needs-input alerts", async () => {
    const w = world();
    await makeTeam(w);
    await deliverSessionNotificationToParties(w.ctxAs(JASON), w.conv(), "session_idle", "Needs input", "Raise the gate to 92%?");
    const unread = () => w.db._tables.notifications.filter((n: any) => !n.read && n.type === "session_idle").map((n: any) => n.recipient_user_id).sort();
    expect(unread()).toEqual([ASHOT, JASON, SAM].sort());
    await performSessionSend(w.ctxAs(SAM), SAM as any, { to: "jx7team", body: "Raise it to 92." });
    expect(w.db._tables.session_owners).toHaveLength(0);
    expect(unread()).toEqual([]);
    expect(w.conv()).toMatchObject({ team_answered_by: SAM });
  });
});

describe("starting a team session from the composer", () => {
  const start = (w: ReturnType<typeof world>, by: string) =>
    (dispatch as any)._handler(w.ctxAs(by), { action: "createSession", args: [{ agent_type: "claude_code", project_path: "/repo", session_id: "s-new", team: true }] });

  test("the team owns it from the first write", async () => {
    const w = world();
    await start(w, ASHOT);
    const conv = w.db._tables.conversations.find((c: any) => c.session_id === "s-new");
    expect(conv).toMatchObject({ team_id: TEAM, is_private: false, team_visibility: "full" });
    expect(w.db._tables.session_team_owners.map((r: any) => r.conversation_id)).toEqual([conv._id]);
    expect(w.db._tables.session_owners.filter((r: any) => r.conversation_id === conv._id)).toHaveLength(0);
  });

  test("with Team sessions off it starts as an ordinary session", async () => {
    const w = world({ flag: false });
    await start(w, ASHOT);
    expect(w.db._tables.session_team_owners).toHaveLength(0);
    expect(w.db._tables.conversations.find((c: any) => c.session_id === "s-new")).toBeTruthy();
  });
});

describe("the flag holds for a single added owner too", () => {
  test("addSessionOwner everyone is refused with the feature off", async () => {
    const w = world({ flag: false });
    await expect(invoke(addSessionOwner, w.ctxAs(ASHOT), { owner: "everyone" })).rejects.toThrow();
  });
});

describe("review fixes", () => {
  const alertsFor = (w: ReturnType<typeof world>, type: string) =>
    w.db._tables.notifications.filter((n: any) => !n.read && n.type === type).map((n: any) => n.recipient_user_id).sort();

  test("3: a team session cannot be made private, by a person or a sweep", async () => {
    const w = world();
    await makeTeam(w);
    await expect((setPrivacy as any)._handler(w.ctxAs(JASON), { conversation_id: CONV, is_private: true })).rejects.toThrow(/team session/i);
    await expect((dispatch as any)._handler(w.ctxAs(JASON), { action: "setPrivacy", args: [CONV, true] })).rejects.toThrow(/team session/i);
    await patchConversationVisibility(w as any, w.conv(), { is_private: true, team_visibility: "private" });
    expect(w.conv()).toMatchObject({ is_private: false, team_visibility: "full" });
    expect(await isSessionOwner(w as any, CONV as any, SAM as any)).toBe(true);
  });

  test("4: adding the team to a session people own takes the people off, so each keeps their own triage", async () => {
    const w = world({ owners: [JASON, ASHOT] });
    await invoke(addSessionOwner, w.ctxAs(JASON), { owner: "everyone" });
    expect(w.db._tables.session_owners).toHaveLength(0);
    await applyPatches(w.ctxAs(ASHOT), ASHOT as any, { conversations: { [CONV]: { inbox_dismissed_at: 9 } } });
    const row: any = {};
    await stampInboxViewerFields(row, w.conv(), ASHOT as any, await sessionOwnerRow(w as any, CONV as any, ASHOT as any), (id) => w.db.get(id));
    expect(row.inbox_dismissed_at).toBe(9);
    expect(w.conv().inbox_dismissed_at).toBeUndefined();
    // And adding a person to a team session makes it theirs again.
    await invoke(addSessionOwner, w.ctxAs(JASON), { owner: SAM });
    expect(w.db._tables.session_team_owners).toHaveLength(0);
  });

  test("5: a web or phone composer send clears the team's alerts, and so does answering a permission", async () => {
    const w = world();
    await makeTeam(w);
    await deliverSessionNotificationToParties(w.ctxAs(JASON), w.conv(), "session_idle", "Needs input", "Raise it?");
    await enqueuePendingMessage(w.ctxAs(SAM), w.conv(), SAM as any, { content: "yes", human: true });
    expect(alertsFor(w, "session_idle")).toEqual([]);
    expect(w.conv().team_answered_by).toBe(SAM);

    await deliverSessionNotificationToParties(w.ctxAs(JASON), w.conv(), "permission_request", "Permission", "Run the migration?");
    w.db._tables.pending_permissions.push({ _id: "perm1", conversation_id: CONV, status: "pending", tool_name: "Bash", created_at: 1 });
    await (updatePermissionStatus as any)._handler(w.ctxAs(JASON), { permission_id: "perm1", status: "approved" });
    expect(alertsFor(w, "permission_request")).toEqual([]);
  });

  test("6: writing in a team session brings it back for the writer", async () => {
    const w = world();
    await makeTeam(w);
    await applyPatches(w.ctxAs(SAM), SAM as any, { conversations: { [CONV]: { inbox_dismissed_at: 3, inbox_pinned_at: 4 } } });
    await enqueuePendingMessage(w.ctxAs(SAM), w.conv(), SAM as any, { content: "back on it", human: true });
    const row: any = {};
    await stampInboxViewerFields(row, w.conv(), SAM as any, await sessionOwnerRow(w as any, CONV as any, SAM as any), (id) => w.db.get(id));
    expect(row.inbox_dismissed_at).toBeNull();
    expect(row.inbox_pinned_at).toBe(4);
  });

  test("7: a CLI stash of a team session is the stasher's own", async () => {
    const w = world();
    await makeTeam(w);
    await (cliSetSessionVisibility as any)._handler(w.ctxAs(JASON), { session: "jx7team", action: "dismiss" });
    expect(w.conv().inbox_stashed_at).toBeUndefined();
    const mine: any = {}; const sams: any = {};
    await stampInboxViewerFields(mine, w.conv(), JASON as any, await sessionOwnerRow(w as any, CONV as any, JASON as any), (id) => w.db.get(id));
    await stampInboxViewerFields(sams, w.conv(), SAM as any, await sessionOwnerRow(w as any, CONV as any, SAM as any), (id) => w.db.get(id));
    expect(mine.inbox_stashed_at).toBeTruthy();
    expect(sams.inbox_stashed_at).toBeNull();
  });

  test("10: an agent account on the team is not an owner of a team session", async () => {
    const w = world();
    await makeTeam(w);
    expect(await isSessionOwner(w as any, CONV as any, BOT as any)).toBe(false);
    expect((await ownerRowsForUser(w as any, BOT as any, 50)).rows).toHaveLength(0);
  });
});

describe("review round 2", () => {
  test("1: team sessions have their own window, newest activity first; past it the window says so", async () => {
    const w = world();
    // An old session Ashot owns as a person, from before the team ones.
    w.db._tables.conversations.push({ _id: "c-old", short_id: "jx7oldd", user_id: JASON, team_id: TEAM, is_private: false, status: "active", updated_at: 1 });
    w.db._tables.session_owners.push({ _id: "so-old", conversation_id: "c-old", user_id: ASHOT, added_by: JASON, added_at: 0 });
    for (let i = 0; i < 201; i++) {
      w.db._tables.conversations.push({ _id: `c-${i}`, user_id: JASON, team_id: TEAM, team_owner_team_id: TEAM, is_private: false, status: "active", updated_at: 100 + i });
      w.db._tables.session_team_owners.push({ _id: `sto-${i}`, conversation_id: `c-${i}`, team_id: TEAM, added_by: JASON, added_at: 1 });
    }
    const r = await ownerRowsForUser(w as any, ASHOT as any, 200);
    expect(r.truncated).toBe(true);
    expect(r.rows.some((x: any) => x.conversation_id === "c-old")).toBe(true);
    // The least recently active one is the one past the window.
    expect(r.rows.some((x: any) => x.conversation_id === "c-0")).toBe(false);
    // A killed one leaves the window.
    w.db._tables.conversations.find((c: any) => c._id === "c-200").inbox_killed_at = 5;
    expect((await ownerRowsForUser(w as any, ASHOT as any, 200)).rows.some((x: any) => x.conversation_id === "c-200")).toBe(false);
  });

  test("2: Take ownership removes the team row even after the session moved team; low-level writers never add a person to a team session", async () => {
    const w = world();
    w.db._tables.teams.push({ _id: "t-other", name: "Other", invite_code: "O", created_at: 1, features: { team_sessions: true } });
    w.db._tables.team_memberships.push({ _id: "m-other", team_id: "t-other", user_id: JASON, role: "member" });
    await makeTeam(w);
    w.conv().team_id = "t-other"; // reconfigured to another team
    expect(await addSessionOwnerRow(w as any, CONV as any, ASHOT as any, JASON as any)).toBe(false);
    expect(await setSessionOwnerRows(w as any, CONV as any, [ASHOT], JASON as any)).toBe(false);
    expect(w.db._tables.session_owners).toHaveLength(0);
    await invoke(setSessionOwners, w.ctxAs(JASON), { owners: ["me"] });
    expect(w.db._tables.session_team_owners).toHaveLength(0);
    expect(w.db._tables.session_owners.map((r: any) => r.user_id)).toEqual([JASON]);
  });

  test("3: a background hold change never turns a team session personal", async () => {
    const w = world();
    await makeTeam(w);
    expect(await applyHoldChange(w.ctxAs(JASON), CONV as any)).toEqual({ change: "keep" });
    expect(w.db._tables.session_team_owners).toHaveLength(1);
  });

  test("4: a teammate who does not run it can stash, restore and kill it from the CLI", async () => {
    const w = world();
    await makeTeam(w);
    await (cliSetSessionVisibility as any)._handler(w.ctxAs(SAM), { session: "jx7team", action: "dismiss" });
    const mine = await sessionOwnerRow(w as any, CONV as any, SAM as any);
    expect(mine.triage.inbox_stashed_at).toBeTruthy();
    expect(w.conv().inbox_stashed_at).toBeUndefined();
    await (cliSetSessionVisibility as any)._handler(w.ctxAs(SAM), { session: "jx7team", action: "undismiss" });
    expect((await sessionOwnerRow(w as any, CONV as any, SAM as any)).triage.inbox_stashed_at).toBeUndefined();
    // Every mutation's db is the change-tracked one in production (functions.ts).
    await (cliSetSessionVisibility as any)._handler({ ...w.ctxAs(SAM), db: makeChangeTrackedDb(w.db) }, { session: "jx7team", action: "kill" });
    expect(w.conv().inbox_dismissed_at).toBeTruthy();
    expect(w.conv().inbox_killed_at).toBeTruthy();
  });
});

describe("answered", () => {
  test("a first message into a team session nobody was waiting on records no answer", async () => {
    const w = world();
    await makeTeam(w);
    await enqueuePendingMessage(w.ctxAs(JASON), w.conv(), JASON as any, { content: "kick off", human: true });
    expect(w.conv().team_answered_by).toBeUndefined();
  });
});

describe("review round 3", () => {

  test("1: a kill from the web (killSession, the patch the client sends) ends it for everyone", async () => {
    const w = world();
    await makeTeam(w);
    const at = 1234;
    await (dispatch as any)._handler(w.ctxAs(SAM), { action: "killSession", args: [CONV], patches: { conversations: { [CONV]: { inbox_dismissed_at: at } } } });
    expect(w.conv().inbox_dismissed_at).toBe(at);
    expect(w.db._tables.session_viewer_triage.filter((r: any) => r.inbox_dismissed_at)).toHaveLength(0);
    // A close is still that person's own.
    const w2 = world();
    await makeTeam(w2);
    await (dispatch as any)._handler(w2.ctxAs(SAM), { action: "closeSession", args: [CONV], patches: { conversations: { [CONV]: { inbox_dismissed_at: at, inbox_closed_at: at } } } });
    expect(w2.conv().inbox_dismissed_at).toBeUndefined();
  });

  test("2: a session's message or a wake is no answer; only a turn a person opened is", async () => {
    const w = world();
    await makeTeam(w);
    await deliverSessionNotificationToParties(w.ctxAs(JASON), w.conv(), "session_idle", "Needs input", "Raise it?");
    const machine = turnOpener(w.conv(), { role: "user", content: '<session-message from="jx7abcd">CI is green</session-message>' } as any);
    expect(machine?.origin).not.toBe("person");
    await answerTeamSessionFromTranscript(w as any, w.conv(), machine);
    await answerTeamSessionFromTranscript(w as any, w.conv(), { origin: "person", by: BOT as any });
    expect(w.db._tables.notifications.filter((n: any) => !n.read && n.type === "session_idle").length).toBe(3);
    expect(w.conv().team_answered_by).toBeUndefined();
  });

  test("3: a Done (completed) team session stays in everyone's window", async () => {
    const w = world();
    await makeTeam(w);
    await makeChangeTrackedDb(w.db).patch(CONV, { status: "completed" });
    expect((await ownerRowsForUser(w as any, SAM as any, 200)).rows.map((r: any) => r.conversation_id)).toEqual([CONV]);
  });

  test("4: a killed team session leaves every window, and a web restore brings it back for everyone", async () => {
    const w = world();
    await makeTeam(w);
    const at = 77;
    await (dispatch as any)._handler(w.ctxAs(SAM), { action: "killSession", args: [CONV], patches: { conversations: { [CONV]: { inbox_dismissed_at: at } } } });
    expect(w.conv().inbox_killed_at).toBeTruthy();
    expect((await ownerRowsForUser(w as any, ASHOT as any, 200)).rows).toHaveLength(0);
    await (dispatch as any)._handler(w.ctxAs(JASON), { action: "restoreSession", args: [CONV], patches: { conversations: { [CONV]: { inbox_dismissed_at: null, inbox_stashed_at: null, inbox_snoozed_until: null, inbox_killed_at: null } } } });
    expect(w.conv().inbox_killed_at).toBeUndefined();
    expect(w.conv().inbox_dismissed_at).toBeUndefined();
    const sams = await ownerRowsForUser(w as any, SAM as any, 200);
    expect(sams.rows.map((r: any) => r.conversation_id)).toEqual([CONV]);
  });
});

describe("review round 4", () => {
  test("1: cast undismiss of a killed team session brings it back to the team", async () => {
    const w = world();
    await makeTeam(w);
    await (cliSetSessionVisibility as any)._handler(w.ctxAs(JASON), { session: "jx7team", action: "kill" });
    expect((await ownerRowsForUser(w as any, SAM as any, 200)).rows).toHaveLength(0);
    await (cliSetSessionVisibility as any)._handler(w.ctxAs(JASON), { session: "jx7team", action: "undismiss" });
    expect((await ownerRowsForUser(w as any, SAM as any, 200)).rows.map((r: any) => r.conversation_id)).toEqual([CONV]);
  });

  test("2: the agent stopping (completed) leaves a waiting team session with the team", async () => {
    const w = world();
    await makeTeam(w);
    await deliverSessionNotificationToParties(w.ctxAs(JASON), w.conv(), "session_idle", "Needs input", "Raise it?");
    await makeChangeTrackedDb(w.db).patch(CONV, { status: "completed" }); // markSessionCompleted when the process stops
    for (const id of [ASHOT, SAM]) expect((await ownerRowsForUser(w as any, id as any, 200)).rows.map((r: any) => r.conversation_id)).toEqual([CONV]);
  });

  test("4: an ordinary co-owner's cast kill stays a viewer hide (no widening outside team sessions)", async () => {
    const w = world({ owners: [JASON, ASHOT] });
    w.conv().owner_user_id = JASON;
    w.db._tables.inbox_hides = [];
    await (cliSetSessionVisibility as any)._handler(w.ctxAs(ASHOT), { session: "jx7team", action: "kill" }).catch(() => undefined);
    expect(w.conv().inbox_dismissed_at).toBeUndefined();
    expect(w.conv().inbox_killed_at).toBeUndefined();
  });
});

describe("before the flag goes on for a real team", () => {
  test("1: making a moved session a team session again belongs to the new team only", async () => {
    const w = world();
    w.db._tables.teams.push({ _id: "t-b", name: "B", invite_code: "B", created_at: 1, features: { team_sessions: true } });
    w.db._tables.team_memberships.push({ _id: "m-jb", team_id: "t-b", user_id: JASON, role: "member" });
    await makeTeam(w);
    w.conv().team_id = "t-b";
    await invoke(setSessionOwners, w.ctxAs(JASON), { owners: ["everyone"] });
    expect(w.db._tables.session_team_owners.map((r: any) => r.team_id)).toEqual(["t-b"]);
    expect(w.conv().team_owner_team_id).toBe("t-b");
    expect(await isSessionOwner(w as any, CONV as any, ASHOT as any)).toBe(false);
  });

  test("2: killed team sessions do not use up the window, and one waiting on you stays past it", async () => {
    const w = world();
    for (let i = 0; i < 200; i++) {
      w.db._tables.conversations.push({ _id: `k-${i}`, user_id: JASON, team_id: TEAM, team_owner_team_id: TEAM, is_private: false, status: "active", updated_at: 1000 + i, inbox_killed_at: 5 });
    }
    w.db._tables.conversations.push({ _id: "live", user_id: JASON, team_id: TEAM, team_owner_team_id: TEAM, is_private: false, status: "active", updated_at: 10 });
    const r = await ownerRowsForUser(w as any, SAM as any, 200);
    expect(r.rows.map((x: any) => x.conversation_id)).toContain("live");
    // A quiet one waiting on Sam, past a full window of busier ones.
    for (let i = 0; i < 200; i++) w.db._tables.conversations.push({ _id: `b-${i}`, user_id: JASON, team_id: TEAM, team_owner_team_id: TEAM, is_private: false, status: "active", updated_at: 5000 + i });
    w.db._tables.notifications.push({ _id: "n-wait", recipient_user_id: SAM, conversation_id: "live", type: "session_idle", read: false, created_at: 1 });
    expect((await ownerRowsForUser(w as any, SAM as any, 200)).rows.map((x: any) => x.conversation_id)).toContain("live");
  });

  test("3: undoing Take ownership from org history makes it a team session again", async () => {
    const w = world();
    await makeTeam(w);
    const res = await invoke(setSessionOwners, w.ctxAs(SAM), { owners: ["me"] });
    expect(w.db._tables.session_team_owners).toHaveLength(0);
    const batch = w.db._tables.org_change_batches.at(-1);
    expect(batch).toBeTruthy();
    await performUndo(w.ctxAs(SAM), SAM as any, { batch: String(batch._id) });
    expect(w.db._tables.session_team_owners.map((r: any) => r.team_id)).toEqual([TEAM]);
    expect(w.db._tables.session_owners).toHaveLength(0);
    expect(w.conv().team_owner_team_id).toBe(TEAM);
    void res;
  });
});

describe("review of v6", () => {
  test("1: a team ref names only the session's own team; it never moves a session to another team", async () => {
    const w = world();
    w.db._tables.teams.push({ _id: "t-b", name: "B", invite_code: "B", created_at: 1, features: { team_sessions: true } });
    w.db._tables.team_memberships.push({ _id: "m-jb", team_id: "t-b", user_id: JASON, role: "member" });
    await expect(invoke(setSessionOwners, w.ctxAs(JASON), { owners: ["team:t-b"] })).rejects.toThrow(/own team/);
    expect(w.conv().team_id).toBe(TEAM);
    expect(w.db._tables.session_owners.map((r: any) => r.user_id)).toEqual([JASON]);
  });

  test("2: with no team session in any window, the scan reads no notifications", async () => {
    const w = world();
    w.db._tables.notifications.push({ _id: "n1", recipient_user_id: SAM, conversation_id: CONV, type: "session_idle", read: false, created_at: 1 });
    const reads: string[] = [];
    const db = new Proxy(w.db, { get(t: any, p) { if (p === "query") return (table: string) => { reads.push(table); return t.query(table); }; return t[p]; } });
    expect((await ownerRowsForUser({ db } as any, SAM as any, 200)).rows).toHaveLength(0);
    expect(reads).not.toContain("notifications");
  });
});

describe("review of v7", () => {
  test("1: a teamless session made a team session goes to its runner's team, never the caller's; an empty team ref is refused", async () => {
    const w = world({ owners: [JASON, SAM] });
    w.db._tables.teams.push({ _id: "t-b", name: "B", invite_code: "B", created_at: 1, features: { team_sessions: true } });
    w.db._tables.team_memberships.push({ _id: "m-sb", team_id: "t-b", user_id: SAM, role: "member", visibility: "full" });
    w.db._tables.users.find((u: any) => u._id === SAM).active_team_id = "t-b";
    delete w.conv().team_id;
    await expect(invoke(setSessionOwners, w.ctxAs(SAM), { owners: ["team:"] })).rejects.toThrow(/own team/);
    await invoke(setSessionOwners, w.ctxAs(SAM), { owners: ["everyone"] });
    expect(w.db._tables.session_team_owners.map((r: any) => r.team_id)).toEqual([TEAM]);
    expect(w.conv().team_owner_team_id).toBe(TEAM);
  });

  test("2: an agent account reads no team window at all", async () => {
    const w = world();
    await makeTeam(w);
    const reads: string[] = [];
    const db = new Proxy(w.db, { get(t: any, p) { if (p === "query") return (table: string) => { reads.push(table); return t.query(table); }; return t[p]; } });
    expect((await ownerRowsForUser({ db } as any, BOT as any, 200)).rows).toHaveLength(0);
    expect(reads).not.toContain("conversations");
    expect(reads).not.toContain("notifications");
  });

  test("3: teams past the tenth count as overflowed, so their sessions are recovered by id", async () => {
    const w = world();
    await makeTeam(w);
    const m = w.db._tables.team_memberships;
    const mine = m.findIndex((r: any) => r.user_id === ASHOT && r.team_id === TEAM);
    const [row] = m.splice(mine, 1);
    for (let i = 0; i < 10; i++) {
      w.db._tables.teams.push({ _id: `t-${i}`, name: `T${i}`, invite_code: `T${i}`, created_at: 1 });
      m.push({ _id: `m-a${i}`, team_id: `t-${i}`, user_id: ASHOT, role: "member", visibility: "full" });
    }
    m.push(row);
    const r = await teamOwnerRowsForUser(w as any, ASHOT as any, 200);
    expect(r.truncated).toBe(true);
    expect(r.truncatedTeamIds).toContain(TEAM);
    // One waiting on Ashot comes back by its alert even with no other team window.
    w.db._tables.notifications.push({ _id: "n-w", recipient_user_id: ASHOT, conversation_id: CONV, type: "session_idle", read: false, created_at: 2 });
    expect((await teamOwnerRowsForUser(w as any, ASHOT as any, 200)).rows.map((x: any) => x.conversation_id)).toEqual([CONV]);
  });
});

describe("review of v8", () => {
  test("1: a teamless session an agent runs never moves to a team its people are not on", async () => {
    const w = world({ owners: [JASON, ASHOT] });
    w.db._tables.teams.push({ _id: "t-b", name: "B", invite_code: "B", created_at: 1, features: { team_sessions: true } });
    w.db._tables.team_memberships.push({ _id: "m-bb", team_id: "t-b", user_id: BOT, role: "member", visibility: "full" });
    w.db._tables.team_memberships.push({ _id: "m-ab", team_id: "t-b", user_id: ASHOT, role: "member", visibility: "full" });
    w.db._tables.team_memberships.splice(w.db._tables.team_memberships.findIndex((m: any) => m.user_id === JASON), 1);
    w.db._tables.users.find((u: any) => u._id === BOT).active_team_id = "t-b";
    w.db._tables.users.find((u: any) => u._id === ASHOT).active_team_id = "t-b";
    const c = w.conv(); c.user_id = BOT; delete c.team_id;
    await expect(invoke(setSessionOwners, w.ctxAs(ASHOT), { owners: ["everyone"] })).rejects.toThrow(/Every owner/);
    expect(w.db._tables.session_owners.map((r: any) => r.user_id).sort()).toEqual([ASHOT, JASON].sort());
    expect(w.db._tables.session_team_owners).toHaveLength(0);
  });

  test("2: a session the runner locked private opens to the team only by the runner", async () => {
    const w = world({ owners: [JASON, SAM] });
    w.conv().team_visibility = "private";
    await expect(invoke(setSessionOwners, w.ctxAs(SAM), { owners: ["everyone"] })).rejects.toThrow(/private/);
    expect(w.conv().team_visibility).toBe("private");
    await invoke(setSessionOwners, w.ctxAs(JASON), { owners: ["everyone"] });
    expect(w.conv().team_owner_team_id).toBe(TEAM);
  });

  test("3: a member who does not run it finds a team session by name", async () => {
    const w = world();
    await makeTeam(w);
    const r: any = await computeInboxSessions({ db: w.db } as any, SAM as any, { show_all: true, projection: true, extraConvIds: [CONV], namedOnly: true });
    expect(r.sessions.map((s: any) => String(s._id))).toContain(CONV);
  });

  test("4: teams past the tenth report the inbox as truncated", async () => {
    const w = world();
    await makeTeam(w);
    const m = w.db._tables.team_memberships;
    const [row] = m.splice(m.findIndex((r: any) => r.user_id === ASHOT && r.team_id === TEAM), 1);
    for (let i = 0; i < 10; i++) {
      w.db._tables.teams.push({ _id: `t-${i}`, name: `T${i}`, invite_code: `T${i}`, created_at: 1 });
      m.push({ _id: `m-a${i}`, team_id: `t-${i}`, user_id: ASHOT, role: "member", visibility: "full" });
    }
    m.push(row);
    const r: any = await computeInboxSessions({ db: w.db } as any, ASHOT as any, { show_all: true, projection: true });
    expect(r.truncated).toContain("owned");
  });
});

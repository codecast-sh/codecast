// Access control for the collaborative doc sync backend (docSync.ts).
//
// The OT endpoints key entirely off a caller-supplied string id. Before the
// gate, any authenticated user could read AND write any doc's full content by
// guessing or capturing its id: getSnapshot returned the content, submitSnapshot
// patched doc.content. The sync data IS the doc, so every endpoint must require
// access to the underlying entity — a real `docs` row, or the conversation
// behind a synthetic "compose:<convId>" / "comment:<convId>" id.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  getSnapshot,
  submitSnapshot,
  latestVersion,
  getSteps,
  submitSteps,
  getPresence,
  updatePresence,
} from "./docSync";

const OWNER = "u_owner";
const MEMBER = "u_member";
const STRANGER = "u_stranger";
const TEAM = "t_team";

const TEAM_DOC = "doc_team";
const PRIVATE_DOC = "doc_private_linked";
const PRIVATE_CONV = "conv_private";
const SHARED_CONV = "conv_shared";
const LINKED_CONV = "conv_linked";

const DOC_JSON = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "secret contents" }] }],
});

function tables(): Record<string, any[]> {
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
    conversations: [
      { _id: PRIVATE_CONV, user_id: OWNER, team_id: TEAM, is_private: true },
      { _id: SHARED_CONV, user_id: OWNER, team_id: TEAM, is_private: false },
      // Private, but the stranger redeemed its share link (opened /share/<token>).
      { _id: LINKED_CONV, user_id: OWNER, team_id: TEAM, is_private: true, share_token: "tok" },
    ],
    share_redemptions: [
      { _id: "red_1", conversation_id: LINKED_CONV, user_id: STRANGER, token: "tok" },
    ],
    docs: [
      // Plain team doc: whole team may sync it.
      { _id: TEAM_DOC, user_id: OWNER, team_id: TEAM, title: "Team doc", content: "old" },
      // Team-tagged but linked to a PRIVATE conversation: effective team is
      // none, so only the owner may sync it.
      {
        _id: PRIVATE_DOC,
        user_id: OWNER,
        team_id: TEAM,
        conversation_id: PRIVATE_CONV,
        title: "Mined from private session",
        content: "old",
      },
    ],
    doc_snapshots: [
      { _id: "snap_1", id: TEAM_DOC, version: 1, content: DOC_JSON },
      { _id: "snap_2", id: PRIVATE_DOC, version: 1, content: DOC_JSON },
      { _id: "snap_3", id: `compose:${PRIVATE_CONV}`, version: 1, content: DOC_JSON },
    ],
    doc_deltas: [
      { _id: "delta_1", id: TEAM_DOC, version: 2, clientId: "c1", steps: ["s1"] },
      { _id: "delta_2", id: PRIVATE_DOC, version: 2, clientId: "c1", steps: ["s1"] },
    ],
    doc_presence: [
      {
        _id: "pres_1",
        doc_id: PRIVATE_DOC,
        user_id: OWNER,
        user_name: "Owner",
        user_color: "#fff",
        draft_text: "secret draft",
        updated_at: Date.now(),
      },
    ],
  };
}

function ctx(userId: string | null, t: Record<string, any[]> = tables()) {
  return {
    auth: {
      async getUserIdentity() {
        return userId ? { subject: `${userId}|session` } : null;
      },
    },
    db: makeFakeDb(t),
    runMutation: async () => null,
    scheduler: { runAfter: async () => null },
  } as any;
}

const run = (fn: any, userId: string | null, args: any, t?: Record<string, any[]>) =>
  (fn as any)._handler(ctx(userId, t), args);

describe("docSync OT endpoints require access to the underlying doc", () => {
  test("a stranger cannot read a doc snapshot", async () => {
    await expect(run(getSnapshot, STRANGER, { id: TEAM_DOC })).rejects.toThrow();
  });

  test("a stranger cannot read steps, latestVersion, or push steps", async () => {
    await expect(run(getSteps, STRANGER, { id: TEAM_DOC, version: 0 })).rejects.toThrow();
    await expect(run(latestVersion, STRANGER, { id: TEAM_DOC })).rejects.toThrow();
    await expect(
      run(submitSteps, STRANGER, { id: TEAM_DOC, version: 2, clientId: "x", steps: ["evil"] }),
    ).rejects.toThrow();
  });

  test("a stranger cannot overwrite a doc via submitSnapshot", async () => {
    const t = tables();
    await expect(
      run(submitSnapshot, STRANGER, { id: TEAM_DOC, version: 9, content: DOC_JSON }, t),
    ).rejects.toThrow();
    expect(t.docs.find((d) => d._id === TEAM_DOC)?.content).toBe("old");
    expect(t.doc_snapshots.some((s) => s.version === 9)).toBe(false);
  });

  test("a teammate CAN sync a plain team doc", async () => {
    const snap = await run(getSnapshot, MEMBER, { id: TEAM_DOC });
    expect(snap.version).toBe(1);
    const res = await run(submitSteps, MEMBER, {
      id: TEAM_DOC, version: 2, clientId: "m", steps: ["s2"],
    });
    expect(res.status).toBe("synced");
  });

  test("a doc linked to a private conversation is owner-only, even for teammates", async () => {
    await expect(run(getSnapshot, MEMBER, { id: PRIVATE_DOC })).rejects.toThrow();
    await expect(run(latestVersion, MEMBER, { id: PRIVATE_DOC })).rejects.toThrow();
    const snap = await run(getSnapshot, OWNER, { id: PRIVATE_DOC });
    expect(snap.version).toBe(1);
  });

  test("compose ids gate on the conversation: owner yes, stranger no", async () => {
    const snap = await run(getSnapshot, OWNER, { id: `compose:${PRIVATE_CONV}` });
    expect(snap.version).toBe(1);
    await expect(
      run(getSnapshot, STRANGER, { id: `compose:${PRIVATE_CONV}` }),
    ).rejects.toThrow();
    // Private conversation: routing team members are NOT visibility members.
    await expect(
      run(getSnapshot, MEMBER, { id: `compose:${PRIVATE_CONV}` }),
    ).rejects.toThrow();
  });

  test("compose id on a team-visible conversation admits teammates", async () => {
    const res = await run(latestVersion, MEMBER, { id: `compose:${SHARED_CONV}` });
    expect(res).toBeNull();
  });

  test("an unrecognized id shape fails closed", async () => {
    await expect(run(getSnapshot, OWNER, { id: "garbage-id" })).rejects.toThrow();
  });
});

describe("docSync presence requires access too", () => {
  test("a stranger cannot read live drafts on a doc they cannot access", async () => {
    await expect(run(getPresence, STRANGER, { doc_id: PRIVATE_DOC })).rejects.toThrow();
  });

  test("a stranger cannot write presence into a private composer", async () => {
    await expect(
      run(updatePresence, STRANGER, { doc_id: `compose:${PRIVATE_CONV}`, draft_text: "hi" }),
    ).rejects.toThrow();
  });

  test("a share-link redeemer outside the team reads composer presence", async () => {
    const rows = await run(getPresence, STRANGER, { doc_id: `compose:${LINKED_CONV}` });
    expect(Array.isArray(rows)).toBe(true);
  });

  test("a teammate reads presence on a team doc", async () => {
    const rows = await run(getPresence, MEMBER, { doc_id: TEAM_DOC });
    expect(Array.isArray(rows)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { webPatch } from "./docs";

// webPatch follows the doc's workspace, as webUpdate and the CLI patch do: a
// teammate may patch a team doc, nobody but the owner a personal one.

const OWNER = "u_owner";
const MATE = "u_mate";
const TEAM = "t_1";

const seed = (workspace: string) => makeFakeDb({
  users: [{ _id: OWNER }, { _id: MATE }],
  team_memberships: [{ _id: "m1", user_id: MATE, team_id: TEAM, role: "member" }],
  docs: [{ _id: "docs_1", user_id: OWNER, team_id: TEAM, workspace, content: "hello world", title: "d" }],
});
const patch = (db: any, user: string) => (webPatch as any)._handler(
  { db, auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) }, scheduler: { runAfter: async () => null } },
  { id: "docs_1", old_string: "world", new_string: "there" },
);

describe("docs.webPatch access", () => {
  test("a teammate patches a doc in the team workspace", async () => {
    const db = seed(`team:${TEAM}`);
    expect((await patch(db, MATE)).content).toBe("hello there");
  });

  test("a teammate cannot patch a doc private to its owner", async () => {
    const db = seed(`user:${OWNER}`);
    await expect(patch(db, MATE)).rejects.toThrow("Not authorized");
    expect(db._tables.docs[0].content).toBe("hello world");
  });

  test("the owner patches their own doc", async () => {
    const db = seed(`user:${OWNER}`);
    expect((await patch(db, OWNER)).content).toBe("hello there");
  });
});

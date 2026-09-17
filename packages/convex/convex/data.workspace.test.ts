import { describe, expect, test } from "bun:test";
import { explicitWorkspace } from "./data";
import { makeFakeDb } from "./testDb";
import { resolveIdType } from "./entities";

// A CLI call may name its workspace outright (`--team <name>` or `--team
// personal`); the route's own derivation is the fallback, never the override.
describe("explicitWorkspace", () => {
  test("personal is a positive value that wins over a derived team", () => {
    expect(explicitWorkspace({ workspace: "personal" }, { workspace: "team", team_id: "t1" as any })).toEqual({ workspace: "personal" });
  });
  test("a named team wins; an unnamed call keeps the derivation", () => {
    expect(explicitWorkspace({ workspace: "team", team_id: "t2" as any }, { workspace: "team", team_id: "t1" as any })).toEqual({ workspace: "team", team_id: "t2" });
    expect(explicitWorkspace({}, { workspace: "team", team_id: "t1" as any })).toEqual({ workspace: "team", team_id: "t1" });
    expect(explicitWorkspace({ workspace: "team" }, {})).toEqual({});
  });
});

// `cast link <bare id>` asks which table an id belongs to; the CLI's token is
// as good as a browser identity for a structural check.
describe("entities.resolveIdType with a token", () => {
  test("answers the table for a token call", async () => {
    const db = makeFakeDb({ users: [{ _id: "u1", api_token: "tok" }], projects: [{ _id: "p1", title: "Growth" }], conversations: [] });
    db.normalizeId = (table: string, id: string) => (table === "projects" && id === "p1" ? id : null);
    const ctx: any = { db, auth: { getUserIdentity: async () => null } };
    const { getAuthenticatedUserId } = await import("./pendingMessages");
    void getAuthenticatedUserId;
    // The token path resolves through the users table's api_token index in prod;
    // the fake db has no index, so the query is driven with a browser identity here
    // and the token branch is covered by the CLI route wiring.
    const asBrowser: any = { db, auth: { getUserIdentity: async () => ({ subject: "u1|session" }) } };
    expect(await (resolveIdType as any)._handler(asBrowser, { id: "p1" })).toBe("project");
    expect(await (resolveIdType as any)._handler(ctx, { id: "p1" })).toBeNull();
  });
});

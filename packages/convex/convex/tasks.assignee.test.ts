import { describe, expect, test } from "bun:test";
import { resolveAssigneeStr, resolveAssigneeToUserId } from "./tasks";

// In-memory stand-in for the Convex db surface these resolvers touch. Ids are
// "<table>:<n>"; crucially `get` THROWS on a malformed id, mirroring real
// Convex — that is the exact crash this fix is about (a raw name like
// "Jason Benn" reaching ctx.db.get).
function makeFakeDb(seed?: (insert: (t: string, doc: any) => string) => void) {
  const tables = new Map<string, Map<string, any>>();
  let counter = 0;
  const tableOf = (id: any) => String(id).split(":")[0];
  const isId = (id: any) => typeof id === "string" && /^[a-z_]+:\d+$/.test(id);
  const ensure = (t: string) => {
    if (!tables.has(t)) tables.set(t, new Map());
    return tables.get(t)!;
  };
  const insert = (table: string, doc: any) => {
    const id = `${table}:${++counter}`;
    ensure(table).set(id, { _id: id, ...doc });
    return id;
  };
  const db: any = {
    async get(id: any) {
      if (id == null) return null;
      if (!isId(id)) throw new Error(`Invalid argument 'id' for 'db.get': Unable to decode ID: ${id}`);
      return ensure(tableOf(id)).get(String(id)) ?? null;
    },
    normalizeId(table: string, id: any) {
      return isId(id) && tableOf(id) === table ? id : null;
    },
    query(table: string) {
      let rows = [...ensure(table).values()];
      const api: any = {
        withIndex(_name: string, fn: (q: any) => any) {
          const preds: Array<[string, any]> = [];
          const q: any = { eq: (f: string, v: any) => { preds.push([f, v]); return q; } };
          fn(q);
          rows = rows.filter((r) => preds.every(([f, v]) => r[f] === v));
          return api;
        },
        async first() { return rows[0] ?? null; },
        async collect() { return rows; },
      };
      return api;
    },
  };
  seed?.(insert);
  return { db, insert };
}

// A team where Samvit/Ashot have github_username == their lowercased name, but
// Jason does not (github_username unset) — the real-world asymmetry behind the
// bug. team_memberships link each user to the team.
function makeTeam() {
  let teamId = "";
  let jason = "", ashot = "";
  const { db } = makeFakeDb((insert) => {
    teamId = insert("teams", { name: "Union" });
    jason = insert("users", { name: "Jason Benn", email: "jason@union.app", active_team_id: teamId });
    ashot = insert("users", { name: "Ashot", email: "ashot@union.app", github_username: "ashot", active_team_id: teamId });
    insert("team_memberships", { team_id: teamId, user_id: jason });
    insert("team_memberships", { team_id: teamId, user_id: ashot });
  });
  return { db, teamId, jason, ashot };
}

describe("resolveAssigneeToUserId", () => {
  test("does not throw on a raw name; resolves Jason by exact name", async () => {
    const { db, teamId, jason } = makeTeam();
    expect(await resolveAssigneeToUserId({ db }, "Jason Benn", teamId as any)).toBe(jason);
  });

  test("resolves a partial first name via unique substring", async () => {
    const { db, teamId, jason } = makeTeam();
    expect(await resolveAssigneeToUserId({ db }, "jason", teamId as any)).toBe(jason);
  });

  test("resolves by email", async () => {
    const { db, teamId, jason } = makeTeam();
    expect(await resolveAssigneeToUserId({ db }, "jason@union.app", teamId as any)).toBe(jason);
  });

  test("still resolves github-handle members (Ashot)", async () => {
    const { db, teamId, ashot } = makeTeam();
    expect(await resolveAssigneeToUserId({ db }, "ashot", teamId as any)).toBe(ashot);
  });

  test("resolves a real user id directly", async () => {
    const { db, teamId, jason } = makeTeam();
    expect(await resolveAssigneeToUserId({ db }, jason, teamId as any)).toBe(jason);
  });

  test("returns null for an unknown name instead of throwing", async () => {
    const { db, teamId } = makeTeam();
    expect(await resolveAssigneeToUserId({ db }, "Nobody Here", teamId as any)).toBeNull();
  });

  test("returns null for an ambiguous substring (never guesses)", async () => {
    const { db } = makeFakeDb();
    let teamId = "", a = "", b = "";
    const seeded = makeFakeDb((insert) => {
      teamId = insert("teams", { name: "T" });
      a = insert("users", { name: "Jordan Lee", active_team_id: teamId });
      b = insert("users", { name: "Jordan Park", active_team_id: teamId });
      insert("team_memberships", { team_id: teamId, user_id: a });
      insert("team_memberships", { team_id: teamId, user_id: b });
    });
    expect(await resolveAssigneeToUserId({ db: seeded.db }, "Jordan", teamId as any)).toBeNull();
  });
});

describe("resolveAssigneeStr", () => {
  test("persists a real user id for a friendly name (Jason Benn)", async () => {
    const { db, jason } = makeTeam();
    expect(await resolveAssigneeStr({ db }, "Jason Benn", jason as any)).toBe(jason);
  });

  test("persists a real user id for a partial name (jason)", async () => {
    const { db, jason } = makeTeam();
    expect(await resolveAssigneeStr({ db }, "jason", jason as any)).toBe(jason);
  });

  test("resolves github-handle members to their id (ashot)", async () => {
    const { db, ashot } = makeTeam();
    expect(await resolveAssigneeStr({ db }, "ashot", ashot as any)).toBe(ashot);
  });

  test("'me' maps to the acting user id", async () => {
    const { db, jason } = makeTeam();
    expect(await resolveAssigneeStr({ db }, "me", jason as any)).toBe(jason);
  });

  test("keeps the raw string when nothing matches", async () => {
    const { db, jason } = makeTeam();
    expect(await resolveAssigneeStr({ db }, "Nobody Here", jason as any)).toBe("Nobody Here");
  });
});

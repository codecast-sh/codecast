import { describe, expect, test } from "bun:test";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { LEASE_MS, WAITER_STALE_MS, leaseCore } from "./repoLeases";

// The lease on a repository's before-merge deploys through the landing push:
// one holder at a time across machines, named to whoever waits, freed by
// release or by lapsing.

const ME = "users_me";
const YOU = "users_you";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function world() {
  const tables: Record<string, any[]> = {
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: YOU, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    repo_sources: [{ _id: "rs1", repository: "codecast-sh/codecast", team_id: TEAM }],
    repo_leases: [],
  };
  const ctx: any = { db: makeFakeDb(tables, { indexes: schemaIndexes(schema as any), strictPatch: true }) };
  const call = (user: string, op: "take" | "renew" | "release", token: string, at = NOW, holder?: string) =>
    leaseCore(ctx, user as any, { repository: "Codecast-sh/Codecast", op, token, team_id: TEAM, ...(holder ? { holder } : {}) }, at);
  return { tables, call };
}

describe("repo leases", () => {
  test("one holder at a time: a second taker is told who holds it and until when, and gets it once released", async () => {
    const w = world();
    expect(await w.call(ME, "take", "t1", NOW, "the merge of PR #7 on laptop")).toEqual({ held: true, expires_at: NOW + LEASE_MS });
    expect(w.tables.repo_leases[0]).toMatchObject({ workspace: `team:${TEAM}`, repository: "codecast-sh/codecast", holder: "the merge of PR #7 on laptop", holder_user_id: ME });
    expect(await w.call(YOU, "take", "t2", NOW + 1000, "cast ship checkout on host")).toEqual({ held: false, holder: "the merge of PR #7 on laptop", since: NOW, expires_at: NOW + LEASE_MS, position: 2 });
    // The holder taking again (a retry) keeps it.
    expect(await w.call(ME, "take", "t1", NOW + 2000)).toEqual({ held: true, expires_at: NOW + 2000 + LEASE_MS });
    // A release by anyone but the holder frees nothing.
    expect(await w.call(YOU, "release", "t2")).toEqual({ released: false });
    expect(await w.call(ME, "release", "t1")).toEqual({ released: true });
    expect(await w.call(YOU, "take", "t2", NOW + 3000, "cast ship checkout on host")).toEqual({ held: true, expires_at: NOW + 3000 + LEASE_MS });
  });

  test("takers get it in the order they asked, whoever asks first once it is free; a waiter that stops asking drops out", async () => {
    const w = world();
    const USER3 = "users_3";
    w.tables.team_memberships.push({ _id: "m3", user_id: USER3, team_id: TEAM, role: "member", joined_at: 1 }, { _id: "m4", user_id: "users_4", team_id: TEAM, role: "member", joined_at: 1 });
    expect(await w.call(ME, "take", "a", NOW, "merge A")).toMatchObject({ held: true });
    // Three wait, in this order, each told its place and who holds it.
    expect(await w.call(YOU, "take", "b", NOW + 1000, "merge B")).toMatchObject({ held: false, holder: "merge A", position: 2 });
    expect(await w.call(USER3, "take", "c", NOW + 2000, "merge C")).toMatchObject({ held: false, holder: "merge A", position: 3 });
    expect(await w.call("users_4", "take", "d", NOW + 3000, "merge D")).toMatchObject({ held: false, holder: "merge A", position: 4 });
    // Asking again keeps a waiter's place.
    expect(await w.call(YOU, "take", "b", NOW + 4000)).toMatchObject({ held: false, position: 2 });
    expect(await w.call(ME, "release", "a", NOW + 5000)).toEqual({ released: true });
    // Free, but D (last in line) polls first: it waits behind B, who is next.
    expect(await w.call("users_4", "take", "d", NOW + 6000)).toEqual({ held: false, holder: "merge B (next in line)", since: NOW + 1000, expires_at: NOW + 5000, position: 3 });
    expect(await w.call(USER3, "take", "c", NOW + 6500)).toMatchObject({ held: false, position: 2 });
    expect(await w.call(YOU, "take", "b", NOW + 7000, "merge B")).toEqual({ held: true, expires_at: NOW + 7000 + LEASE_MS });
    expect(w.tables.repo_leases[0]).toMatchObject({ token: "b", holder: "merge B", holder_user_id: YOU, acquired_at: NOW + 7000 });
    expect(w.tables.repo_leases[0].waiters.map((x: any) => x.token)).toEqual(["c", "d"]);
    // C dies (stops asking); D keeps asking. When B releases, C has dropped out and D is first.
    const later = NOW + 7000 + WAITER_STALE_MS;
    expect(await w.call("users_4", "take", "d", later - 1000)).toMatchObject({ held: false, holder: "merge B", position: 3 });
    expect(await w.call(YOU, "release", "b", later + 1000)).toEqual({ released: true });
    expect(await w.call("users_4", "take", "d", later + 2000, "merge D")).toEqual({ held: true, expires_at: later + 2000 + LEASE_MS });
    expect(w.tables.repo_leases).toHaveLength(1);
    expect(w.tables.repo_leases[0]).toMatchObject({ token: "d", holder: "merge D" });
    expect(w.tables.repo_leases[0].waiters).toBeUndefined();
    // C coming back joins the back of the line; a waiter that gives up (release) leaves it.
    expect(await w.call(USER3, "take", "c", later + 3000)).toMatchObject({ held: false, position: 2 });
    expect(await w.call(USER3, "release", "c", later + 4000)).toEqual({ released: false });
    expect(w.tables.repo_leases[0].waiters).toBeUndefined();
    // With no line, a release deletes the row.
    expect(await w.call("users_4", "release", "d", later + 5000)).toEqual({ released: true });
    expect(w.tables.repo_leases).toEqual([]);
  });

  test("a renewal keeps a live lease; a lapsed one goes to the next taker, and its old holder's renewal is refused", async () => {
    const w = world();
    await w.call(ME, "take", "t1", NOW, "merge A");
    expect(await w.call(ME, "renew", "t1", NOW + LEASE_MS - 1)).toEqual({ held: true, expires_at: NOW + 2 * LEASE_MS - 1 });
    const lapsed = NOW + 3 * LEASE_MS;
    expect(await w.call(YOU, "take", "t2", lapsed, "merge B")).toEqual({ held: true, expires_at: lapsed + LEASE_MS });
    expect(await w.call(ME, "renew", "t1", lapsed + 1)).toEqual({ held: false, holder: "merge B", since: lapsed, expires_at: lapsed + LEASE_MS });
    expect(w.tables.repo_leases).toHaveLength(1);
  });

  test("a renewal never takes a lease back: with no row, or another holder's, it is refused and leaves the table alone", async () => {
    const w = world();
    await w.call(ME, "take", "t1", NOW, "merge A on a laptop that sleeps");
    const lapsed = NOW + 3 * LEASE_MS;
    // While A sleeps, B takes the lapsed lease, merges and releases it.
    expect(await w.call(YOU, "take", "t2", lapsed, "merge B")).toEqual({ held: true, expires_at: lapsed + LEASE_MS });
    expect(await w.call(YOU, "release", "t2")).toEqual({ released: true });
    // A wakes: its renewal finds no row, and must not insert one.
    expect(await w.call(ME, "renew", "t1", lapsed + 5000)).toMatchObject({ held: false });
    expect(w.tables.repo_leases).toEqual([]);
    // A token that never held it renews nothing either, and only a take gets it.
    expect(await w.call(YOU, "renew", "never", lapsed + 6000)).toMatchObject({ held: false });
    expect(w.tables.repo_leases).toEqual([]);
    expect(await w.call(ME, "take", "t1", lapsed + 7000)).toEqual({ held: true, expires_at: lapsed + 7000 + LEASE_MS });
  });

  test("a station's lease is its run's workspace's, however many teams connected the repository", async () => {
    const OTHER = "teams_other" as any;
    const tables: Record<string, any[]> = {
      team_memberships: [
        { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
        { _id: "m2", user_id: ME, team_id: OTHER, role: "member", joined_at: 1 },
        { _id: "m3", user_id: YOU, team_id: TEAM, role: "member", joined_at: 1 },
      ],
      // Two of ME's teams connected the repository, so the repository alone names no team.
      repo_sources: [
        { _id: "rs1", repository: "codecast-sh/codecast", team_id: TEAM },
        { _id: "rs2", repository: "codecast-sh/codecast", team_id: OTHER },
      ],
      workflow_runs: [{ _id: "workflow_runs_1", workspace: `team:${OTHER}`, team_id: OTHER, user_id: ME }],
      repo_leases: [],
    };
    const ctx: any = { db: makeFakeDb(tables, { indexes: schemaIndexes(schema as any) }) };
    const call = (user: string, args: Record<string, unknown>) => leaseCore(ctx, user as any, { repository: "codecast-sh/codecast", op: "take", token: "t1", holder: "merge", ...args }, NOW);
    await expect(call(ME, {})).rejects.toThrow("More than one of your teams works on codecast-sh/codecast");
    expect(await call(ME, { run_id: "workflow_runs_1" })).toEqual({ held: true, expires_at: NOW + LEASE_MS });
    expect(tables.repo_leases[0]).toMatchObject({ workspace: `team:${OTHER}`, team_id: OTHER, repository: "codecast-sh/codecast" });
    // Someone outside the run's workspace cannot lease through it.
    await expect(call(YOU, { run_id: "workflow_runs_1", token: "t2" })).rejects.toThrow("No run workflow_runs_1 you can lease a repository for.");
  });

  test("one lease per repository: a personal run and a team's cast ship checkout exclude each other, and an outsider is refused", async () => {
    const STRANGER = "users_stranger";
    const tables: Record<string, any[]> = {
      team_memberships: [{ _id: "m1", user_id: YOU, team_id: TEAM, role: "member", joined_at: 1 }],
      repo_sources: [{ _id: "rs1", repository: "codecast-sh/codecast", team_id: TEAM }],
      // ME's run lives in ME's own workspace, which published the repository's deploy targets; YOU's checkout resolves
      // the repository's team.
      workflow_runs: [{ _id: "workflow_runs_mine", workspace: `user:${ME}`, user_id: ME }],
      deploy_targets: [{ _id: "dt1", workspace: `user:${ME}`, repository: "codecast-sh/codecast", name: "web" }],
      repo_leases: [],
    };
    const ctx: any = { db: makeFakeDb(tables, { indexes: schemaIndexes(schema as any) }) };
    const call = (user: string, op: "take" | "release", token: string, extra: Record<string, unknown> = {}, at = NOW) =>
      leaseCore(ctx, user as any, { repository: "codecast-sh/codecast", op, token, ...extra }, at);
    expect(await call(ME, "take", "run", { run_id: "workflow_runs_mine", holder: "the merge of PR #7" })).toEqual({ held: true, expires_at: NOW + LEASE_MS });
    expect(tables.repo_leases[0]).toMatchObject({ workspace: `user:${ME}`, repository: "codecast-sh/codecast", holder_user_id: ME });
    expect(await call(YOU, "take", "checkout", { holder: "cast ship checkout" }, NOW + 1000)).toEqual({ held: false, holder: "the merge of PR #7", since: NOW, expires_at: NOW + LEASE_MS, position: 2 });
    expect(await call(ME, "release", "run", { run_id: "workflow_runs_mine" })).toEqual({ released: true });
    expect(await call(YOU, "take", "checkout", { holder: "cast ship checkout" }, NOW + 2000)).toEqual({ held: true, expires_at: NOW + 2000 + LEASE_MS });
    expect(tables.repo_leases[0]).toMatchObject({ workspace: `team:${TEAM}`, team_id: TEAM });
    expect(await call(ME, "take", "run", { run_id: "workflow_runs_mine" }, NOW + 3000)).toEqual({ held: false, holder: "cast ship checkout", since: NOW + 2000, expires_at: NOW + 2000 + LEASE_MS, position: 2 });
    // Someone with neither the run's workspace nor a team on the repository takes nothing.
    await expect(call(STRANGER, "take", "x", { run_id: "workflow_runs_mine" })).rejects.toThrow("No run workflow_runs_mine you can lease a repository for.");
    await expect(call(STRANGER, "take", "x")).rejects.toThrow("None of your teams has codecast-sh/codecast connected");
    expect(tables.repo_leases).toHaveLength(1);
  });

  test("a run of one's own is no pass to another repository's lease, and the refusal names no holder", async () => {
    const OUTSIDER = "users_outsider";
    const tables: Record<string, any[]> = {
      team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
      repo_sources: [{ _id: "rs1", repository: "codecast-sh/codecast", team_id: TEAM }],
      // The outsider's run is theirs, in their own workspace, which works on nothing of codecast's.
      workflow_runs: [{ _id: "workflow_runs_theirs", workspace: `user:${OUTSIDER}`, user_id: OUTSIDER }],
      repo_leases: [],
    };
    const ctx: any = { db: makeFakeDb(tables, { indexes: schemaIndexes(schema as any) }) };
    const call = (user: string, op: "take" | "renew", token: string, extra: Record<string, unknown> = {}) =>
      leaseCore(ctx, user as any, { repository: "codecast-sh/codecast", op, token, ...extra }, NOW);
    expect(await call(ME, "take", "mine", { holder: "the merge of PR #7 on laptop" })).toMatchObject({ held: true });
    for (const op of ["take", "renew"] as const) {
      const refused = await call(OUTSIDER, op, "theirs", { run_id: "workflow_runs_theirs", holder: "outsider" }).then((a) => JSON.stringify(a), (e: Error) => e.message);
      expect(refused).toBe("Run workflow_runs_theirs cannot lease codecast-sh/codecast: neither its workspace nor any of your teams works on it.");
      expect(refused).not.toContain("PR #7");
    }
    expect(tables.repo_leases).toHaveLength(1);
    expect(tables.repo_leases[0]).toMatchObject({ token: "mine", holder_user_id: ME });
  });

  test("a named team must work on the repository: a team of one's own is no pass to another's lease, and the refusal names no holder", async () => {
    const MINE = "teams_mine" as any;
    const tables: Record<string, any[]> = {
      team_memberships: [
        { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
        { _id: "m2", user_id: YOU, team_id: MINE, role: "admin", joined_at: 1 },
      ],
      repo_sources: [{ _id: "rs1", repository: "codecast-sh/codecast", team_id: TEAM }],
      // MINE published deploy targets for its own repository only.
      deploy_targets: [{ _id: "dt1", workspace: `team:${MINE}`, repository: "you/yours", name: "web" }],
      repo_leases: [],
    };
    const ctx: any = { db: makeFakeDb(tables, { indexes: schemaIndexes(schema as any) }) };
    const call = (user: string, repository: string, op: "take" | "renew", token: string, team_id: any) =>
      leaseCore(ctx, user as any, { repository, op, token, team_id, holder: user }, NOW);
    expect(await call(ME, "codecast-sh/codecast", "take", "mine", TEAM)).toMatchObject({ held: true });
    for (const op of ["take", "renew"] as const) {
      const refused = await call(YOU, "codecast-sh/codecast", op, "theirs", MINE).then((a) => JSON.stringify(a), (e: Error) => e.message);
      expect(refused).toBe(`Team ${MINE} cannot lease codecast-sh/codecast: it does not work on it.`);
    }
    // A team that is not one's own is refused as before.
    await expect(call(YOU, "codecast-sh/codecast", "take", "theirs", TEAM)).rejects.toThrow();
    expect(tables.repo_leases).toHaveLength(1);
    expect(tables.repo_leases[0]).toMatchObject({ token: "mine", holder_user_id: ME });
    // The team's own repository (its deploy targets) it leases.
    expect(await call(YOU, "you/yours", "take", "theirs", MINE)).toMatchObject({ held: true });
  });

  test("a run's team_id (routing) grants nothing: only its workspace's team counts", async () => {
    const tables: Record<string, any[]> = {
      team_memberships: [{ _id: "m1", user_id: YOU, team_id: TEAM, role: "member", joined_at: 1 }],
      repo_sources: [{ _id: "rs1", repository: "codecast-sh/codecast", team_id: TEAM }],
      // Routed to TEAM's inbox, but private to ME: its workspace is ME's own, which works on nothing of TEAM's.
      workflow_runs: [{ _id: "workflow_runs_routed", workspace: `user:${ME}`, team_id: TEAM, user_id: ME }],
      repo_leases: [],
    };
    const ctx: any = { db: makeFakeDb(tables, { indexes: schemaIndexes(schema as any) }) };
    await expect(leaseCore(ctx, ME as any, { repository: "codecast-sh/codecast", op: "take", token: "t", holder: "merge", run_id: "workflow_runs_routed" }, NOW)).rejects.toThrow("cannot lease codecast-sh/codecast");
    expect(tables.repo_leases).toEqual([]);
  });
});

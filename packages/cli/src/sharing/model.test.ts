import { describe, expect, test } from "bun:test";
import { buildFolderRows, isLive, isSyncing, parseSince, planSyncChange, prettyPath, resolveFolder, resolveTeam, sharingOf, type FolderRule, type Overview } from "./model.js";

const HOME = "/Users/ada";
const rule = (r: Partial<FolderRule> & { path_prefix: string }): FolderRule => ({ team_id: null, team_name: null, ...r });

const overview = (over: Partial<Overview> = {}): Overview => ({
  settings: { sync_mode: "all", sync_projects: [] },
  teams: [{ _id: "t1", name: "Acme", member_count: 4, visibility: "summary" }, { _id: "t2", name: "Acme Labs", member_count: 1 }],
  folders: [
    { path: `${HOME}/src/app`, repository: "acme/app", session_count: 30, first_active: 1_000, last_active: 5_000 },
    { path: `${HOME}/src/notes`, session_count: 3, first_active: 2_000, last_active: 3_000 },
  ],
  rules: [],
  ...over,
});

describe("sharingOf", () => {
  test("a folder with no rule is private", () => {
    expect(sharingOf([], `${HOME}/src/app`, undefined)).toEqual({ kind: "private" });
  });

  test("a parent folder's rule covers a child, marked inherited", () => {
    const s = sharingOf([rule({ path_prefix: `${HOME}/src`, team_id: "t1", team_name: "Acme", share_since: 42 })], `${HOME}/src/app`, undefined);
    expect(s).toEqual({ kind: "team", teamId: "t1", teamName: "Acme", since: 42, rulePath: `${HOME}/src`, inherited: true });
  });

  test("another checkout's rule reaches a clone through the repository, and a lock beats a share", () => {
    const rules = [
      rule({ path_prefix: "/tmp/other-clone", team_id: "t1", team_name: "Acme", repository: "acme/app" }),
      rule({ path_prefix: "/tmp/locked-clone", private: true, repository: "acme/app" }),
    ];
    expect(sharingOf(rules, `${HOME}/src/app`, "acme/app")).toEqual({ kind: "lock", rulePath: "/tmp/locked-clone", inherited: true });
  });
});

describe("buildFolderRows", () => {
  test("merges synced folders, this machine's folders and rule paths, newest first", () => {
    const rows = buildFolderRows(
      overview({ rules: [rule({ path_prefix: `${HOME}/src/secret`, private: true })] }),
      [{ path: `${HOME}/src/app`, repository: "acme/app", sessions: 40, first: 900, last: 6_000, exists: true }, { path: `${HOME}/scratch`, sessions: 2, first: 10, last: 20, exists: false }],
    );
    expect(rows.map((r) => r.path)).toEqual([`${HOME}/src/app`, `${HOME}/src/notes`, `${HOME}/scratch`, `${HOME}/src/secret`]);
    const app = rows[0];
    expect(app).toMatchObject({ onMachine: 40, synced: 30, syncing: true, first: 1_000, last: 5_000, sharing: { kind: "private" } });
    expect(rows[2]).toMatchObject({ onMachine: 2, synced: 0, exists: false, first: 10, last: 20 });
    expect(rows[3].sharing).toEqual({ kind: "lock", rulePath: `${HOME}/src/secret`, inherited: false });
    expect(rows.filter(isLive).map((r) => r.path)).not.toContain(`${HOME}/scratch`);
  });

  test("exact server counts replace the recent window's count", () => {
    const rows = buildFolderRows(overview(), null, { [`${HOME}/src/app`]: { count: 1200, first_started_at: 100, last_started_at: 5_000, truncated: true, manually_shared: 3, hidden: 2 } });
    expect(rows[0]).toMatchObject({ synced: 1200, truncated: true, first: 100, onMachine: null, counted: true, sharedByHand: 3, keptPrivate: 2 });
    expect(rows[1]).toMatchObject({ synced: 3, counted: false, sharedByHand: 0 });
  });

  test("with chosen folders, only those and their subfolders sync", () => {
    const rows = buildFolderRows(overview({ settings: { sync_mode: "selected", sync_projects: [`${HOME}/src`] } }), [{ path: `${HOME}/scratch`, sessions: 1, first: 1, last: 1, exists: true }]);
    expect(Object.fromEntries(rows.map((r) => [r.path, r.syncing]))).toEqual({ [`${HOME}/src/app`]: true, [`${HOME}/src/notes`]: true, [`${HOME}/scratch`]: false, [`${HOME}/src`]: true });
  });
});

describe("planSyncChange", () => {
  const all = { sync_mode: "all" as const, sync_projects: [] as string[] };

  test("with everything syncing, stopping a folder excludes it and nothing else changes", () => {
    const plan = planSyncChange(all, { unsync: [`${HOME}/scratch`] });
    expect(plan).toEqual({ next: { sync_excluded: [`${HOME}/scratch`] }, stillCovered: [] });
  });

  test("stopping a folder that holds the home folder's work leaves home and its other folders syncing", () => {
    const after = { ...all, sync_excluded: [`${HOME}/src/app`] };
    expect(planSyncChange(all, { unsync: [`${HOME}/src/app`] }).next).toEqual({ sync_excluded: [`${HOME}/src/app`] });
    expect(isSyncing(after, HOME)).toBe(true);
    expect(isSyncing(after, `${HOME}/src/notes`)).toBe(true);
    expect(isSyncing(after, `${HOME}/src/app/sub`)).toBe(false);
  });

  test("excluding a parent absorbs the exclusions inside it; an excluded folder is not excluded twice", () => {
    const settings = { ...all, sync_excluded: ["/private/tmp/a"] };
    expect(planSyncChange(settings, { unsync: ["/private/tmp"] }).next).toEqual({ sync_excluded: ["/private/tmp"] });
    expect(planSyncChange(settings, { unsync: ["/private/tmp/a/b"] }).next).toBeNull();
  });

  test("syncing an excluded folder lifts it, with the exclusions inside it; one inside an excluded parent is reported", () => {
    const settings = { ...all, sync_excluded: [`${HOME}/src`, `${HOME}/scratch`, `${HOME}/scratch/deep`] };
    expect(planSyncChange(settings, { sync: [`${HOME}/scratch`] })).toEqual({ next: { sync_excluded: [`${HOME}/src`] }, stillCovered: [] });
    expect(planSyncChange(settings, { sync: [`${HOME}/src/app`] })).toEqual({ next: null, stillCovered: [{ folder: `${HOME}/src/app`, by: `${HOME}/src` }] });
  });

  test("--all turns on everything and clears exclusions; a no-op when already so", () => {
    expect(planSyncChange(all, { all: true }).next).toBeNull();
    expect(planSyncChange({ ...all, sync_excluded: ["/x"] }, { all: true }).next).toEqual({ sync_mode: "all", sync_excluded: [] });
    expect(planSyncChange({ sync_mode: "selected", sync_projects: ["/x"] }, { all: true }).next).toEqual({ sync_mode: "all", sync_excluded: [] });
  });

  test("with chosen folders, unsync edits the list and takes the folders inside along", () => {
    const settings = { sync_mode: "selected" as const, sync_projects: ["/private/tmp", "/private/tmp/a", `${HOME}/src/app`] };
    expect(planSyncChange(settings, { unsync: ["/private/tmp"] }).next).toEqual({ sync_mode: "selected", sync_projects: [`${HOME}/src/app`] });
  });

  test("with chosen folders, a chosen parent still covers a folder taken off the list", () => {
    const plan = planSyncChange({ sync_mode: "selected", sync_projects: [`${HOME}/src`] }, { unsync: [`${HOME}/src/app`] });
    expect(plan.next).toBeNull();
    expect(plan.stillCovered).toEqual([{ folder: `${HOME}/src/app`, by: `${HOME}/src` }]);
  });

  test("with chosen folders, syncing adds only folders not already covered", () => {
    const settings = { sync_mode: "selected" as const, sync_projects: [`${HOME}/src`] };
    expect(planSyncChange(settings, { sync: [`${HOME}/src/app`] }).next).toBeNull();
    expect(planSyncChange(settings, { sync: [`${HOME}/scratch`] }).next).toEqual({ sync_mode: "selected", sync_projects: [`${HOME}/src`, `${HOME}/scratch`] });
  });
});

describe("resolveFolder", () => {
  const rows = buildFolderRows(overview(), [{ path: "/work/app", sessions: 1, first: 1, last: 1, exists: true }]);

  test("paths expand ~ and relative forms and are taken as given", () => {
    expect(resolveFolder("~/src/new", rows, HOME, "/x")).toEqual({ ok: true, value: `${HOME}/src/new` });
    expect(resolveFolder("./sub/", rows, HOME, "/x")).toEqual({ ok: true, value: "/x/sub" });
  });

  test("a repository or a unique folder name picks the known folder", () => {
    expect(resolveFolder("acme/app", rows, HOME, "/x")).toEqual({ ok: true, value: `${HOME}/src/app` });
    expect(resolveFolder("Notes", rows, HOME, "/x")).toEqual({ ok: true, value: `${HOME}/src/notes` });
  });

  test("an ambiguous or unknown name lists what to pass instead", () => {
    const amb = resolveFolder("app", rows, HOME, "/x");
    expect(amb.ok).toBe(false);
    expect(!amb.ok && amb.error).toContain("~/src/app");
    expect(resolveFolder("nope", rows, HOME, "/x").ok).toBe(false);
  });
});

describe("resolveTeam", () => {
  const teams = overview().teams;
  test("exact name wins over a prefix it shares", () => {
    expect(resolveTeam("acme", teams)).toMatchObject({ ok: true, value: { _id: "t1" } });
    expect(resolveTeam("acme l", teams)).toMatchObject({ ok: true, value: { _id: "t2" } });
    expect(resolveTeam("t2", teams)).toMatchObject({ ok: true, value: { _id: "t2" } });
    expect(resolveTeam("zeta", teams).ok).toBe(false);
  });
});

test("parseSince reads days and dates as local midnight", () => {
  const now = new Date(2026, 8, 24, 15, 30).getTime();
  expect(parseSince("today", now)).toBe(new Date(2026, 8, 24).getTime());
  expect(parseSince("7d", now)).toBe(new Date(2026, 8, 17).getTime());
  expect(parseSince("2026-03-01", now)).toBe(new Date(2026, 2, 1).getTime());
  expect(parseSince("soon", now)).toBeNull();
});

test("prettyPath shortens the home directory", () => {
  expect(prettyPath(`${HOME}/src/app`, HOME)).toBe("~/src/app");
  expect(prettyPath("/tmp/x", HOME)).toBe("/tmp/x");
});

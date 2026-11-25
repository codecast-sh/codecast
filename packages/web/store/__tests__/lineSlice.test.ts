import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { LINE_PROFILE_DEFAULTS, lineProfileNotes, type PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { lineEditRows, lineEditStates, liveLineProfile } from "../../lib/lineSettings";
import { DISPATCH_REFUSED, settleSessionCommand } from "../../lib/sessionCommands";
import { sendLift, sendPause, sendRollback } from "../../lib/deploys/press";

const s = () => useInboxStore.getState() as any;
const PID = "p".repeat(32);

const profile = (over: Partial<PublishedLineProfile> = {}): PublishedLineProfile => ({
  ...structuredClone(LINE_PROFILE_DEFAULTS),
  finders: [],
  root: "/repo",
  device_id: "dev-1",
  publisher_user_id: "u",
  sources: { size_budget: "default" },
  notes: lineProfileNotes(LINE_PROFILE_DEFAULTS),
  warnings: [],
  changed_at: 1,
  published_at: 1,
  ...over,
} as PublishedLineProfile);

let calls: Array<[string, unknown[]]> = [];
let reply: (action: string, args: unknown[]) => unknown = () => ({ command_id: "c1" });
const owner = {};
beforeAll(() => s()._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return reply(action, args); }, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  calls = [];
  reply = () => ({ command_id: "c1" });
  useInboxStore.setState({ projects: { [PID]: { _id: PID, title: "P", line_profile: profile() } }, sessionCommands: {}, pending: {} } as any);
});

const rows = () => lineEditRows(s().sessionCommands, PID);
const echo = (requestId: string, over: Record<string, unknown>) =>
  s().syncTable("sessionCommands", [{ _id: requestId, command_id: "c1", command: "line_profile_edit", device_id: "dev-1", requested_at: 0, executed_at: null, result: null, error: null, ...over }], { isDelta: true });

describe("editLineProfile", () => {
  it("paints an edit row and never touches the project row", () => {
    s().editLineProfile("r1", PID, [{ op: "set", key: "size_budget", value: 250 }]);
    expect(s().projects[PID].line_profile.size_budget).toBe(400);
    expect(s().pending[`projects:${PID}:line_profile`]).toBeUndefined();
    expect(rows().map((r) => r.keys)).toEqual([["size_budget"]]);
    expect(calls[0]?.[0]).toBe("editLineProfile");
    expect(calls[0]?.[1]).toEqual(["r1", PID, [{ op: "set", key: "size_budget", value: 250 }]]);
  });

  it("shows the edit over the published copy until the republished copy arrives, through every push of the row", () => {
    s().editLineProfile("r1", PID, [{ op: "set", key: "size_budget", value: 250 }]);
    const t = Date.now();
    expect(liveLineProfile(s().projects[PID].line_profile, rows(), t).size_budget).toBe(250);
    // The daemon wrote the file and is republishing; the server echo keeps the local intent.
    echo("r1", { executed_at: t, result: JSON.stringify({ changed: true, published: { ok: "pending" } }) });
    expect(rows()[0].edits).toEqual([{ op: "set", key: "size_budget", value: 250 }]);
    expect(lineEditStates(rows(), s().projects[PID].line_profile, t).size_budget.state).toBe("publishing");
    expect(liveLineProfile(s().projects[PID].line_profile, rows(), t).size_budget).toBe(250);
    // The republished copy, stamped after the write, is the truth from here on.
    s().syncTable("projects", [{ _id: PID, title: "P", line_profile: profile({ size_budget: 250, sources: { size_budget: "file" }, published_at: t + 5 }) }], { isDelta: true });
    const lp = s().projects[PID].line_profile;
    expect(liveLineProfile(lp, rows(), t + 10)).toBe(lp);
    expect(lineEditStates(rows(), lp, t + 10).size_budget.state).toBe("saved");
  });

  it("a refused edit stops showing, and says why", () => {
    s().editLineProfile("r1", PID, [{ op: "set", key: "size_budget", value: 250 }]);
    echo("r1", { executed_at: Date.now(), error: "/repo/.codecast/line.toml: [line] size_budget must be a positive integer" });
    const lp = s().projects[PID].line_profile;
    expect(liveLineProfile(lp, rows(), Date.now())).toBe(lp);
    expect(lineEditStates(rows(), lp, Date.now()).size_budget).toMatchObject({ state: "refused", message: "size_budget must be a positive integer" });
  });

  it("a refusal from the server reads as its own message, not the client's error text", () => {
    s().editLineProfile("r1", PID, [{ op: "set", key: "size_budget", value: 250 }]);
    settleSessionCommand("r1", { result: DISPATCH_REFUSED, error: String(new Error("[CONVEX M(dispatch:dispatch)] [Request ID: x] Server Error\nUncaught ConvexError: The checkout is on a teammate's machine: its owner can edit this file")) });
    expect(lineEditStates(rows(), s().projects[PID].line_profile, Date.now()).size_budget).toMatchObject({ state: "refused", message: "The checkout is on a teammate's machine: its owner can edit this file" });
  });

  it("edits in flight on one project all stand, in the order they were made", () => {
    s().editLineProfile("r1", PID, [{ op: "set", key: "size_budget", value: 250 }]);
    s().editLineProfile("r2", PID, [{ op: "set", key: "watch_days", value: 3 }]);
    s().editLineProfile("r3", PID, [{ op: "set", key: "size_budget", value: 300 }]);
    const live = liveLineProfile(s().projects[PID].line_profile, rows(), Date.now());
    expect([live.size_budget, live.watch_days]).toEqual([300, 3]);
  });

  it("an edit nobody answers can be put back", () => {
    s().editLineProfile("r1", PID, [{ op: "set", key: "size_budget", value: 250 }]);
    const late = Date.now() + 60_000;
    const st = lineEditStates(rows(), s().projects[PID].line_profile, late).size_budget;
    expect(st).toMatchObject({ slow: true });
    s().dismissSessionCommand(st.requestId);
    expect(liveLineProfile(s().projects[PID].line_profile, rows(), late).size_budget).toBe(400);
  });
});

describe("production pause on the Deploys page (deploys.md DP17, DP19)", () => {
  const TEAM = "t".repeat(32);
  const WS = `team:${TEAM}`;
  const target = (name: string, repository: string, over: Record<string, unknown> = {}) => ({
    _id: `${repository}#${name}`, workspace: WS, team_id: TEAM, name, repository, runs: "here", policy: "press", command: "x", rollback: null, paths: [],
    can_deploy: true, can_redeploy_sha: true, can_rollback: false, device_id: "d", publisher_user_id: "u",
    queue: { known: true, truncated: false, commits: 0, untouched: 0, head_sha: "h", head_ci: "passed", head_ci_url: null, shown: 0, groups: [] }, ...over,
  });
  const production = (repository: string, over: Record<string, unknown> = {}) => ({ _id: repository, workspace: WS, team_id: TEAM, repository, pause: null, can_pause: true, can_lift: false, ...over });
  const live = { _id: "dp_live", workspace: WS, target: "production", repository: "acme/app", short_id: "dp-9", status: "live", action: "deploy", rollback_of: null, sha: "2".repeat(40), previous_sha: null, version: null, url: null, started_by: null, note: null, commits: 0, sessions: [], created_at: 2, live_at: 2, finished_at: null };
  const before = { ...live, _id: "dp_before", short_id: "dp-8", sha: "1".repeat(40), created_at: 1, live_at: 1 };
  const refused = (msg: string) => () => { throw new Error(`[CONVEX M(dispatch:dispatch)] Server Error\nUncaught Error: ${msg}`); };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const targets = () => s().deployTargets as Record<string, any>;
  const prod = (repository: string) => s().deployProductions[repository];
  const locks = () => Object.keys(s().pending).filter((k) => k.startsWith("deployProductions:"));
  /** What the feed says next: the server's rows for the productions it names. */
  const echo = (...rows: Array<Record<string, unknown>>) => s().syncTable("deployProductions", rows, { isDelta: true });
  const standing = { repository: "acme/app", by: "Bo", reason: "deploy broke", at: 1, lifts: "Bo or the Release Captain lifts it.", rollback: null, until: null };
  beforeEach(() => {
    useInboxStore.setState({
      deployTargets: { "acme/app#production": target("production", "acme/app", { workflow: "deploy.yml", rollback_inputs: { components: "backend-web" } }), "acme/app#web": target("web", "acme/app"), "acme/site#site": target("site", "acme/site") },
      deployProductions: { "acme/app": production("acme/app"), "acme/site": production("acme/site") },
      teamDeploys: { dp_live: live, dp_before: before },
    } as any);
  });

  it("Pause paints the repository's one production row, and rides the pause write", () => {
    sendPause(targets()["acme/app#web"], "  errors spiking ", "Ana");
    expect(prod("acme/app").pause).toMatchObject({ by: "Ana", reason: "errors spiking", until: null });
    expect(prod("acme/app").can_lift).toBe(true);
    expect(prod("acme/site").pause).toBeNull();
    // The targets hold no copy of it.
    for (const t of Object.values(targets())) expect("pause" in t || "can_lift" in t).toBe(false);
    expect(calls.at(-1)).toEqual(["pauseProduction", [TEAM, "acme/app", "errors spiking", "Ana"]]);
  });

  it("the server's pause replaces the painted one, and its can_lift retires the lock", async () => {
    sendPause(targets()["acme/app#web"], "errors spiking", "Ana");
    await settle();
    expect(locks()).toEqual(["deployProductions:acme/app:can_lift"]);
    const server = { repository: "acme/app", by: "Ana Lee", reason: "errors spiking", at: 42, lifts: "Ana Lee or the Release Captain lifts it.", rollback: null, until: null };
    echo(production("acme/app", { pause: server, can_lift: true }));
    expect(prod("acme/app").pause).toEqual(server);
    expect(locks()).toEqual([]);
  });

  it("a refused pause or lift puts can_lift back, and the feed's next word is the pause", async () => {
    reply = refused("Production is already paused by Bo: deploy broke");
    sendPause(targets()["acme/app#web"], "errors spiking", "Ana");
    await settle();
    expect(prod("acme/app").can_lift).toBe(false);
    expect(locks()).toEqual([]);
    // `pause` is unprotected: the refused paint stands until the feed next speaks, which replaces it.
    expect(prod("acme/app").pause).toMatchObject({ by: "Ana" });
    echo(production("acme/app", { pause: standing, can_lift: true }));
    expect(prod("acme/app").pause).toEqual(standing);

    reply = refused("Bo paused production; they or the Release Captain lift it");
    sendLift(targets()["acme/app#web"]);
    expect(prod("acme/app").pause).toBeNull();
    await settle();
    expect(prod("acme/app").can_lift).toBe(true);
    expect(locks()).toEqual([]);
    expect(calls.at(-1)?.[0]).toBe("liftProductionPause");
  });

  it("Lift holds through a stale push until the server says lifted", async () => {
    useInboxStore.setState({ deployProductions: { ...s().deployProductions, "acme/app": production("acme/app", { pause: standing, can_lift: true }) } } as any);
    sendLift(targets()["acme/app#web"]);
    await settle();
    echo(production("acme/app", { pause: standing, can_lift: true }));
    expect(prod("acme/app").can_lift).toBe(false);
    echo(production("acme/app"));
    expect(prod("acme/app")).toMatchObject({ pause: null, can_lift: false });
    expect(locks()).toEqual([]);
  });

  it("Roll back paints the rollback requested and production paused; what ends it arrives with the echo", async () => {
    reply = () => ({ deploy: "dp-10", target: "production", sha: "1".repeat(40), task: "ct-5", ending: "fix_forward", commits: 2, migrations: ["drizzle/0007_x.sql"], cancelled: [] });
    const t = targets()["acme/app#production"];
    sendRollback({ target: t, of: before as any }, "checkout broken", Object.values(s().teamDeploys) as any, "Ana");
    const stub = Object.values(s().teamDeploys).find((d: any) => d.client_key) as any;
    expect(stub).toMatchObject({ action: "rollback", status: "requested", rollback_of: "dp-8", sha: "1".repeat(40), previous_sha: "2".repeat(40) });
    expect(prod("acme/app").pause).toMatchObject({ by: "Ana", reason: "Rollback dp-8: checkout broken", rollback: null, until: { task: null } });
    expect(calls.at(-1)).toEqual(["rollbackProduction", [stub.client_key, TEAM, "acme/app", "production", "dp-8", "checkout broken", expect.anything()]]);
    await settle();
    // Nothing lays the answer on by hand: the feed carries it.
    expect(prod("acme/app").pause.until.task).toBeNull();
    const server = { repository: "acme/app", by: "Ana", reason: "Rollback dp-8: checkout broken", at: 42, lifts: "It lifts itself once ct-5's fix forward is green on main; Ana or the Release Captain can lift it sooner.", rollback: "dp-10", until: { task: "ct-5", kind: "fix_forward", migrations: ["drizzle/0007_x.sql"], commits: 2 } };
    echo(production("acme/app", { pause: server, can_lift: true }));
    expect(prod("acme/app").pause).toEqual(server);
    expect(locks()).toEqual([]);
  });

  it("a refused rollback takes back its requested deploy and can_lift", async () => {
    reply = refused("No target of acme/app names the workflow its deploys run as");
    sendRollback({ target: targets()["acme/app#production"], of: before as any }, "checkout broken", Object.values(s().teamDeploys) as any, "Ana");
    await settle();
    expect(Object.values(s().teamDeploys).some((d: any) => d.client_key)).toBe(false);
    expect(prod("acme/app").can_lift).toBe(false);
    expect(locks()).toEqual([]);
  });
});

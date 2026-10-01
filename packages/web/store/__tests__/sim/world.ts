// The sim world: who exists, what they own, and the server and network they
// share (docs/architecture/multiplayer-sim-harness.md, section 3.6).
//
// A scenario declares the world first (teams, users, named sessions, work
// items, triggers, roles), then `start()` runs genesis once. Genesis writes
// nothing by hand that production writes through a handler:
//
//   1. users, teams and every generated or named conversation are seed rows;
//      memberships are inserted through the change-tracked db, so the sync
//      log holds their scope_added actions;
//   2. each conversation is stamped through the real patchConversationVisibility;
//   3. tasks, docs, plans and triggers come from the CLI's create mutations,
//      under the owner's api token; chat channels and roles from the web's;
//   4. the gate: teamScopeSweep reports no stale or missing workspace key, and
//      the sweep itself writes nothing.
//
// Steps 1 and 2 run as internal mutations of a fixture module (`simGenesis`)
// through the backend router, so they get the same ctx (change log, sync log,
// principal views) a deployed mutation gets.

import { v } from "convex/values";
import { inboxEpoch, type AgentStatus, type TeamFeatures } from "@codecast/shared/contracts";
import { GEN_MIN, convexIdFor } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { genTeamWorld, teamIdFor, userIdFor, type WorldRow } from "@codecast/shared/contracts/__fixtures__/teamWorldGen";
import { hashToken } from "@codecast/convex/convex/apiTokens";
import { internalMutation } from "@codecast/convex/convex/functions";
import { patchConversationVisibility } from "@codecast/convex/convex/lib/access";
import { _resetChildAuqProbeCacheForTests } from "@codecast/convex/convex/conversations";
import { makeSimBackend, type Principal, type SimBackend, type SimClient } from "@codecast/convex/convex/simBackend.testing";
import { SimLabels } from "./labels";
import { Net, type Delivery } from "./net";
import * as realm from "./realm";
import { makeActors, type Actors } from "./actors";
import { SimDevice } from "./device";
import { windowOnline, type BootScope, type SimWindow, type SimWindowWorld } from "./window";
import { scopeSweep } from "./invariants";

export interface WorldOptions {
  seed: number;
  /** Generated sessions per user (teamWorldGen). Named sessions come on top. */
  rowsPerUser?: number;
  maxDeliveries?: number;
  maxWrites?: number;
  /** Each delivery just before it runs (events.jsonl, SIM_TRACE). */
  onDeliver?: (d: Delivery) => void;
  /** Each delivery after it ran (the DSL's always-mode checks). */
  afterDeliver?: (d: Delivery) => Promise<void> | void;
  /** Overlapping top-level server calls throw instead of queueing. */
  debug?: boolean;
}

export interface TeamOptions {
  features?: TeamFeatures;
}

export interface DeviceOptions {
  /** Follower windows beside the host. Default 0. */
  followers?: number;
  /** "mine", or a team name for the team inbox scope. */
  scope?: "mine" | { team: string };
  /** Device name (window names derive from it). Default: the user's name, then `<user>2`, ... */
  name?: string;
}

export interface SessionOptions {
  /** Default: the generated rows' seeded draw; named sessions default to shared. */
  private?: boolean;
  /** Gives the session a managed_sessions row with this status (a live agent). */
  agentStatus?: AgentStatus;
  /** Any other conversation fields (message_count: 0, inbox_pinned_at, ...). */
  row?: Record<string, unknown>;
}

export interface WorkItemOptions {
  owner: string;
  /** A session label ("ada/s"): the item is created from it, so it inherits its visibility. */
  session?: string;
}

export interface TriggerOptions {
  owner: string;
  session: string;
  /** Due time relative to the world clock at genesis (ms). Default: already due. */
  runInMs?: number;
}

type WorkKind = "task" | "doc" | "plan";

const DEFAULT_ROWS_PER_USER = 6;
const GENESIS_MODULE = "simGenesis";

/** The api token a user's daemon and agents present. */
export const tokenFor = (user: string): string => `sim-token-${user}`;
/** The device id the user's daemon reports. */
export const daemonDeviceFor = (user: string): string => `sim-daemon-${user}`;
/** A session's Claude session id, which managed_sessions and heartbeats key on. */
export const sessionIdFor = (conversationId: string): string => `sim-session-${conversationId}`;

// The fixture module genesis runs through the router. Internal, so no client
// can reach it.
const GENESIS = {
  addMembers: internalMutation({
    args: { rows: v.array(v.any()) },
    handler: async (ctx, { rows }) => {
      for (const row of rows) await ctx.db.insert("team_memberships", row);
    },
  }),
  stampConversations: internalMutation({
    args: { stamps: v.array(v.object({ id: v.id("conversations"), team_id: v.optional(v.id("teams")), is_private: v.boolean() })) },
    handler: async (ctx, { stamps }) => {
      for (const { id, ...updates } of stamps) {
        const conversation = await ctx.db.get(id);
        if (!conversation) throw new Error(`sim genesis: no conversation ${id}`);
        await patchConversationVisibility(ctx, conversation as any, updates);
      }
    },
  }),
};

export class SimWorld implements SimWindowWorld {
  readonly labels = new SimLabels();
  /** Every window by name; the net's online() reaches a window through it. */
  readonly windows = new Map<string, SimWindow>();
  readonly devices: SimDevice[] = [];
  readonly net: Net;
  readonly realm = realm;
  readonly actors: Actors;
  readonly seed: number;
  /** Epoch minute the generated sessions are dated against. */
  readonly epoch: number;

  private readonly opts: WorldOptions;
  private readonly teams = new Map<string, TeamOptions & { members: string[] }>();
  private readonly users: string[] = [];
  private readonly sessions: { user: string; name: string; opts: SessionOptions }[] = [];
  private readonly workItems: { kind: WorkKind; name: string; opts: WorkItemOptions }[] = [];
  private readonly triggers: { name: string; opts: TriggerOptions }[] = [];
  private readonly roles: { team: string; handle: string }[] = [];
  private _backend: SimBackend | null = null;
  private started: Promise<void> | null = null;
  // Labels the next insert into a table takes (see onInsert).
  private readonly nextLabel = new Map<string, string>();

  constructor(opts: WorldOptions) {
    this.opts = opts;
    this.seed = opts.seed;
    this.epoch = inboxEpoch(realm.now());
    // Module caches in convex code would otherwise leak between seeds of one process.
    _resetChildAuqProbeCacheForTests();
    this.net = new Net({
      rng: realm.stream("net"),
      maxDeliveries: opts.maxDeliveries,
      maxWrites: opts.maxWrites,
      writes: () => this._backend?.writes() ?? 0,
      now: realm.now,
      advance: realm.advance,
      onOnline: (win) => windowOnline(this, win),
      onDeliver: opts.onDeliver,
      afterDeliver: opts.afterDeliver,
    });
    realm.attachRealm({ timers: this.net, serverCall: () => this._backend?.activeCall() ?? null });
    this.actors = makeActors(this);
  }

  // -- Declarations (before start) --

  team(name: string, opts: TeamOptions = {}): this {
    this.declaring(`team("${name}")`);
    if (this.teams.has(name)) throw new Error(`sim world: team "${name}" declared twice`);
    this.teams.set(name, { ...opts, members: [] });
    return this;
  }

  /** A user and the teams they belong to; the first user listed in a team is its admin. */
  user(name: string, teams: string[] = []): this {
    this.declaring(`user("${name}")`);
    if (this.users.includes(name)) throw new Error(`sim world: user "${name}" declared twice`);
    for (const t of teams) {
      const team = this.teams.get(t);
      if (!team) throw new Error(`sim world: user "${name}" joins team "${t}", which is not declared; call team("${t}") first`);
      team.members.push(name);
    }
    this.users.push(name);
    return this;
  }

  /** A named session of `user`, labelled `<user>/<name>`. Returns the label. */
  session(user: string, name: string, opts: SessionOptions = {}): string {
    this.declaring(`session("${user}", "${name}")`);
    this.requireUser(user);
    this.sessions.push({ user, name, opts });
    return `${user}/${name}`;
  }

  task(name: string, opts: WorkItemOptions): string {
    return this.workItem("task", name, opts);
  }

  doc(name: string, opts: WorkItemOptions): string {
    return this.workItem("doc", name, opts);
  }

  plan(name: string, opts: WorkItemOptions): string {
    return this.workItem("plan", name, opts);
  }

  /** A once trigger armed on a session, labelled `trigger:<name>`. */
  trigger(name: string, opts: TriggerOptions): string {
    this.declaring(`trigger("${name}")`);
    this.requireUser(opts.owner);
    this.triggers.push({ name, opts });
    return `trigger:${name}`;
  }

  /** An org role in a team, hired with its standing session by the team's admin. Labelled `role:<team>/<handle>`. */
  role(team: string, handle: string): string {
    this.declaring(`role("${team}", "${handle}")`);
    const t = this.teams.get(team);
    if (!t) throw new Error(`sim world: role "${handle}" in undeclared team "${team}"`);
    if (!t.features?.org) throw new Error(`sim world: role "${handle}" needs team("${team}", { features: { org: true } })`);
    this.roles.push({ team, handle });
    return `role:${team}/${handle}`;
  }

  // -- Running --

  get backend(): SimBackend {
    if (!this._backend) throw new Error("sim world: the backend exists after `await world.start()`");
    return this._backend;
  }

  /** Genesis, once. Every async verb of the world calls it first. */
  start(): Promise<void> {
    return (this.started ??= this.genesis());
  }

  /** A client acting as this user (the web session). */
  clientAs(user: string): SimClient {
    return this.backend.clientFor(this.userPrincipal(user));
  }

  /** A client acting as this user's daemon or agents (the CLI, with its api token). */
  daemonClientAs(user: string): SimClient {
    return this.backend.clientFor(this.tokenPrincipal(user));
  }

  userPrincipal(user: string): Principal {
    return { kind: "user", userId: this.idOf(user) };
  }

  tokenPrincipal(user: string): Principal {
    return { kind: "token", userId: this.idOf(user), token: tokenFor(user) };
  }

  /** The id behind a user name or any label. */
  idOf(label: string): string {
    return this.labels.id(label);
  }

  /** A server row by label, read straight from the db (no call is recorded). */
  row(label: string): Promise<any> {
    return this.backend.db.get(this.idOf(label));
  }

  /**
   * A browser on its own machine for `user`: a host window and its followers,
   * booted against the server and drained. Starts the world first.
   */
  async device(user: string, opts: DeviceOptions = {}): Promise<SimDevice> {
    await this.start();
    this.requireUser(user);
    const taken = new Set(this.devices.map((d) => d.name));
    let name = opts.name ?? user;
    for (let i = 2; !opts.name && taken.has(name); i++) name = `${user}${i}`;
    if (taken.has(name)) throw new Error(`sim world: a device named "${name}" already exists`);
    const scope: BootScope | undefined = opts.scope && opts.scope !== "mine" ? { team: this.idOf(opts.scope.team) } : opts.scope;
    const device = new SimDevice(this, { userId: this.idOf(user) }, name);
    this.devices.push(device);
    return device.start({ followers: opts.followers, scope });
  }

  /** Runs every delivery that is ready or comes due within the drain horizon. */
  async settle(): Promise<void> {
    await this.start();
    await this.net.drain();
  }

  /**
   * Runs up to `n` deliveries chosen by the interleave rule, then returns to
   * the current mode. In interleave or order mode it simply steps under that
   * mode, so an order replay keeps its place. Returns how many ran.
   */
  async interleave(n: number): Promise<number> {
    await this.start();
    const scripted = this.net.mode === "scripted";
    if (scripted) this.net.mode = "interleave";
    let ran = 0;
    try {
      while (ran < n && (await this.net.step())) ran++;
    } finally {
      if (scripted) this.net.mode = "scripted";
    }
    return ran;
  }

  /**
   * Fires a cron (or any internal function) once, as the scheduler would: a
   * `sched` delivery under the system principal. A failure stays in
   * backend.calls, as a failed cron run stays in the dashboard.
   */
  cron(name: string, args: Record<string, unknown> = {}): number {
    return this.net.enqueue("sched", {
      label: `cron ${name}`,
      producer: `cron ${name}`,
      run: async () => {
        await this.start();
        await this.backend.runInternal(name, args).catch(() => {});
      },
    });
  }

  // -- Genesis --

  private async genesis(): Promise<void> {
    const gen = genTeamWorld({
      users: this.users,
      teams: [...this.teams].map(([name, t]) => ({ name, members: t.members, features: t.features })),
      rowsPerUser: this.opts.rowsPerUser ?? DEFAULT_ROWS_PER_USER,
      seed: this.seed,
      epoch: this.epoch,
    });
    for (const name of this.users) this.labels.register(userIdFor(name), name);
    for (const name of this.teams.keys()) this.labels.register(teamIdFor(name), name);

    const homeTeam = new Map<string, string | undefined>(gen.users.map((u) => [u._id, u.team_id]));
    const conversations: WorldRow[] = [];
    const managed: WorldRow[] = [];
    const stamps: { id: string; team_id?: string; is_private: boolean }[] = [];
    const draw = realm.stream("genesis");
    const stamp = (row: WorldRow, isPrivate: boolean) => {
      const team_id = homeTeam.get(row.user_id);
      stamps.push({ id: row._id, ...(team_id ? { team_id } : {}), is_private: isPrivate });
    };

    for (const name of this.users) {
      const world = gen.perUser[name];
      world.conversations.forEach((row, i) => {
        const conv: WorldRow = { ...row, session_id: sessionIdFor(row._id) };
        conversations.push(conv);
        this.labels.register(conv._id, `${name}/g${i}`);
        stamp(conv, draw() < 0.5);
      });
      for (const ms of world.managed_sessions) managed.push({ ...ms, session_id: sessionIdFor(ms.conversation_id) });
    }
    for (const { user, name, opts } of this.sessions) {
      const _id = convexIdFor(`session:${user}/${name}`);
      const conv: WorldRow = {
        _id,
        user_id: userIdFor(user),
        status: "active",
        updated_at: this.epoch - GEN_MIN,
        started_at: this.epoch - 60 * GEN_MIN,
        message_count: 3,
        last_message_role: "assistant",
        title: `${user}/${name}`,
        session_id: sessionIdFor(_id),
        ...opts.row,
      };
      conversations.push(conv);
      this.labels.register(_id, `${user}/${name}`);
      stamp(conv, opts.private ?? false);
      if (opts.agentStatus) {
        managed.push({
          _id: convexIdFor(`managed:${user}/${name}`),
          user_id: conv.user_id,
          conversation_id: _id,
          session_id: conv.session_id,
          last_heartbeat: this.epoch,
          agent_status: opts.agentStatus,
          agent_status_updated_at: this.epoch - GEN_MIN,
        });
      }
    }

    const tokens = await Promise.all(
      this.users.map(async (name) => ({
        _id: convexIdFor(`token:${name}`),
        user_id: userIdFor(name),
        token_hash: await hashToken(tokenFor(name)),
        name: "sim daemon",
        created_at: this.epoch - GEN_MIN,
        last_used_at: this.epoch - GEN_MIN,
      })),
    );

    const tables: Record<string, any[]> = {
      users: gen.users,
      teams: gen.teams,
      team_memberships: [],
      api_tokens: tokens,
      conversations,
      managed_sessions: managed,
      session_decisions: this.users.flatMap((n) => gen.perUser[n].session_decisions),
      session_owners: this.users.flatMap((n) => gen.perUser[n].session_owners),
      // The armed trigger behind each generated session's armed_trigger_kind.
      agent_tasks: gen.agent_tasks,
    };
    this._backend = makeSimBackend({
      tables,
      now: realm.now,
      rngFor: (seq) => realm.stream(`call:${seq}`),
      mintId: (table, n) => convexIdFor(`${table}:${n}`),
      onInsert: (table, id) => this.onInsert(table, id),
      onSchedule: (job) => {
        this.net.enqueue("sched", {
          due: job.due,
          label: `sched ${job.name}`,
          producer: `sched ${job.name}`,
          run: () => this.backend.runScheduled(job),
        });
      },
      modules: { [GENESIS_MODULE]: async () => GENESIS },
      debug: this.opts.debug,
    });

    // 1-2. Memberships through the change log, then real visibility stamps.
    await this.backend.runInternal(`${GENESIS_MODULE}:addMembers`, {
      rows: gen.team_memberships.map(({ _id, ...row }) => row),
    });
    await this.backend.runInternal(`${GENESIS_MODULE}:stampConversations`, { stamps });

    // 3. Chat channels, roles, work items and triggers through their real create mutations.
    for (const [team, t] of this.teams) {
      if (!t.features?.chat || !t.members.length) continue;
      this.nextLabel.set("chat_channels", `chan:${team}/general`);
      await this.clientAs(t.members[0]).mutation("chat:createChannel", { team_id: teamIdFor(team), name: "general", is_default: true });
    }
    for (const { team, handle } of this.roles) {
      this.nextLabel.set("org_roles", `role:${team}/${handle}`);
      const admin = this.teams.get(team)!.members[0];
      await this.clientAs(admin).mutation("orgRoles:create", { team_id: teamIdFor(team), name: handle, handle, provision: true });
    }
    for (const { kind, name, opts } of this.workItems) await this.createWorkItem(kind, name, opts);
    for (const { name, opts } of this.triggers) {
      this.nextLabel.set("agent_tasks", `trigger:${name}`);
      await this.daemonClientAs(opts.owner).mutation("agentTasks:createTask", {
        title: name,
        prompt: `sim trigger ${name}`,
        schedule_type: "once",
        run_at: realm.now() + (opts.runInMs ?? 0),
        originating_session_ref: this.idOf(opts.session),
      });
    }
    const unclaimed = [...this.nextLabel].map(([table, label]) => `${label} (${table})`);
    if (unclaimed.length) throw new Error(`sim world: genesis created no row for ${unclaimed.join(", ")}`);

    await this.assertSweepClean("genesis");
  }

  private async createWorkItem(kind: WorkKind, name: string, opts: WorkItemOptions): Promise<void> {
    const table = `${kind}s`;
    this.nextLabel.set(table, `${kind}:${name}`);
    // The CLI sends its own session id, which the server resolves by session_id.
    const conversation_id = opts.session ? sessionIdFor(this.idOf(opts.session)) : undefined;
    const client = this.daemonClientAs(opts.owner);
    if (kind === "task") await client.mutation("tasks:create", { title: name, conversation_id });
    else if (kind === "doc") await client.mutation("docs:create", { title: name, content: `sim doc ${name}`, conversation_id });
    else await client.mutation("plans:create", { title: name, goal: `sim plan ${name}`, conversation_id });
  }

  /**
   * teamScopeSweep over every work-item table reports no stale and no missing
   * workspace key, and writes nothing. Genesis ends here; invariants reuse it.
   */
  sweepFindings(): Promise<{ findings: any[]; missing: number; writes: number }> {
    return scopeSweep(this.backend);
  }

  private async assertSweepClean(when: string): Promise<void> {
    const { findings, missing, writes } = await this.sweepFindings();
    if (!findings.length && !missing && !writes) return;
    throw new Error(
      `sim world: ${when} gate failed: teamScopeSweep found ${findings.length} stale and ${missing} missing workspace keys`
      + ` and wrote ${writes} rows\n${this.labels.relabel(JSON.stringify(findings, null, 2))}`,
    );
  }

  // -- Internals --

  // A row a declaration created takes the declared label; every insert is
  // numbered per table (labels.onInsert keeps a name it already has).
  private onInsert(table: string, id: string): void {
    const label = this.nextLabel.get(table);
    if (label) {
      this.nextLabel.delete(table);
      this.labels.register(id, label);
    }
    this.labels.onInsert(table, id);
  }

  private workItem(kind: WorkKind, name: string, opts: WorkItemOptions): string {
    this.declaring(`${kind}("${name}")`);
    this.requireUser(opts.owner);
    this.workItems.push({ kind, name, opts });
    return `${kind}:${name}`;
  }

  private declaring(what: string): void {
    if (this.started) throw new Error(`sim world: ${what} after start(); declare the world before the first async verb`);
  }

  private requireUser(name: string): void {
    if (!this.users.includes(name)) throw new Error(`sim world: user "${name}" is not declared; call user("${name}", teams) first`);
  }
}

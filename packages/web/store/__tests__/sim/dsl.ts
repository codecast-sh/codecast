// The scenario DSL (docs/architecture/multiplayer-sim-harness.md, section 3.8).
//
// A scenario is one async function over a world. It declares the world, opens
// devices, then acts through verbs and asserts through point checks:
//
//   scenario({ name: "visibilityFlip" }, async (w) => {
//     w.team("acme").user("ada", ["acme"]).user("bo", ["acme"]);
//     w.session("ada", "s", { private: true });
//     const ada = await w.device("ada");
//     await w.human(ada.host).setPrivacy("ada/s", "team");
//     await w.expect("bo").cannotRead("task:t");
//   });
//
// VERBS (w.human, w.daemon, w.agent, w.admin, w.advance) are the actors of
// sim/actors.ts: each enqueues one delivery on `actor:<name>`. Awaiting the
// verb is where the mode shows. Scripted mode drains the net there, so each
// verb lands before the next starts. Interleave mode returns at once, so the
// verbs pile up and race at the next settle() or point check, which is how
// one file runs in every mode.
//
// CHECKS. Every settle() runs the whole invariant catalog (sim/invariants.ts),
// every delivery that touches a window runs the catalog's `always` rules over
// that window, and every point check (w.expect, w.inspect) settles first. The
// first failure becomes the report block of sim/report.ts, with its artifacts.
//
// RUNS. Each scenario is one describe with one test per (mode, seed). Seeds
// come from the scenario's name, so adding a scenario never moves another's.
// The SIM_* variables the runner (scripts/sim.ts) sets are read here:
//
//   SIM_SEEDS=a,b   pin the seeds          SIM_SWEEP=N   N interleave seeds
//   SIM_ORDER=...   replay one order       SIM_RED=1     only red scenarios
//   SIM_TRACE=lbl   stream the deliveries touching a label ("1": all of them)
//   SIM_OUT=dir     write artifacts on a pass too
//
// RED AND KNOWN. A scenario names the bugs it runs into. `red` markers are
// the failures its runs end in: a red run must stop on a SimFailure whose
// invariant (or point check) a marker names, so a harness error, a timeout or
// a failure on another invariant fails the test, and a red run that passes
// fails with the flip message until the marker goes. `known` invariants are
// left out of every run, so a run reaches the scenario's own checks past a bug
// that trips earlier; one extra run with nothing left out must still fail on
// a known invariant, so fixing that bug flips it too.

import { describe, test } from "bun:test";
import { fnv1a32 } from "@codecast/shared/contracts";
import { canonical } from "@codecast/shared/contracts/orgChange";
import { canAccessConversation } from "@codecast/convex/convex/lib/access";
import { accessJudgeFor } from "@codecast/convex/convex/lib/accessKeys";
import { INVARIANTS, checkInvariants, failureContext, windowContext } from "./invariants";
import { mentionTarget, mentionWakes, type CheckMode } from "./invariantReads";
import { SimNetError, parseOrder, type Channel, type Delivery } from "./net";
import { T0, installRealm, uninstallRealm } from "./realm";
import {
  SimFailure,
  artifactDir,
  renderDeliveries,
  reportFailure,
  writeArtifacts,
  type DeliveryRecord,
  type FailureContext,
  type RunArtifacts,
  type SimMode,
} from "./report";
import { SimWorld } from "./world";
import type { SimWindow } from "./window";

// ── Options and runs ────────────────────────────────────────────────────────

/** A bug a run fails on: the task that tracks it and the invariant or point check id it fails with. */
export interface RedMarker {
  task: string;
  invariant: string;
  /** Only runs in these modes and at these seeds fail on it (an order that reaches it); the rest must pass. An order replay matches any mode. */
  modes?: ("scripted" | "interleave")[];
  seeds?: number[];
}

/** Invariant id to the task (or tasks) whose bug trips it in every run. */
export type KnownInvariants = Readonly<Record<string, string | readonly string[]>>;

export interface ScenarioOptions {
  name: string;
  /** The bugs this scenario's runs end in. */
  red?: RedMarker | RedMarker[];
  /** Left out of every run: each is tripped by a known bug before the scenario's own checks. */
  known?: KnownInvariants;
  /** Interleave seeds per run. Default 2; SIM_SWEEP overrides it. */
  seeds?: number;
  /** Default: scripted and interleave. */
  modes?: ("scripted" | "interleave")[];
  /** Overrides the net's hard budgets (sim/net.ts DEFAULT_MAX_*). */
  budget?: { deliveries?: number; writes?: number };
  runOn?: "in-process";
}

/** One test of a scenario. */
export interface ScenarioRun {
  mode: SimMode;
  seed: number;
  /** The channel list an order replay follows. */
  order?: Channel[];
  /** Drain the net when a verb is awaited (scripted runs, and replays of them). */
  drainPerVerb: boolean;
}

export type SimEnv = Record<string, string | undefined>;

const DEFAULT_SEEDS = 2;
/**
 * Leads the --order line of a scripted run. A scripted run drains after each
 * verb and an interleave run only at settle, so a replay must drain where the
 * recorded run did; this word carries which one it was. Channel names always
 * hold a ':' or are "sched", so it cannot be mistaken for one.
 */
export const SCRIPTED_ORDER_MARK = "scripted";
/** Per test. Genesis and window boots run hundreds of real handler calls on a loaded machine. */
const SCENARIO_TIMEOUT_MS = 180_000;

/** The first seed of a scenario; its runs use this and the ones after it. */
export function seedBase(name: string): number {
  return fnv1a32(name) % 1_000_000;
}

function parseSeeds(value: string): number[] {
  const seeds = value.split(",").map((s) => Number(s.trim()));
  if (!seeds.length || seeds.some((s) => !Number.isSafeInteger(s) || s < 0)) {
    throw new Error(`sim dsl: SIM_SEEDS takes comma separated non-negative integers, got "${value}"`);
  }
  return seeds;
}

/**
 * The (mode, seed) runs a scenario registers. Scripted runs at the first seed
 * and interleave at every seed. Under SIM_ORDER every seed runs one order
 * replay instead, and draining follows the recorded run (SCRIPTED_ORDER_MARK).
 */
export function scenarioRuns(opts: Pick<ScenarioOptions, "name" | "seeds" | "modes">, env: SimEnv = process.env): ScenarioRun[] {
  const count = env.SIM_SWEEP ? Number(env.SIM_SWEEP) : (opts.seeds ?? DEFAULT_SEEDS);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`sim dsl: a scenario needs at least one seed, got ${count}`);
  const base = seedBase(opts.name);
  const seeds = env.SIM_SEEDS ? parseSeeds(env.SIM_SEEDS) : Array.from({ length: count }, (_, i) => base + i);
  if (env.SIM_ORDER) {
    const tokens = parseOrder(env.SIM_ORDER);
    const scripted = tokens[0] === SCRIPTED_ORDER_MARK;
    const order = scripted ? tokens.slice(1) : tokens;
    return (env.SIM_SEEDS ? seeds : seeds.slice(0, 1)).map((seed) => ({ mode: "order", seed, order, drainPerVerb: scripted }));
  }
  const modes = opts.modes ?? ["scripted", "interleave"];
  const runs: ScenarioRun[] = [];
  if (modes.includes("scripted")) runs.push({ mode: "scripted", seed: seeds[0], drainPerVerb: true });
  if (modes.includes("interleave")) for (const seed of seeds) runs.push({ mode: "interleave", seed, drainPerVerb: false });
  return runs;
}

/** The red markers, as a list. */
export function redMarkers(opts: Pick<ScenarioOptions, "red">): RedMarker[] {
  return opts.red === undefined ? [] : Array.isArray(opts.red) ? opts.red : [opts.red];
}

/** The markers one run must fail on: every red marker whose modes and seeds take in the run. */
export function redFor(opts: Pick<ScenarioOptions, "red">, run: Pick<ScenarioRun, "mode" | "seed">): RedMarker[] {
  return redMarkers(opts).filter((m) => (!m.seeds || m.seeds.includes(run.seed)) && (!m.modes || run.mode === "order" || m.modes.includes(run.mode)));
}

/** The markers the known check run must fail on: one per known invariant. */
export function knownMarkers(opts: Pick<ScenarioOptions, "known">): RedMarker[] {
  return Object.entries(opts.known ?? {}).map(([invariant, task]) => ({ task: typeof task === "string" ? task : task.join(", "), invariant }));
}

const tasksOf = (markers: readonly RedMarker[]) => [...new Set(markers.map((m) => m.task))].join(", ");

/** What a run prints when it passes despite its markers: the bugs they name are gone from it. */
export function redFlipMessage(name: string, markers: readonly RedMarker[], field: "red" | "known" = "red"): string {
  const what = markers.map((m) => `${m.invariant} (${m.task})`).join(", ");
  return field === "red"
    ? `red scenario "${name}" now passes; it was marked to fail on ${what}. Remove those red: markers and close ${tasksOf(markers)}`
    : `scenario "${name}" no longer fails on ${what} with nothing left out; remove them from known: and close ${tasksOf(markers)}`;
}

// ── Verbs ───────────────────────────────────────────────────────────────────

/**
 * What a verb returns: its delivery's seq, and a thenable. Awaiting it drains
 * the net in scripted mode and does nothing in interleave mode. Nothing runs
 * until it is awaited, so a verb that is not awaited simply waits for the
 * next settle() or point check.
 */
export class Step implements PromiseLike<number> {
  constructor(
    readonly seq: number,
    private readonly land: () => Promise<void>,
  ) {}

  then<A = number, B = never>(onFulfilled?: ((seq: number) => A | PromiseLike<A>) | null, onRejected?: ((e: any) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.land().then(() => this.seq).then(onFulfilled, onRejected);
  }
}

/** An actor whose verbs return a Step instead of a bare seq. */
export type Stepped<T> = { [K in keyof T]: T[K] extends (...args: infer A) => number ? (...args: A) => Step : T[K] };

// ── Point checks ────────────────────────────────────────────────────────────

export interface WindowChecks {
  /** The window lists the session among its active rows, in `bucket` when given. */
  shows(label: string, opts?: { bucket?: string }): Promise<void>;
  /** The window does not list the session among its active rows. */
  hides(label: string): Promise<void>;
}

export interface UserChecks {
  /** The server refuses the user the row, and none of the user's windows holds it. */
  cannotRead(label: string): Promise<void>;
}

export interface RoleChecks {
  /** Exactly n chat mention wakes were enqueued for the role. */
  wokenTimes(n: number): Promise<void>;
}

export interface ServerChecks {
  row(label: string): { has(fields: Record<string, unknown>): Promise<void>; gone(): Promise<void> };
  gone(label: string): Promise<void>;
}

export interface Expect {
  (win: SimWindow): WindowChecks;
  /** A user name for cannotRead, a role label (`role:<team>/<handle>`) for wokenTimes. */
  (subject: string): UserChecks & RoleChecks;
  server: ServerChecks;
}

/** What w.inspect returns: the server row and every collection of every window holding it. */
export interface Inspection {
  label: string;
  id: string;
  table: string | null;
  server: Record<string, unknown> | null;
  windows: Record<string, Record<string, unknown>>;
}

type Row = Record<string, unknown>;
type PointFailure = { message: string; row?: FailureContext["row"]; window?: FailureContext["window"] };

// The store keys of a window's state that hold `id`: a record keyed by it, or a set of it.
function heldIn(state: Record<string, unknown>, id: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value instanceof Set) {
      if (value.has(id)) out[key] = true;
    } else if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Map) && Object.prototype.hasOwnProperty.call(value, id)) {
      out[key] = (value as Row)[id];
    }
  }
  return out;
}

// The delivery's window names: conn:<w>, live:<w>:<feed>, repl:<from>><to>,
// timer:<w>, actor:<w> name one; bridge:<device>:<from> reaches the device's windows.
function touchedWindows(world: SimWorld, channel: Channel): SimWindow[] {
  const [kind, ...parts] = channel.split(/[:>]/);
  const names = kind === "bridge" ? (world.devices.find((d) => d.name === parts[0])?.windows.map((w) => w.name) ?? []) : parts;
  const out: SimWindow[] = [];
  for (const name of new Set(names)) {
    const w = world.windows.get(name);
    if (w && !w.closed) out.push(w);
  }
  return out;
}

// ── The scenario world ──────────────────────────────────────────────────────

export interface ScenarioWorldOptions {
  scenario: string;
  run: ScenarioRun;
  budget?: ScenarioOptions["budget"];
  /** Invariant ids left out of every check, each with the task that explains why (a scenario's `known`). */
  skipInvariants?: KnownInvariants;
  /** The markers this run may fail on; a failure naming one reports as expected. */
  expected?: readonly RedMarker[];
  /** SIM_TRACE: a label, or "1" for every delivery. */
  trace?: string;
}

/** A SimWorld with the DSL's verbs, point checks, and the run's report state. */
export class ScenarioWorld extends SimWorld {
  readonly scenario: string;
  readonly mode: SimMode;
  readonly drainPerVerb: boolean;
  /** Every delivery of the run, in order (events.jsonl). */
  readonly events: DeliveryRecord[] = [];
  readonly expect: Expect;

  private readonly checkIds: readonly string[] | undefined;
  private readonly expected: readonly RedMarker[];
  private readonly trace: string | undefined;
  private stepName = "start";
  private settles = 0;
  // The world as the last full check saw it; an unchanged one is not checked again.
  private checkedAt: string | null = null;

  constructor(opts: ScenarioWorldOptions) {
    // The net calls these hooks only after construction, so they can reach the instance.
    const self: { w?: ScenarioWorld } = {};
    super({
      seed: opts.run.seed,
      maxDeliveries: opts.budget?.deliveries,
      maxWrites: opts.budget?.writes,
      onDeliver: (d) => self.w!.delivered(d),
      afterDeliver: (d) => self.w!.afterDelivery(d),
    });
    self.w = this;
    this.scenario = opts.scenario;
    this.mode = opts.run.mode;
    this.drainPerVerb = opts.run.drainPerVerb;
    this.trace = opts.trace;
    this.expected = opts.expected ?? [];
    const skip = opts.skipInvariants ?? {};
    this.checkIds = Object.keys(skip).length ? INVARIANTS.map((i) => i.id).filter((id) => !(id in skip)) : undefined;
    this.net.mode = opts.run.mode === "order" ? { order: opts.run.order ?? [] } : opts.run.mode;
    this.expect = this.makeExpect();
  }

  // -- Verbs --

  human(win: SimWindow) {
    return this.stepped(this.actors.human(win));
  }

  daemon(user: string) {
    return this.stepped(this.actors.daemon(user));
  }

  agent(session: string) {
    return this.stepped(this.actors.agent(session));
  }

  admin(user: string) {
    return this.stepped(this.actors.admin(user));
  }

  /** Moves the virtual clock; what comes due runs at the next drain. */
  advance(ms: number): Step {
    return this.verb(`advance ${ms}ms`, this.actors.clock.advance(ms));
  }

  private stepped<T extends object>(actor: T): Stepped<T> {
    return new Proxy(actor, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => this.verb(`${String(key)} ${args.map((a) => (typeof a === "string" ? a : canonical(a))).join(" ")}`.trim(), value.apply(target, args));
      },
    }) as Stepped<T>;
  }

  private verb(what: string, seq: number): Step {
    return new Step(seq, async () => {
      if (!this.drainPerVerb) return;
      this.stepName = what;
      await this.start();
      await this.net.drain();
    });
  }

  // -- Settling and checks --

  /** Drains the net, then runs every invariant. */
  override async settle(): Promise<void> {
    await this.settleAs(`settle #${++this.settles}`);
  }

  /** The --order line of this run, as a replay reads it back. */
  orderLine(): Channel[] {
    const order = this.net.orderSoFar();
    return this.drainPerVerb ? [SCRIPTED_ORDER_MARK, ...order] : order;
  }

  /** The run's facts a report needs, at this moment. */
  reportBase(step = this.stepName): Omit<FailureContext, "invariant" | "message" | "window" | "row"> {
    return {
      scenario: this.scenario,
      mode: this.mode,
      seed: this.seed,
      step,
      delivery: this.net.deliveries,
      ring: this.net.ring,
      order: this.orderLine(),
      labels: this.labels,
      t0: T0,
    };
  }

  /** What the artifacts hold besides the report: no raw server rows, so no denylisted field. */
  artifacts(): RunArtifacts {
    return {
      events: this.events,
      world: {
        scenario: this.scenario,
        mode: this.mode,
        seed: this.seed,
        labels: Object.fromEntries(this.labels.entries()),
        devices: this.devices.map((d) => ({ name: d.name, windows: d.windows.map((w) => ({ name: w.name, role: w.role, closed: w.closed })) })),
      },
      final: {
        deliveries: this.net.deliveries,
        writesSpent: this.net.writesSpent,
        producers: Object.fromEntries(this.net.producers()),
        calls: this.hasBackend() ? this.backend.calls.map((c) => ({ seq: c.seq, name: c.name, kind: c.kind, ok: c.ok, error: c.error })) : [],
        actors: this.actors.log.map((e) => ({ actor: e.actor, verb: e.verb, ok: e.ok, error: e.error })),
        windowErrors: Object.fromEntries([...this.windows].filter(([, w]) => w.errors.length).map(([name, w]) => [name, w.errors])),
      },
    };
  }

  /** Writes the artifacts, prints the block and throws it as a SimFailure; a failure a marker names prints as expected. */
  fail(ctx: FailureContext): never {
    const marker = this.expected.find((m) => m.invariant === ctx.invariant.id);
    return reportFailure(marker ? { ...ctx, expected: marker.task } : ctx, this.artifacts());
  }

  private hasBackend(): boolean {
    try {
      return Boolean(this.backend);
    } catch {
      return false;
    }
  }

  /** settle() under a step name the report prints ("end", "expect ..."). */
  async settleAs(step: string): Promise<void> {
    this.stepName = step;
    await super.settle();
    // Nothing ran and nothing was written since the last full check: it would see the same world.
    const at = `${this.net.deliveries}:${this.backend.writes()}`;
    if (at === this.checkedAt) return;
    await this.check("settle", step);
    this.checkedAt = `${this.net.deliveries}:${this.backend.writes()}`;
  }

  private async check(mode: CheckMode, step: string, windows?: SimWindow[]): Promise<void> {
    const failures = await checkInvariants(this, { mode, ids: this.checkIds, windows });
    if (failures.length) this.fail(failureContext(failures[0], this.reportBase(step)));
  }

  private delivered(d: Delivery): void {
    this.events.push({ seq: d.seq, channel: d.channel, due: d.due, label: d.label, producer: d.producer });
    if (!this.trace) return;
    const text = `${d.channel} ${d.label} ${d.producer}`;
    const id = this.trace !== "1" && this.labels.has(this.trace) ? this.labels.id(this.trace) : null;
    if (this.trace !== "1" && !(id && text.includes(id)) && !this.labels.relabel(text).includes(this.trace)) return;
    console.log(`sim trace ${this.scenario} [${this.mode} seed ${this.seed}]  ${renderDeliveries([d], this.labels, T0)[0]}`);
  }

  // The always rules, over the windows the delivery touched.
  private async afterDelivery(d: Delivery): Promise<void> {
    const windows = touchedWindows(this, d.channel);
    if (windows.length) await this.check("always", `${this.stepName}, after the delivery of #${d.seq}`, windows);
  }

  // -- Point checks --

  /** The server row and every window's copy of it, printed with labels and returned. */
  async inspect(label: string): Promise<Inspection> {
    await this.settleAs(`inspect ${label}`);
    const id = this.idOf(label);
    const windows: Inspection["windows"] = {};
    for (const [name, w] of this.windows) {
      const held = heldIn(w.store.getState() as unknown as Record<string, unknown>, id);
      if (Object.keys(held).length) windows[name] = held;
    }
    const out: Inspection = { label, id, table: this.tableOf(id), server: (await this.row(label)) ?? null, windows };
    console.log(`sim inspect ${label}\n${this.labels.relabel(JSON.stringify(out, null, 2))}`);
    return out;
  }

  private tableOf(id: string): string | null {
    for (const [table, rows] of Object.entries<any[]>(this.backend.db._tables)) {
      if (rows.some((r) => r?._id === id)) return table;
    }
    return null;
  }

  // Settles, runs the check, and reports what it returns as a failure.
  private async point(id: string, meaning: string, check: () => Promise<PointFailure | null>): Promise<void> {
    const step = `expect ${meaning}`;
    await this.settleAs(step);
    const f = await check();
    if (f) this.fail({ ...this.reportBase(step), invariant: { id, meaning }, ...f });
  }

  private makeExpect(): Expect {
    const subject = ((s: SimWindow | string) => {
      if (typeof s !== "string") return this.windowChecks(s);
      return { ...this.userChecks(s), ...this.roleChecks(s) };
    }) as unknown as Expect;
    subject.server = {
      row: (label) => ({
        has: (fields) => this.serverHas(label, fields),
        gone: () => this.serverGone(label),
      }),
      gone: (label) => this.serverGone(label),
    };
    return subject;
  }

  private windowChecks(win: SimWindow): WindowChecks {
    const listed = async (label: string) => {
      const id = this.idOf(label);
      const window = windowContext(win);
      const placed = await win.placed(window.scope === "mine" ? "mine" : "team");
      const shown = placed.sorted.some((s) => s._id === id);
      const placement = placed.placements.get(id);
      const replica = ((win.store.getState() as any).sessions?.[id] as Row | undefined) ?? null;
      const row = { table: "conversations", id, server: (await this.row(label)) ?? null, replica };
      const where = placement ? `placed ${placement.bucket}/${placement.work_state ?? "-"}${placement.below_fold ? " below the fold" : ""}` : "not placed";
      return { shown, placement, window, row, where };
    };
    return {
      shows: (label, opts = {}) =>
        this.point("expect.shows", `window ${win.name} shows ${label}${opts.bucket ? ` in ${opts.bucket}` : ""}`, async () => {
          const { shown, placement, window, row, where } = await listed(label);
          if (shown && (!opts.bucket || placement?.bucket === opts.bucket)) return null;
          return { message: shown ? `${label} is listed but ${where}` : `${label} is not among the active rows (${where})`, window, row };
        }),
      hides: (label) =>
        this.point("expect.hides", `window ${win.name} hides ${label}`, async () => {
          const { shown, window, row, where } = await listed(label);
          return shown ? { message: `${label} is among the active rows (${where})`, window, row } : null;
        }),
    };
  }

  private userChecks(user: string): UserChecks {
    return {
      cannotRead: (label) => {
        if (user.startsWith("role:")) throw new Error(`sim dsl: cannotRead takes a user name, got the role "${user}"`);
        return this.point("expect.cannotRead", `${user} cannot read ${label}`, async () => {
          const userId = this.idOf(user);
          const id = this.idOf(label);
          const server = (await this.row(label)) ?? null;
          const table = this.tableOf(id);
          if (server && table) {
            const ctx = { db: this.backend.db };
            const readable = table === "conversations"
              ? await canAccessConversation(ctx, userId as any, server as any)
              : await (await accessJudgeFor(ctx, userId as any))(table, server);
            if (readable) return { message: `the server lets ${user} read ${label}`, row: { table, id, server, replica: null } };
          }
          for (const w of this.windows.values()) {
            if (w.closed || w.user.userId !== userId) continue;
            const held = heldIn(w.store.getState() as unknown as Record<string, unknown>, id);
            const keys = Object.keys(held);
            if (!keys.length) continue;
            const replica = keys.map((k) => held[k]).find((v): v is Row => Boolean(v) && typeof v === "object") ?? null;
            return { message: `window ${w.name} still holds ${label} in ${keys.join(", ")}`, window: windowContext(w), row: { table: table ?? "unknown", id, server, replica } };
          }
          return null;
        });
      },
    };
  }

  private roleChecks(role: string): RoleChecks {
    return {
      wokenTimes: (n) => {
        if (!role.startsWith("role:")) throw new Error(`sim dsl: wokenTimes takes a role label (role:<team>/<handle>), got "${role}"`);
        return this.point("expect.wokenTimes", `${role} woken ${n} time(s)`, async () => {
          const roleId = this.idOf(role);
          const wakes = mentionWakes(this).filter((r) => mentionTarget(r) === roleId);
          if (wakes.length === n) return null;
          const role_row = (await this.row(role)) ?? null;
          return { message: `${wakes.length} mention wake(s) were enqueued for ${role}, expected ${n}`, row: { table: "org_roles", id: roleId, server: role_row, replica: null } };
        });
      },
    };
  }

  private async serverHas(label: string, fields: Record<string, unknown>): Promise<void> {
    await this.point("expect.server.has", `the server's ${label} has ${canonical(fields)}`, async () => {
      const id = this.idOf(label);
      const server = (await this.row(label)) ?? null;
      const table = this.tableOf(id) ?? "unknown";
      if (!server) return { message: `${label} is not on the server`, row: { table, id, server: null, replica: fields } };
      const wrong = Object.keys(fields).filter((k) => canonical(server[k]) !== canonical(fields[k]));
      if (!wrong.length) return null;
      // The expected values in the replica column, so the diff shows exactly the fields that disagree.
      return { message: `${wrong.join(", ")} differ (server column: the row, replica column: expected)`, row: { table, id, server, replica: { ...server, ...fields } } };
    });
  }

  private async serverGone(label: string): Promise<void> {
    await this.point("expect.server.gone", `${label} is gone from the server`, async () => {
      const id = this.idOf(label);
      const server = (await this.row(label)) ?? null;
      return server ? { message: `${label} is still on the server`, row: { table: this.tableOf(id) ?? "unknown", id, server, replica: null } } : null;
    });
  }
}

// ── Running ─────────────────────────────────────────────────────────────────

export interface ScenarioOutcome {
  /** Every delivery of the run. */
  events: DeliveryRecord[];
  /** The --order line the run would print. */
  order: Channel[];
  /** Where the pass artifacts went (SIM_OUT only). */
  artifacts?: string;
}

export interface RunExtra {
  env?: SimEnv;
  skipInvariants?: KnownInvariants;
  /** The markers the run may fail on (judgeRun's expectation). */
  expected?: readonly RedMarker[];
}

/**
 * One run of a scenario: a fresh realm and world, the scenario, a final
 * settle, and the artifacts. A failing check throws a SimFailure carrying the
 * report; a net budget or replay error is reported the same way; any other
 * error is a harness error and propagates as is.
 */
export async function runScenario(
  opts: ScenarioOptions,
  run: ScenarioRun,
  fn: (w: ScenarioWorld) => Promise<void>,
  extra: RunExtra = {},
): Promise<ScenarioOutcome> {
  const env = extra.env ?? process.env;
  installRealm(run.seed);
  let w: ScenarioWorld | null = null;
  try {
    w = new ScenarioWorld({ scenario: opts.name, run, budget: opts.budget, skipInvariants: extra.skipInvariants, expected: extra.expected, trace: env.SIM_TRACE });
    try {
      await fn(w);
      await w.settleAs("end");
    } catch (e) {
      if (e instanceof SimNetError) w.fail({ ...w.reportBase(), invariant: { id: `net.${e.code}`, meaning: "the net's budget or the order replay held" }, message: e.message });
      throw e;
    }
    const outcome: ScenarioOutcome = { events: w.events, order: w.orderLine() };
    if (env.SIM_OUT) {
      outcome.artifacts = artifactDir(opts.name, run.mode, run.seed, env.SIM_OUT);
      writeArtifacts(outcome.artifacts, { scenario: opts.name, mode: run.mode, seed: run.seed, passed: true, deliveries: w.net.deliveries }, w.artifacts());
    }
    return outcome;
  } finally {
    uninstallRealm();
  }
}

/** What a judged run did: passed with no markers, or failed on one of them. */
export type Judgement = { passed: ScenarioOutcome } | { expected: SimFailure };

/**
 * Runs a scenario and holds it to its markers (default: the red markers for
 * the run's seed). With markers, the run must end in a SimFailure naming one
 * of them: that is the expected outcome and resolves. A pass rejects with the
 * flip message. Any other error rejects as is: a harness error, a timeout, or
 * a failure on an invariant no marker names.
 */
export async function judgeRun(
  opts: ScenarioOptions,
  run: ScenarioRun,
  fn: (w: ScenarioWorld) => Promise<void>,
  extra: RunExtra & { field?: "red" | "known" } = {},
): Promise<Judgement> {
  const expected = extra.expected ?? redFor(opts, run);
  let passed: ScenarioOutcome;
  try {
    passed = await runScenario(opts, run, fn, { ...extra, expected });
  } catch (e) {
    if (e instanceof SimFailure && expected.some((m) => m.invariant === e.ctx.invariant.id)) return { expected: e };
    throw e;
  }
  if (expected.length) throw new Error(redFlipMessage(opts.name, expected, extra.field ?? "red"));
  return { passed };
}

/**
 * Registers a scenario: one describe, one test per (mode, seed), each run
 * with the `known` invariants left out and judged against its red markers.
 * A scenario with `known` also registers the known check: its first run with
 * nothing left out, which must fail on a known invariant. Under SIM_RED=1
 * only scenarios with a red marker or a known invariant register.
 */
export function scenario(opts: ScenarioOptions, fn: (w: ScenarioWorld) => Promise<void>): void {
  const known = knownMarkers(opts);
  if (process.env.SIM_RED === "1" && !redMarkers(opts).length && !known.length) return;
  const runs = scenarioRuns(opts);
  describe(opts.name, () => {
    for (const run of runs) {
      const red = redFor(opts, run);
      const name = `${run.mode} seed ${run.seed}${red.length ? ` (red: ${tasksOf(red)})` : ""}`;
      test(name, async () => {
        await judgeRun(opts, run, fn, { skipInvariants: opts.known, expected: red });
      }, SCENARIO_TIMEOUT_MS);
    }
    if (known.length && runs.length) {
      test(`${runs[0].mode} seed ${runs[0].seed}, nothing left out (known: ${tasksOf(known)})`, async () => {
        await judgeRun(opts, runs[0], fn, { expected: known, field: "known" });
      }, SCENARIO_TIMEOUT_MS);
    }
  });
}

export { SimFailure };

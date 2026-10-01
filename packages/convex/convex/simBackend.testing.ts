// The server half of the multiplayer sim (docs/architecture/multiplayer-sim-harness.md
// section 3.2): real Convex handlers over the fake db, reached by function name
// the way a client reaches them, with the parts of the Convex runtime the
// handlers rely on and nothing more.
//
// - Routing: a function reference resolves through MODULES, a literal map of
//   lazy imports, so a run loads only the modules it calls and no import cycle
//   is touched at load. Clients reach public functions only; runInternal
//   reaches any.
// - The wire: arguments and results cross convexToJson/jsonToConvex, so no
//   client object aliases a server row, and arguments are checked against the
//   function's own validator (simValidate.testing.ts).
// - Transactions: top-level calls run one at a time. A mutation that throws
//   rolls back every write it made, sync-log rows included, and drops the jobs
//   it scheduled. Nested runQuery/runMutation run inline in the same journal.
// - Scheduler: runAfter/runAt become ScheduledJobs handed to onSchedule on
//   commit; runScheduled runs one under the system principal (null identity).
// - Memo: the four inbox reads answer from a cache keyed on the db's write
//   count and the inbox epoch, since they are the expensive reads a sim
//   repeats with nothing changed.
//
// Two dots in the name keep the Convex bundler from treating this file as a
// function module, so the dynamic imports below never reach the runtime that
// refuses them. It must not import bun:test: `cast check convex` has no bun
// types.
import { getFunctionName } from "convex/server";
import { convexToJson, jsonToConvex } from "convex/values";
import { inboxEpoch, levenshtein } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";
import { validateArgs, type ValidatorJson } from "./simValidate.testing";

export type Principal =
  | { kind: "user"; userId: string } // identity subject `${userId}|session`
  | { kind: "token"; userId: string; token: string } // api_tokens row seeded with hashToken
  | { kind: "system" }; // scheduled jobs, crons: null identity

export interface ScheduledJob { id: string; due: number; name: string; args: unknown }

export interface CallRecord {
  seq: number;
  principal: Principal;
  name: string;
  kind: "query" | "mutation" | "action";
  ok: boolean;
  error?: string;
  // Db writes the call made (zero after a rollback).
  writes: number;
  // Set on the memoized inbox reads.
  memo?: "hit" | "miss";
}

export interface SimBackendOptions {
  tables: Record<string, any[]>;
  now: () => number;
  rngFor: (callSeq: number) => () => number; // per-call seeded stream
  mintId: (table: string, n: number) => string; // 32-char [a-z0-9]
  onSchedule?: (job: ScheduledJob) => void; // world turns jobs into `sched` deliveries
  onInsert?: (table: string, id: string) => void; // labels
  memoFunctions?: string[]; // default: the four inbox reads
  // Modules beyond MODULES, by the name a reference uses (test fixtures).
  modules?: Record<string, () => Promise<any>>;
  // A top-level call that starts while another runs throws instead of queueing.
  debug?: boolean;
}

export interface SimClient {
  query(ref: any, args: any): Promise<any>;
  mutation(ref: any, args: any): Promise<any>;
  action(ref: any, args: any): Promise<any>; // recorded, not executed
}

// The call running now, so the realm can route Math.random to its stream.
export interface ActiveCall { seq: number; name: string; rng: () => number }

export interface SimBackend {
  db: any;
  clientFor(p: Principal): SimClient;
  runInternal(name: string, args: unknown, p?: Principal): Promise<any>; // internal fns, crons, sweep
  runScheduled(job: ScheduledJob): Promise<void>;
  cancelScheduled(id: string): void;
  writes(): number;
  calls: CallRecord[];
  actions: { name: string; args: unknown }[];
  activeCall(): ActiveCall | null;
}

// Every module a sim run may call. A name missing here fails with the closest
// known function, so adding a module is one line.
const MODULES: Record<string, () => Promise<any>> = {
  syncLog: () => import("./syncLog"),
  conversations: () => import("./conversations"),
  dispatch: () => import("./dispatch"),
  tasks: () => import("./tasks"),
  docs: () => import("./docs"),
  plans: () => import("./plans"),
  projects: () => import("./projects"),
  chat: () => import("./chat"),
  pendingMessages: () => import("./pendingMessages"),
  agentTasks: () => import("./agentTasks"),
  teams: () => import("./teams"),
  anchors: () => import("./anchors"),
  managedSessions: () => import("./managedSessions"),
  orgRoles: () => import("./orgRoles"),
  teamScopeSweep: () => import("./teamScopeSweep"),
  syncLogPrune: () => import("./syncLogPrune"),
  cleanup: () => import("./cleanup"),
};

export const DEFAULT_MEMO_FUNCTIONS = [
  "conversations:listInboxSessions",
  "conversations:sessionsLiveness",
  "conversations:listTeamInboxSessions",
  "conversations:teamSessionsLiveness",
];

type Kind = "query" | "mutation" | "action";

interface Registered {
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  isPublic?: boolean;
  isInternal?: boolean;
  exportArgs(): string;
  _handler(ctx: any, args: any): any;
}

function isRegistered(value: any): value is Registered {
  return !!value && typeof value._handler === "function" && typeof value.exportArgs === "function"
    && (value.isQuery || value.isMutation || value.isAction);
}

function kindOf(fn: Registered): Kind {
  return fn.isQuery ? "query" : fn.isMutation ? "mutation" : "action";
}

// Every field prod puts on some ctx. One of these missing from the ctx a call
// gets reads as undefined, as in prod; any other field is a sim gap.
const KNOWN_CTX_FIELDS = new Set(["db", "auth", "scheduler", "runQuery", "runMutation", "runAction", "storage"]);

function nameOf(ref: any): string {
  const name = typeof ref === "string" ? ref : getFunctionName(ref);
  return name.includes(":") ? name : `${name}:default`;
}

// Across the wire and back: what a client would send or receive.
function wire(value: unknown): any {
  return jsonToConvex(convexToJson((value === undefined ? null : value) as any));
}

export function makeSimBackend(opts: SimBackendOptions): SimBackend {
  const modules = { ...MODULES, ...opts.modules };
  const db = makeFakeDb(opts.tables, { mintId: opts.mintId, creationTime: opts.now, strictPatch: true });
  // `_scheduled_functions`, read by handlers through ctx.db.system.
  const systemDb = makeFakeDb({ _scheduled_functions: [] }, { mintId: opts.mintId, creationTime: opts.now, strictPatch: true });
  db.system = { get: systemDb.get, query: systemDb.query };
  const memoNames = new Set(opts.memoFunctions ?? DEFAULT_MEMO_FUNCTIONS);
  const memo = new Map<string, unknown>();
  let memoWrites = -1;
  const calls: CallRecord[] = [];
  const actions: { name: string; args: unknown }[] = [];
  const argsJson = new WeakMap<Registered, ValidatorJson>();
  let callSeq = 0;
  let active: ActiveCall | null = null;
  // Jobs scheduled by the running top-level call, handed out on commit.
  let scheduledInCall: ScheduledJob[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const inFlight: string[] = [];

  const isId = (table: string, value: string) =>
    (table.startsWith("_") ? systemDb : db).normalizeId(table, value) !== null;

  async function resolve(name: string): Promise<Registered> {
    const cut = name.lastIndexOf(":");
    const moduleName = name.slice(0, cut);
    const exportName = name.slice(cut + 1);
    const loader = modules[moduleName];
    const fn = loader ? (await loader())[exportName] : undefined;
    if (isRegistered(fn)) return fn;
    const suggestion = await closestName(name, moduleName);
    throw new Error(
      `sim client: no handler for "${name}"${suggestion ? `; did you mean ${suggestion}?` : "."}`
      + " Add the module to MODULES in convex/simBackend.testing.ts",
    );
  }

  // The nearest registered function: in the named module when it is known,
  // else in the nearest module name.
  async function closestName(name: string, moduleName: string): Promise<string | null> {
    let home = moduleName in modules ? moduleName : null;
    if (!home) {
      const near = Object.keys(modules)
        .map((m) => [m, levenshtein(moduleName, m)] as const)
        .sort((a, b) => a[1] - b[1])[0];
      if (near && near[1] <= 3) home = near[0];
    }
    if (!home) return null;
    const loaded = await modules[home]!();
    const best = Object.keys(loaded)
      .filter((key) => isRegistered(loaded[key]))
      .map((key) => `${home}:${key}`)
      .map((candidate) => [candidate, levenshtein(name, candidate)] as const)
      .sort((a, b) => a[1] - b[1])[0];
    return best && best[1] <= 3 ? best[0] : null;
  }

  function validatorOf(fn: Registered): ValidatorJson {
    let json = argsJson.get(fn);
    if (!json) argsJson.set(fn, (json = JSON.parse(fn.exportArgs()) as ValidatorJson));
    return json;
  }

  // Wire the arguments, add a token principal's api_token where the function
  // takes one (the CLI passes it in args), and validate them.
  function prepareArgs(fn: Registered, args: unknown, principal: Principal): any {
    const validator = validatorOf(fn);
    let sent = wire(args ?? {});
    if (principal.kind === "token" && validator.type === "object" && "api_token" in validator.value
      && sent && typeof sent === "object" && sent.api_token === undefined) {
      sent = { ...sent, api_token: principal.token };
    }
    validateArgs(validator, sent, { isId });
    return sent;
  }

  // The ctx a handler gets: the fields prod gives a call of this kind, behind
  // a Proxy that names any other field read. functions.ts wraps every tracked
  // mutation by spreading ctx into a plain object, so inside those the guard
  // on unknown fields is gone (they read as undefined); the storage stub
  // travels by reference and still names itself.
  function makeCtx(kind: Kind, principal: Principal, name: string): any {
    const identity = principal.kind === "user" ? { subject: `${principal.userId}|session` } : null;
    const missing = (what: string) =>
      new Error(`sim ctx: ${name} read ctx.${what}, which the sim does not provide. Add it in makeCtx.`);
    // Reading ctx.storage works; touching anything on it is a named gap.
    const storage = new Proxy({}, {
      get(_target, key) {
        if (typeof key === "symbol") return undefined;
        throw missing(`storage.${key}`);
      },
    });
    const refuse = (op: string) => async () => {
      throw new Error(`sim server: query ${name} called db.${op}; queries cannot write`);
    };
    const present: Record<string, unknown> = {
      db: kind === "query"
        ? { get: db.get, query: db.query, normalizeId: db.normalizeId, system: db.system, insert: refuse("insert"), patch: refuse("patch"), replace: refuse("replace"), delete: refuse("delete") }
        : db,
      auth: { getUserIdentity: async () => identity },
      storage,
      runQuery: (ref: any, args: any) => nested(ref, args, principal, "query"),
    };
    if (kind === "mutation") {
      present.runMutation = (ref: any, args: any) => nested(ref, args, principal, "mutation");
      present.scheduler = {
        runAfter: async (ms: number, ref: any, args: any) => schedule(opts.now() + ms, ref, args),
        runAt: async (at: number | Date, ref: any, args: any) => schedule(at instanceof Date ? at.getTime() : at, ref, args),
        cancel: async (id: string) => {
          await systemDb.patch(id, { state: { kind: "canceled" } });
        },
      };
    }
    return new Proxy(present, {
      get(target, key) {
        if (typeof key === "symbol" || key in target) return (target as any)[key];
        if (KNOWN_CTX_FIELDS.has(key)) return undefined;
        throw missing(key);
      },
    });
  }

  async function schedule(due: number, ref: any, args: any): Promise<string> {
    const name = nameOf(ref);
    const sent = wire(args ?? {});
    const id = await systemDb.insert("_scheduled_functions", {
      name,
      args: [sent],
      scheduledTime: due,
      state: { kind: "pending" },
    });
    scheduledInCall.push({ id, due, name, args: sent });
    return id;
  }

  // runQuery/runMutation from inside a handler: inline, same principal, same
  // journal. Each nested mutation still gets its own change-log wrap, because
  // the wrap lives in its own `_handler`.
  async function nested(ref: any, args: any, principal: Principal, kind: Kind): Promise<any> {
    const name = nameOf(ref);
    const fn = await resolve(name);
    if (kindOf(fn) !== kind) throw new Error(`sim server: ctx.run${kind === "query" ? "Query" : "Mutation"} reached ${name}, a ${kindOf(fn)}`);
    const sent = prepareArgs(fn, args, principal);
    return wire(await fn._handler(makeCtx(kind, principal, name), sent));
  }

  // Top-level calls go one at a time, in arrival order, from resolution to
  // commit. In debug mode a call that arrives while another is in flight is
  // refused instead of queued.
  function serialize<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (opts.debug && inFlight.length) {
      return Promise.reject(new Error(`sim server: ${name} started while ${inFlight[0]} was running`));
    }
    inFlight.push(name);
    const result = chain.then(run);
    const done = () => { inFlight.shift(); };
    chain = result.then(done, done);
    return result;
  }

  function topLevel(name: string, args: unknown, principal: Principal, entry: "client" | "internal", expected?: Kind): Promise<any> {
    return serialize(name, () => invoke(name, args, principal, entry, expected));
  }

  // One top-level call, already at the head of the chain: resolve, validate,
  // run in a journal, commit or roll back.
  async function invoke(name: string, args: unknown, principal: Principal, entry: "client" | "internal", expected?: Kind): Promise<any> {
    const seq = ++callSeq;
    const record: CallRecord = { seq, principal, name, kind: expected ?? "query", ok: true, writes: 0 };
    calls.push(record);
    try {
      const fn = await resolve(name);
      const kind = (record.kind = kindOf(fn));
      if (entry === "client" && !fn.isPublic) {
        throw new Error(`sim client: "${name}" is internal; clients reach public functions only (use runInternal)`);
      }
      if (expected && expected !== kind) throw new Error(`sim client: "${name}" is a ${kind}, called as a ${expected}`);
      const sent = prepareArgs(fn, args, principal);
      if (kind === "action") {
        actions.push({ name, args: sent });
        return null;
      }
      return await execute(fn, kind, name, sent, principal, record);
    } catch (error: any) {
      record.ok = false;
      record.error = String(error?.message ?? error);
      throw error;
    }
  }

  async function execute(fn: Registered, kind: Kind, name: string, sent: any, principal: Principal, record: CallRecord): Promise<any> {
    const memoKey = kind === "query" && memoNames.has(name)
      ? JSON.stringify([principal, name, convexToJson(sent), db.__writeCount, inboxEpoch(opts.now())])
      : null;
    if (memoKey) {
      if (memoWrites !== db.__writeCount) {
        memo.clear();
        memoWrites = db.__writeCount;
      }
      if (memo.has(memoKey)) {
        record.memo = "hit";
        return jsonToConvex(memo.get(memoKey) as any);
      }
      record.memo = "miss";
      (await modules.conversations!())._resetChildAuqProbeCacheForTests();
    }
    active = { seq: record.seq, name, rng: opts.rngFor(record.seq) };
    const writesBefore = db.__writeCount;
    const insertsBefore = db._inserted.length;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error(`sim server: ${name} called fetch, which the sim does not allow`);
    }) as any;
    scheduledInCall = [];
    if (kind === "mutation") {
      db.__beginJournal();
      systemDb.__beginJournal();
    }
    try {
      const result = convexToJson((await fn._handler(makeCtx(kind, principal, name), sent) ?? null) as any);
      if (kind === "mutation") {
        db.__commit();
        systemDb.__commit();
      }
      record.writes = db.__writeCount - writesBefore;
      if (memoKey) memo.set(memoKey, result);
      for (const { table, _id } of db._inserted.slice(insertsBefore)) opts.onInsert?.(table, _id);
      for (const job of scheduledInCall) opts.onSchedule?.(job);
      return jsonToConvex(result);
    } catch (error) {
      if (kind === "mutation") {
        db.__rollback();
        systemDb.__rollback();
      }
      throw error;
    } finally {
      globalThis.fetch = realFetch;
      scheduledInCall = [];
      active = null;
    }
  }

  // A due job, in its own slot on the chain so no other call's rollback can
  // undo its state changes. It runs once: a job that is not pending (already
  // run, or canceled) is skipped.
  function runScheduled(job: ScheduledJob): Promise<void> {
    return serialize(job.name, async () => {
      const row = await systemDb.get(job.id);
      if (!row || row.state?.kind !== "pending") return;
      await systemDb.patch(job.id, { state: { kind: "inProgress" } });
      try {
        await invoke(job.name, job.args, { kind: "system" }, "internal");
        await systemDb.patch(job.id, { state: { kind: "success" }, completedTime: opts.now() });
      } catch (error: any) {
        // As in prod, a failed job fails alone; the record in `calls` keeps it.
        await systemDb.patch(job.id, { state: { kind: "failed", error: String(error?.message ?? error) }, completedTime: opts.now() });
      }
    });
  }

  return {
    db,
    clientFor(p: Principal): SimClient {
      return {
        query: (ref, args) => topLevel(nameOf(ref), args, p, "client", "query"),
        mutation: (ref, args) => topLevel(nameOf(ref), args, p, "client", "mutation"),
        action: (ref, args) => topLevel(nameOf(ref), args, p, "client", "action"),
      };
    },
    runInternal: (name, args, p = { kind: "system" }) => topLevel(nameOf(name), args, p, "internal"),
    runScheduled,
    cancelScheduled(id: string) {
      if (opts.debug && inFlight.length) throw new Error(`sim server: cancelScheduled started while ${inFlight[0]} was running`);
      void serialize("cancelScheduled", () => systemDb.patch(id, { state: { kind: "canceled" } }));
    },
    writes: () => db.__writeCount,
    calls,
    actions,
    activeCall: () => active,
  };
}

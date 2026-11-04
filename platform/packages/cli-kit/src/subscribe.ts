import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parseSince } from "./text.js";
import { plural } from "./format.js";
import { stripAnsi } from "./render.js";

// Subscriptions: "wake me when this changes", for a CLI over something an
// agent waits on: a person's messages (imsg, whisk), a browser tab (cast).
//
// An agent that needs an answer or a change subscribes to the thread, the
// contact or the page. The CLI stores a cursor and arms a codecast trigger bound
// to the calling session; the trigger's precheck is the CLI's own
// `subscription check <id>`, which exits 0 once for each batch of incoming
// messages past the cursor and moves the cursor on. A check is one shell
// process and spends no agent session, so only a real reply wakes the agent,
// and the wake arrives in the session that was waiting for it.
//
// The CLI supplies a SubscriptionSource: how to resolve a target and how to
// count incoming messages past a cursor. Everything else lives here, so the
// verbs, the files and the wake prompt read the same in every CLI.

export type Subscription = {
  id: string;
  /** The target as the agent gave it. */
  target: string;
  /** Canonical identity, so one session subscribing twice gets one trigger. */
  key: string;
  label: string;
  /** The command that shows the conversation, named in the wake prompt. */
  read: string;
  /** Source-owned cursor: a message rowid, a sync stamp. */
  cursor: number;
  /** Source-owned state that rides along with the cursor. */
  data: Record<string, unknown>;
  session?: string;
  trigger?: string;
  note?: string;
  every: string;
  created_at: number;
  expires_at: number;
  last_wake_at?: number;
  wakes: number;
  /** Ends after its first wake: a condition met, not a stream of messages. */
  once?: boolean;
};

export type Resolved = Pick<Subscription, "key" | "label" | "read" | "cursor"> & { data?: Record<string, unknown> };

export type SubscriptionSource = {
  /** The binary on PATH the precheck calls: "imsg", "whisk". */
  cli: string;
  /** What arrives, singular: "message", "email". */
  noun: string;
  /** Where subscriptions are kept, one JSON file per CLI. */
  file: string;
  resolve(target: string): Promise<Resolved>;
  /** Incoming messages (not the human's own) past the cursor, and the cursor to keep. */
  incoming(sub: Subscription): Promise<{ count: number; cursor: number; data?: Record<string, unknown> }>;
  /** The wake prompt, when the default's "new message from" wording does not fit what arrives. */
  wakePrompt?(sub: Subscription, until: string): string;
};

export type CastRunner = (args: string[], stdin?: string) => { status: number | null; stdout: string; stderr: string };

const runCast: CastRunner = (args, stdin) => {
  const r = spawnSync("cast", args, { input: stdin, encoding: "utf8" });
  if (r.error) throw new Error(`cast is not available (${r.error.message}); subscriptions wake agents through codecast triggers`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export const DEFAULT_EVERY = "5m";
export const DEFAULT_FOR = "7d";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function readSubscriptions(file: string): Subscription[] {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Subscription[];
  } catch {
    return [];
  }
}

function writeSubscriptions(file: string, subs: Subscription[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(subs, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read, change and write back in one step; the change returns the new list. */
function updateSubscriptions(file: string, change: (subs: Subscription[]) => Subscription[]): void {
  writeSubscriptions(file, change(readSubscriptions(file)));
}

/** "7d", "12h", "2w" from now, or a date. */
export function expiryFrom(text: string, now = Date.now()): number {
  const at = parseSince(text, now);
  if (at === null) throw new Error(`Cannot read "${text}" as a duration (12h, 7d, 2w) or a date`);
  // parseSince answers "how far back"; a duration here reaches forward.
  return at <= now ? 2 * now - at : at;
}

/** The codecast session this process runs in, when it runs in one. */
export function currentSession(env = process.env): string | undefined {
  return env.CODECAST_CONVERSATION_ID || undefined;
}

/** "Oct 26, 7:58 PM": when a subscription stops looking. */
export function untilText(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// The wake prompt
// ---------------------------------------------------------------------------

export function wakePrompt(source: SubscriptionSource, sub: Subscription): string {
  if (source.wakePrompt) return source.wakePrompt(sub, untilText(sub.expires_at));
  return [
    `New ${source.noun} from ${sub.label} (${source.cli} subscription ${sub.id}).`,
    "",
    `1. Read it: \`${sub.read}\``,
    `2. ${sub.note ? `Carry on: ${sub.note}` : "Carry on with the work you were waiting on this reply for."}`,
    `3. When you no longer need to hear from them, end it: \`${source.cli} unsubscribe ${sub.id}\`. Otherwise it wakes you on each new ${source.noun} until ${untilText(sub.expires_at)}.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

export type SubscribeOptions = { every?: string; for?: string; note?: string; session?: string; once?: boolean; now?: number; cast?: CastRunner };

export async function subscribe(
  source: SubscriptionSource,
  target: string,
  opts: SubscribeOptions = {},
): Promise<{ sub: Subscription; existing: boolean }> {
  const cast = opts.cast ?? runCast;
  const now = opts.now ?? Date.now();
  const session = opts.session ?? currentSession();
  const resolved = await resolveOrThrow(source, target);
  const expires_at = expiryFrom(opts.for ?? DEFAULT_FOR, now);

  const same = readSubscriptions(source.file).find((s) => s.key === resolved.key && s.session === session && s.expires_at > now);
  if (same) {
    // Asking again keeps the one trigger; a new note or a longer window wins.
    const sub = { ...same, note: opts.note ?? same.note, expires_at: Math.max(same.expires_at, expires_at) };
    if (sub.note !== same.note && sub.trigger) {
      cast(["trigger", "update", sub.trigger, "--prompt", "-"], wakePrompt(source, sub));
    }
    updateSubscriptions(source.file, (subs) => subs.map((s) => (s.id === sub.id ? sub : s)));
    return { sub, existing: true };
  }

  const sub: Subscription = {
    id: `s-${Math.random().toString(36).slice(2, 7)}`,
    target,
    key: resolved.key,
    label: resolved.label,
    read: resolved.read,
    cursor: resolved.cursor,
    data: resolved.data ?? {},
    session,
    note: opts.note,
    every: opts.every ?? DEFAULT_EVERY,
    created_at: now,
    expires_at,
    wakes: 0,
    ...(opts.once ? { once: true } : {}),
  };
  const args = [
    "trigger", "add", "-",
    "--every", sub.every,
    "--precheck", `${source.cli} subscription check ${sub.id}`,
    "--title", `Wake on ${source.noun}: ${sub.label}`.slice(0, 80),
  ];
  if (session) args.push("--for", session);
  const armed = cast(args, wakePrompt(source, sub));
  const trigger = stripAnsi(armed.stdout).match(/\btr-\d+\b/)?.[0];
  if (armed.status !== 0 || !trigger) {
    throw new Error(`cast trigger add failed: ${(armed.stderr || armed.stdout).trim() || `exit ${armed.status}`}`);
  }
  sub.trigger = trigger;
  updateSubscriptions(source.file, (subs) => [...subs, sub]);
  return { sub, existing: false };
}

/**
 * The trigger's precheck. Exit 0 wakes the session; anything else is a free
 * skip. A finished subscription cancels its own trigger: a cancel lands the
 * trigger in completed, and the daemon's skip record then leaves it there.
 */
export async function check(source: SubscriptionSource, id: string, opts: { now?: number; cast?: CastRunner } = {}): Promise<{ code: number; message: string }> {
  const now = opts.now ?? Date.now();
  const sub = readSubscriptions(source.file).find((s) => s.id === id);
  if (!sub) return { code: 1, message: `no subscription ${id}` };
  const ended = sub.expires_at <= now ? "expired" : sub.once && sub.wakes > 0 ? "woke its session once" : null;
  if (ended) {
    if (sub.trigger) (opts.cast ?? runCast)(["trigger", "cancel", sub.trigger]);
    updateSubscriptions(source.file, (subs) => subs.filter((s) => s.id !== id));
    return { code: 1, message: `${id} ${ended}; trigger ${sub.trigger ?? "(none)"} cancelled` };
  }
  const found = await source.incoming(sub);
  const quiet = found.count === 0;
  updateSubscriptions(source.file, (subs) =>
    subs.map((s) =>
      s.id === id
        ? {
            ...s,
            cursor: found.cursor,
            data: found.data ?? s.data,
            ...(quiet ? {} : { last_wake_at: now, wakes: s.wakes + 1 }),
          }
        : s,
    ),
  );
  return quiet
    ? { code: 1, message: `nothing new from ${sub.label}` }
    : { code: 0, message: `${plural(found.count, `new ${source.noun}`)} from ${sub.label}` };
}

/** End subscriptions by id or by the target they were made with. */
export function unsubscribe(source: SubscriptionSource, which: string[], opts: { cast?: CastRunner } = {}): Subscription[] {
  const cast = opts.cast ?? runCast;
  const wanted = new Set(which);
  const ended = readSubscriptions(source.file).filter((s) => wanted.has(s.id) || wanted.has(s.target));
  for (const sub of ended) if (sub.trigger) cast(["trigger", "cancel", sub.trigger]);
  const gone = new Set(ended.map((s) => s.id));
  updateSubscriptions(source.file, (subs) => subs.filter((s) => !gone.has(s.id)));
  return ended;
}

async function resolveOrThrow(source: SubscriptionSource, target: string): Promise<Resolved> {
  try {
    return await source.resolve(target);
  } catch (error) {
    throw new Error(`Cannot subscribe to "${target}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** The slice of a commander Command these verbs use, so cli-kit needs no commander of its own. */
export interface CommandLike {
  command(nameAndArgs: string): CommandLike;
  description(text: string): CommandLike;
  option(flags: string, description?: string, defaultValue?: string): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

/** `subscribe`, `unsubscribe`, `subscriptions` and the precheck's `subscription check`. */
export function registerSubscriptions(program: CommandLike, source: SubscriptionSource, scope: string): void {
  const { cli, noun } = source;
  program
    .command("subscribe <target>")
    .description(`wake this agent session on each new ${noun} ${scope}`)
    .option("--note <text>", "what to do on a reply; the wake prompt carries it")
    .option("--every <duration>", "how often to look", DEFAULT_EVERY)
    .option("--for <duration>", "stop looking after this long, or at a date", DEFAULT_FOR)
    .option("--json", "print the subscription as JSON")
    .action(async (target: string, opts: { note?: string; every: string; for: string; json?: boolean }) => {
      const { sub, existing } = await subscribe(source, target, opts);
      if (opts.json) return console.log(JSON.stringify(sub, null, 2));
      console.log(`${existing ? "Already subscribed" : "Subscribed"} ${sub.id} to ${sub.label}: ${sub.trigger} looks every ${sub.every} until ${untilText(sub.expires_at)}.`);
      console.log(
        sub.session
          ? `A new ${noun} wakes this session. End it with: ${cli} unsubscribe ${sub.id}`
          : `Not inside a codecast session, so each ${noun} starts a fresh session with only the wake prompt: give it the whole job with --note. End it with: ${cli} unsubscribe ${sub.id}`,
      );
    });

  program
    .command("unsubscribe <ids...>")
    .description("end subscriptions, by id or by the target they were made with")
    .action((ids: string[]) => {
      const ended = unsubscribe(source, ids);
      if (ended.length === 0) throw new Error(`No subscription matches ${ids.join(", ")} (${cli} subscriptions lists them)`);
      for (const sub of ended) console.log(`Ended ${sub.id} (${sub.label}); ${sub.trigger ?? "no trigger"} cancelled.`);
    });

  program
    .command("subscriptions")
    .description(`threads and contacts that wake an agent on a new ${noun}`)
    .option("--json", "full rows")
    .action((opts: { json?: boolean }) => {
      const subs = readSubscriptions(source.file);
      if (opts.json) return console.log(JSON.stringify(subs, null, 2));
      if (subs.length === 0) return console.log(`No subscriptions. ${cli} subscribe <target> makes one.`);
      for (const s of subs) {
        console.log(`${s.id}  ${s.label}  ${s.trigger ?? "-"} every ${s.every}, until ${untilText(s.expires_at)}, ${plural(s.wakes, "wake")}${s.session ? `, session ${s.session.slice(0, 7)}` : ""}`);
      }
    });

  program
    .command("subscription")
    .description("the trigger's side of a subscription")
    .command("check <id>")
    .description(`exit 0 when a new ${noun} arrived since the last check (the trigger's precheck runs this)`)
    .action(async (id: string) => {
      const result = await check(source, id);
      console.log(result.message);
      process.exit(result.code);
    });
}

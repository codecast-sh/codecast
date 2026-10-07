// What every end-to-end script shares: the dev deployment in .env.local,
// pass/fail bookkeeping, and visitors, each on their own live connection,
// who wait on live queries and watch a room the way a browser would.
import { join } from "node:path";
import { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { BuildView, MessageView } from "../../convex/messages";
import { htmlReferences, importSpecifiers, resolveRelative } from "../../convex/builder/draft";
import { runtimeTokenForSecret } from "../../convex/lib/identity";
import { livePath, versionPath } from "../../convex/lib/runPaths";

export const ROOT = join(import.meta.dir, "../..");
const env = await Bun.file(join(ROOT, ".env.local")).text();
export const CLOUD = /^CONVEX_URL=(\S+)/m.exec(env)![1];
export const SITE = CLOUD.replace(/\.convex\.cloud$/, ".convex.site");

const WAIT_MS = 15_000;

// ---- Results ------------------------------------------------------------------

let failures = 0;
export function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
}
export const failed = () => failures;
export const ms = (n: number) => `${Math.round(n)}ms`;
export const secs = (n: number) => `${(n / 1000).toFixed(1)}s`;

/** Exit with the verdict once every check has run. */
export function finish(label: string): never {
  console.log(`\n${label}: ${failures ? `${failures} failed` : "all passed"}`);
  process.exit(failures ? 1 : 0);
}

// ---- Visitors -----------------------------------------------------------------

export type Creds = { visitor_id: string; secret: string };
export type Visitor = Awaited<ReturnType<typeof visitor>>;

/** One person: a fresh identity on their own connection. */
export async function visitor() {
  const client = new ConvexClient(CLOUD);
  const registered = await client.mutation(api.visitors.register, {});
  const creds: Creds = { visitor_id: registered.visitor_id, secret: registered.secret };

  /** Resolve when a live query's answer satisfies `pick`, with how long that
   *  took from the call. Credentials are the caller's to pass, since the
   *  runtime's queries take a token instead. */
  const until = <Q extends FunctionReference<"query">, T>(
    what: string,
    query: Q,
    args: Q["_args"],
    pick: (value: Q["_returnType"]) => T | null | undefined | false,
    timeoutMs = WAIT_MS,
  ) =>
    new Promise<{ value: T; after: number }>((resolve, reject) => {
      const start = performance.now();
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      const stop = client.onUpdate(query, args, (value) => {
        const hit = pick(value);
        if (hit === null || hit === undefined || hit === false) return;
        clearTimeout(timer);
        stop();
        resolve({ value: hit, after: performance.now() - start });
      });
    });

  /** The runtime's credentials for this visitor in one app, as the shell hands them to the SDK. */
  const runtime = async (appId: Id<"apps">) => ({
    visitor_id: creds.visitor_id,
    app_id: appId,
    token: await runtimeTokenForSecret(creds.secret, appId),
  });

  return { client, creds, name: registered.visitor.name, until, runtime, watchRoom: (appId: Id<"apps">) => watchRoom(client, creds, appId) };
}

// ---- Watching a room -------------------------------------------------------------

export type Seen = { at: number; message: MessageView };
export type Room = ReturnType<typeof watchRoom>;

/** Subscribe to a room's stream and keep every state of every message as it
 *  arrived, stamped with performance.now(). */
function watchRoom(client: ConvexClient, creds: Creds, appId: Id<"apps">) {
  const history = new Map<string, Seen[]>();
  let latest: MessageView[] = [];
  const waiters = new Set<() => void>();
  const stop = client.onUpdate(api.messages.list, { ...creds, app_id: appId, paginationOpts: { numItems: 50, cursor: null } }, (page) => {
    const at = performance.now();
    latest = page.page;
    for (const m of page.page) {
      const seen = history.get(m.id) ?? [];
      if (JSON.stringify(seen.at(-1)?.message) !== JSON.stringify(m)) seen.push({ at, message: m });
      history.set(m.id, seen);
    }
    for (const w of waiters) w();
  });

  /** Resolve with the first truthy `pick()` over what the room has seen so far or sees next. */
  function until<T>(what: string, pick: () => T | null | undefined | false, timeoutMs = WAIT_MS): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(test);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      const test = () => {
        const value = pick();
        if (value === null || value === undefined || value === false) return;
        clearTimeout(timer);
        waiters.delete(test);
        resolve(value);
      };
      waiters.add(test);
      test();
    });
  }

  const message = (id: string) => latest.find((m) => m.id === id);
  return { history, until, message, latest: () => latest, stop };
}

// ---- Builds -------------------------------------------------------------------------

export const settled = (b: BuildView | null | undefined) => (b && (b.status === "live" || b.status === "failed") ? b : null);

export type BuildTiming = {
  label: string;
  /** Every distinct status the card showed, in the order the room saw them. */
  states: BuildView["status"][];
  queued: number | null;
  firstStep: number | null;
  total: number;
  updates: number;
  longestQuiet: number;
  build: BuildView;
};

/** Wait for a request's build to settle and read its timeline off what `room`
 *  saw, measured from `sent` (a performance.now() stamp). */
export async function timeBuild(room: Room, label: string, messageId: string, sent: number, timeoutMs: number): Promise<BuildTiming> {
  const build = await room.until(`${label} to finish`, () => settled(room.message(messageId)?.build), timeoutMs);
  const seen = (room.history.get(messageId) ?? []).filter((s) => s.message.build);
  const states = seen.map((s) => s.message.build!.status).filter((s, i, all) => s !== all[i - 1]);
  const building = seen.filter((s) => s.message.build!.status === "building");
  const started = building[0]?.at ?? null;
  const firstStep = building.find((s) => s.message.build!.narration.length > 1)?.at ?? null;
  const done = seen.find((s) => settled(s.message.build))!.at;
  const stamps = [started, ...building.map((s) => s.at), done].filter((t): t is number => t !== null);
  const longestQuiet = Math.max(0, ...stamps.slice(1).map((t, i) => t - stamps[i]));
  return {
    label,
    states,
    queued: started && started - sent,
    firstStep: firstStep && firstStep - sent,
    total: done - sent,
    updates: building.length,
    longestQuiet,
    build,
  };
}

export function reportBuild(t: BuildTiming) {
  const b = t.build;
  console.log(
    `     ${t.label}: ${b.status} v${b.result_version ?? "-"} in ${secs(t.total)} end to end` +
      ` (building after ${t.queued === null ? "-" : secs(t.queued)}, first step ${t.firstStep === null ? "-" : secs(t.firstStep)},` +
      ` ${t.updates} card updates, longest quiet ${secs(t.longestQuiet)}; states ${t.states.join(" > ")})`,
  );
  console.log(`     summary: ${b.summary ?? b.error}`);
  console.log(`     narration: ${b.narration.map((n) => n.text).join(" | ")}`);
  console.log(`     files: ${b.files_touched.map((f) => `${f.how} ${f.path}`).join(", ")}`);
  if (b.error_detail) console.log(`     detail: ${b.error_detail.slice(0, 800)}`);
}

// ---- Serving ---------------------------------------------------------------------------

/** The live link points at version `number`, and its index and every module it reaches load. */
export async function checkServed(slug: string, number: number) {
  const live = await fetch(SITE + livePath(slug), { redirect: "manual" });
  check(`live points at v${number}`, live.headers.get("location") === versionPath(slug, number), live.headers.get("location"));
  const index = await fetch(SITE + versionPath(slug, number));
  const html = await index.text();
  check(`v${number} index.html is served`, index.status === 200 && html.includes("<html"));
  const queue = htmlReferences(html).map((r) => resolveRelative("index.html", r)!);
  const loaded = new Set<string>();
  while (queue.length) {
    const path = queue.shift()!;
    if (loaded.has(path)) continue;
    loaded.add(path);
    const res = await fetch(SITE + versionPath(slug, number, path));
    const body = await res.text();
    check(`v${number} serves ${path}`, res.status === 200, res.status);
    if (/\.(m?js|jsx|tsx?)$/.test(path)) {
      for (const spec of importSpecifiers(body)) if (spec.startsWith(".")) queue.push(resolveRelative(path, spec)!);
    }
  }
}

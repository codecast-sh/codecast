// End-to-end check of the builder against the dev deployment in .env.local,
// with real model calls, timed the way the room sees them (a live
// subscription to the stream):
//
//   1. A makes an app from a prompt; the first build runs and goes live.
//   2. B asks for a change pointing at an element (forced), and right after,
//      A asks for another in Auto mode, which triage must take as a change
//      and queue behind B's, based on B's result. B also says hello in Auto,
//      which triage must leave as chat.
//   3. Each new version is served: live redirects to it, and its index and
//      modules load.
//
//   bun scripts/verify-builder.ts   exit 1 on any failure; prints timings
import { join } from "node:path";
import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { BuildView, MessageView } from "../convex/messages";
import { htmlReferences, importSpecifiers, resolveRelative } from "../convex/builder/draft";
import { livePath, versionPath } from "../convex/lib/runPaths";

const ROOT = join(import.meta.dir, "..");
const env = await Bun.file(join(ROOT, ".env.local")).text();
const CLOUD = /^CONVEX_URL=(\S+)/m.exec(env)![1];
const SITE = CLOUD.replace(/\.convex\.cloud$/, ".convex.site");
const BUILD_TIMEOUT_MS = 240_000;

const client = new ConvexClient(CLOUD);
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
}
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// ---- Watching the room ---------------------------------------------------------

type Seen = { at: number; message: MessageView };
/** Every state of every message, as the room's subscription delivered it. */
const history = new Map<string, Seen[]>();
let latest: MessageView[] = [];
const waiters = new Set<() => void>();

function watch(creds: { visitor_id: string; secret: string }, appId: Id<"apps">) {
  return client.onUpdate(api.messages.list, { ...creds, app_id: appId, paginationOpts: { numItems: 50, cursor: null } }, (page) => {
    const at = Date.now();
    latest = page.page;
    for (const m of page.page) {
      const seen = history.get(m.id) ?? [];
      if (JSON.stringify(seen.at(-1)?.message) !== JSON.stringify(m)) seen.push({ at, message: m });
      history.set(m.id, seen);
    }
    for (const w of waiters) w();
  });
}

function until<T>(what: string, pick: () => T | null | undefined, timeoutMs = BUILD_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(test);
      reject(new Error(`timed out waiting for ${what}`));
    }, timeoutMs);
    const test = () => {
      const value = pick();
      if (value == null) return;
      clearTimeout(timer);
      waiters.delete(test);
      resolve(value);
    };
    waiters.add(test);
    test();
  });
}

const message = (id: string) => latest.find((m) => m.id === id);
const settled = (b: BuildView | null | undefined) => (b && (b.status === "live" || b.status === "failed") ? b : null);

type Timing = { label: string; sent: number; started: number | null; firstStep: number | null; done: number; updates: number; maxGapMs: number; build: BuildView };

/** Wait for a request's build to finish and read its timeline off what the room saw. */
async function timeBuild(label: string, messageId: string, sent: number): Promise<Timing> {
  const build = await until(`${label} to finish`, () => settled(message(messageId)?.build));
  const seen = history.get(messageId) ?? [];
  const building = seen.filter((s) => s.message.build?.status === "building");
  const started = building[0]?.at ?? null;
  const firstStep = building.find((s) => s.message.build!.narration.length > 1)?.at ?? null;
  const done = seen.find((s) => settled(s.message.build))!.at;
  const stamps = [started, ...building.map((s) => s.at), done].filter((t): t is number => t !== null);
  const maxGapMs = Math.max(0, ...stamps.slice(1).map((t, i) => t - stamps[i]));
  return { label, sent, started, firstStep, done, updates: building.length, maxGapMs, build };
}

function report(t: Timing) {
  const b = t.build;
  console.log(
    `  ${t.label}: ${b.status} v${b.result_version ?? "-"} in ${secs(t.done - t.sent)} end to end` +
      ` (queued ${t.started ? secs(t.started - t.sent) : "-"}, first step ${t.firstStep ? secs(t.firstStep - t.sent) : "-"},` +
      ` ${t.updates} card updates while building, longest quiet ${secs(t.maxGapMs)})`,
  );
  console.log(`    summary: ${b.summary ?? b.error}`);
  console.log(`    narration: ${b.narration.map((n) => n.text).join(" | ")}`);
  console.log(`    files: ${b.files_touched.map((f) => `${f.how} ${f.path}`).join(", ")}`);
  if (b.error_detail) console.log(`    detail: ${b.error_detail.slice(0, 800)}`);
}

/** A version is served: index.html and every module it reaches load. */
async function checkServed(slug: string, number: number) {
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

// ---- 1. Make an app ---------------------------------------------------------------

const a = await client.mutation(api.visitors.register, {});
const b = await client.mutation(api.visitors.register, {});
const credsA = { visitor_id: a.visitor_id, secret: a.secret };
const credsB = { visitor_id: b.visitor_id, secret: b.secret };

const prompt = "A tea tally for the office: everyone taps a big button each time they drink a cup today, with a running total and the faces of who drank the most.";
const sent1 = Date.now();
const app = await client.mutation(api.apps.create, { ...credsA, prompt });
console.log(`app ${app.slug} at ${SITE}${livePath(app.slug)}`);
const appId = app.app_id as Id<"apps">;
const stop = watch(credsA, appId);
check("creating with a prompt queues its first build", !!app.request_message_id);
const first = await timeBuild("first build", app.request_message_id!, sent1);
report(first);
check("the first build goes live as v2", first.build.status === "live" && first.build.result_version === 2, first.build.error_detail);
if (first.build.status !== "live") {
  console.log("\nthe first build did not go live; stopping here");
  process.exit(1);
}
await checkServed(app.slug, 2);

// ---- 2. Two changes at once, and a hello --------------------------------------------

const sent2 = Date.now();
const change = await client.mutation(api.messages.send, {
  ...credsB,
  app_id: appId,
  mode: "change",
  body: "make this button bigger and tomato red",
  element: { selector: "main button", tag: "button", text: "+1 cup" },
});
const sent3 = Date.now();
const auto = await client.mutation(api.messages.send, {
  ...credsA,
  app_id: appId,
  mode: "auto",
  body: "can you add a reset button that sets today's total back to zero?",
});
const hello = await client.mutation(api.messages.send, { ...credsB, app_id: appId, mode: "auto", body: "haha love this, morning everyone" });
check("a forced change is a request at once", change.kind === "request");
check("an Auto message waits on triage", auto.kind === "chat");

const helloSettled = await until("triage of the hello", () => {
  const m = message(hello.message_id);
  return m && !m.triage_pending ? m : null;
}, 30_000);
check("triage leaves a hello as chat", helloSettled.kind === "chat" && !helloSettled.build, helloSettled.kind);
const autoQueued = await until("triage of the reset request", () => {
  const m = message(auto.message_id);
  return m && !m.triage_pending ? m : null;
}, 30_000);
const triageAt = history.get(auto.message_id)!.find((s) => !s.message.triage_pending)!.at;
console.log(`  triage settled the Auto request in ${secs(triageAt - sent3)}`);
check("triage takes the reset request as a change", autoQueued.kind === "request" && !!autoQueued.build, autoQueued.kind);
const waitedInLine = (history.get(auto.message_id) ?? []).some((s) => s.message.build?.status === "queued" && s.message.build.queue_position === 1);
check("the second change waits in line behind the first", waitedInLine);

const second = await timeBuild("forced change", change.message_id, sent2);
report(second);
const third = await timeBuild("triaged change", auto.message_id, sent3);
report(third);
check("the forced change goes live as v3", second.build.status === "live" && second.build.result_version === 3, second.build.error_detail);
check("the queued change starts from the first one's result", third.build.base_version === 3, third.build.base_version);
check("the triaged change goes live as v4", third.build.status === "live" && third.build.result_version === 4, third.build.error_detail);
check("builds ran one at a time", (third.started ?? 0) >= second.done);
if (third.build.status === "live") await checkServed(app.slug, 4);

const timeline = await client.query(api.versions.list, { ...credsA, app_id: appId });
check(
  "the timeline credits each asker",
  timeline.map((v) => `${v.number}:${v.kind}:${v.author?.id === a.visitor_id ? "A" : "B"}`).join(",") === "1:seed:A,2:build:A,3:build:B,4:build:A",
  timeline.map((v) => [v.number, v.kind, v.summary]),
);

stop();
await client.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);

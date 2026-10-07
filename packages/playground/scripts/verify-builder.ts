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
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { livePath } from "../convex/lib/runPaths";
import { SITE, check, checkServed, finish, reportBuild, secs, timeBuild, visitor } from "./lib/harness";

const BUILD_TIMEOUT_MS = 240_000;

// ---- 1. Make an app ---------------------------------------------------------------

const A = await visitor();
const B = await visitor();
const credsA = A.creds;
const credsB = B.creds;
const client = A.client;

const prompt = "A tea tally for the office: everyone taps a big button each time they drink a cup today, with a running total and the faces of who drank the most.";
const sent1 = performance.now();
const app = await client.mutation(api.apps.create, { ...credsA, prompt });
console.log(`app ${app.slug} at ${SITE}${livePath(app.slug)}`);
const appId = app.app_id as Id<"apps">;
const room = A.watchRoom(appId);
const message = room.message;
check("creating with a prompt queues its first build", !!app.request_message_id);
const first = await timeBuild(room, "first build", app.request_message_id!, sent1, BUILD_TIMEOUT_MS);
reportBuild(first);
check("the first build goes live as v1", first.build.status === "live" && first.build.result_version === 1, first.build.error_detail);
if (first.build.status !== "live") finish("builder (stopped: the first build did not go live)");
await checkServed(app.slug, 1);

// ---- 2. Two changes at once, and a hello --------------------------------------------

const sent2 = performance.now();
const change = await client.mutation(api.messages.send, {
  ...credsB,
  app_id: appId,
  mode: "change",
  body: "make this button bigger and tomato red",
  element: { selector: "main button", tag: "button", text: "+1 cup" },
});
const sent3 = performance.now();
const auto = await client.mutation(api.messages.send, {
  ...credsA,
  app_id: appId,
  mode: "auto",
  body: "can you add a reset button that sets today's total back to zero?",
});
const hello = await client.mutation(api.messages.send, { ...credsB, app_id: appId, mode: "auto", body: "haha love this, morning everyone" });
check("a forced change is a request at once", change.kind === "request");
check("an Auto message waits on triage", auto.kind === "chat");

const helloSettled = await room.until("triage of the hello", () => {
  const m = message(hello.message_id);
  return m && !m.triage_pending ? m : null;
}, 30_000);
check("triage leaves a hello as chat", helloSettled.kind === "chat" && !helloSettled.build, helloSettled.kind);
const autoQueued = await room.until("triage of the reset request", () => {
  const m = message(auto.message_id);
  return m && !m.triage_pending ? m : null;
}, 30_000);
const triageAt = room.history.get(auto.message_id)!.find((s) => !s.message.triage_pending)!.at;
console.log(`  triage settled the Auto request in ${secs(triageAt - sent3)}`);
check("triage takes the reset request as a change", autoQueued.kind === "request" && !!autoQueued.build, autoQueued.kind);
const waitedInLine = (room.history.get(auto.message_id) ?? []).some((s) => s.message.build?.status === "queued" && s.message.build.queue_position === 1);
check("the second change waits in line behind the first", waitedInLine);

const second = await timeBuild(room, "forced change", change.message_id, sent2, BUILD_TIMEOUT_MS);
reportBuild(second);
const third = await timeBuild(room, "triaged change", auto.message_id, sent3, BUILD_TIMEOUT_MS);
reportBuild(third);
check("the forced change goes live as v2", second.build.status === "live" && second.build.result_version === 2, second.build.error_detail);
check("the queued change starts from the first one's result", third.build.base_version === 2, third.build.base_version);
check("the triaged change goes live as v3", third.build.status === "live" && third.build.result_version === 3, third.build.error_detail);
check("builds ran one at a time", sent3 + (third.queued ?? 0) >= sent2 + second.total);
if (third.build.status === "live") await checkServed(app.slug, 3);

const timeline = await client.query(api.versions.list, { ...credsA, app_id: appId });
check(
  "the timeline credits each asker",
  timeline.map((v) => `${v.number}:${v.kind}:${v.author?.id === credsA.visitor_id ? "A" : "B"}`).join(",") === "1:build:A,2:build:B,3:build:A",
  timeline.map((v) => [v.number, v.kind, v.summary]),
);

room.stop();
await Promise.all([A.client.close(), B.client.close()]);
finish("builder");

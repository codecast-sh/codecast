// The whole loop, two people, the real dev deployment (.env.local) and real
// model calls, timed the way the other person sees it:
//
//   1. A makes an app from a prompt; B opens it, sees A here and the first
//      build go live as v1 (the starter under it is v0, never shown).
//   2. A asks for a change; B watches the card go queued > building > live
//      and the new version go live.
//   3. B chats; A sees it.
//   4. The app writes data through the runtime; the other person sees it.
//   5. The timeline lists every version; restoring v1 appends a new one, and
//      a second restore against what is no longer live is refused.
//   6. A restore that lands while a build runs: the build starts again from
//      the restored version instead of undoing it.
//   7. B forks v2: a new app with lineage, v2's files and a copy of the data,
//      announced in the source room.
//
//   bun scripts/e2e.ts   exit 1 on any failure; prints timings
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { check, checkServed, finish, ms, reportBuild, secs, timeBuild, visitor, type Visitor } from "./lib/harness";

/** Two browsers see each other's messages, presence, versions and data within a second (SPEC, quality bar). */
const SEEN_BY_OTHER_MS = 1_000;
/** A first build writes a whole small app; a small change is "live in well under a minute". */
const FIRST_BUILD_MS = 120_000;
const CHANGE_MS = 60_000;
/** The card names what Clay is doing soon after it starts. Between steps its
 *  clock and meter tick in the browser, so a quiet stretch on the server (a
 *  long file streaming) still shows progress every second. */
const FIRST_STEP_MS = 5_000;

const PROMPT = "A shared tally: one big round button anyone can tap to add one, the running total huge in the middle, and who tapped last.";
const CHANGE = "make the background deep navy blue and the button bright yellow";

const A = await visitor();
const B = await visitor();
const timings: Record<string, string> = {};
const within = (label: string, took: number, limit: number) => {
  timings[label] = ms(took);
  check(`${label} within ${ms(limit)} (${ms(took)})`, took <= limit);
};
const at = <T extends { after: number }>(p: Promise<T>) => p.then((r) => ({ ...r, at: performance.now() }));

// ---- 1. A makes an app; B opens it ---------------------------------------------------

const sent1 = performance.now();
const made = await A.client.mutation(api.apps.create, { ...A.creds, prompt: PROMPT });
const appId = made.app_id as Id<"apps">;
console.log(`app ${made.slug} (${appId})`);
check("a prompt queues the first build", !!made.request_message_id);

const roomA = A.watchRoom(appId);
const roomB = B.watchRoom(appId);
const heartbeat = (who: Visitor) => who.client.mutation(api.presence.heartbeat, { ...who.creds, app_id: appId, viewing_version: null });
const seenA = at(B.until("A in the room", api.presence.here, { ...B.creds, app_id: appId }, (here) => here.find((h) => h.visitor.id === A.creds.visitor_id)));
const beat = performance.now();
await Promise.all([heartbeat(A), heartbeat(B)]);
within("B sees A arrive", (await seenA).at - beat, SEEN_BY_OTHER_MS);

const first = await timeBuild(roomB, "first build", made.request_message_id!, sent1, FIRST_BUILD_MS + 30_000);
reportBuild(first);
check("the first build goes live as v1", first.build.status === "live" && first.build.result_version === 1, first.build.error_detail);
if (first.build.status !== "live") finish("e2e (stopped: the first build did not go live)");
within("first build, prompt to live for B", first.total, FIRST_BUILD_MS);
const appB = await B.client.query(api.apps.get, { ...B.creds, slug: made.slug });
check("B's app link is on v1", appB?.live_version === 1 && appB.live?.summary === first.build.summary, appB?.live);
await checkServed(made.slug, 1);
const card = (await B.client.query(api.apps.gallery, { ...B.creds })).apps.find((a) => a.id === appId);
check("the gallery shows it as made by A", card?.latest?.said === "made it" && card.latest.by?.id === A.creds.visitor_id, card?.latest);

// ---- 2. A asks for a change; B watches it land ----------------------------------------------

const liveForB = at(B.until("v2 live for B", api.apps.get, { ...B.creds, slug: made.slug }, (app) => app?.live_version === 2 && app, CHANGE_MS + 30_000));
const sent2 = performance.now();
const change = await A.client.mutation(api.messages.send, { ...A.creds, app_id: appId, mode: "change", body: CHANGE });
check("a forced change is a request", change.kind === "request");
const changed = await timeBuild(roomB, "change", change.message_id, sent2, CHANGE_MS + 30_000);
reportBuild(changed);
check("the change goes live as v2 from v1", changed.build.status === "live" && changed.build.result_version === 2 && changed.build.base_version === 1, changed.build.error_detail);
const order = ["queued", "building", "live"];
check(
  "B saw the card's states in order",
  changed.states.at(-1) === "live" && changed.states.includes("building") && changed.states.every((s, i) => i === 0 || order.indexOf(s) > order.indexOf(changed.states[i - 1])),
  changed.states,
);
check("B saw the card narrate while it built", changed.updates >= 2 && changed.progress.narration.length >= 2, { updates: changed.updates, narration: changed.progress.narration.length });
within("change, request to live for B", changed.total, CHANGE_MS);
for (const b of [first, changed]) within(`${b.label}, building to its first step`, b.firstStep! - b.queued!, FIRST_STEP_MS);
const v2 = await liveForB;
const cardLiveAt = roomB.history.get(change.message_id)!.find((s) => s.message.build?.status === "live")!.at;
within("v2 live for B after its card said live", Math.abs(v2.at - cardLiveAt), SEEN_BY_OTHER_MS);
await checkServed(made.slug, 2);

// ---- 3. B chats; A sees it --------------------------------------------------------------------

const hello = "this is great, tapping it now";
const chatSeen = roomA.until("B's chat for A", () => roomA.latest().find((m) => m.body === hello && m.author?.id === B.creds.visitor_id));
const sent3 = performance.now();
const chat = await B.client.mutation(api.messages.send, { ...B.creds, app_id: appId, mode: "chat", body: hello });
const said = await chatSeen;
within("B's chat seen by A", performance.now() - sent3, SEEN_BY_OTHER_MS);
check("chat stays chat, with no build", chat.kind === "chat" && said.kind === "chat" && !said.build);

// ---- 4. Data through the runtime ----------------------------------------------------------------

const rtA = await A.runtime(appId);
const rtB = await B.runtime(appId);
const tapsSeen = B.until("A's tap for B", api.runtime.list, { ...rtB, collection: "taps" }, (docs) => docs.length > 0 && docs);
const totalSeen = B.until("the total for B", api.runtime.shared, { ...rtB, key: "total" }, (shared) => shared?.value === 1 && shared);
const sent4 = performance.now();
await A.client.mutation(api.runtime.insert, { ...rtA, collection: "taps", value: { n: 1 } });
await A.client.mutation(api.runtime.setShared, { ...rtA, key: "total", value: 1, base_rev: 0 });
const [taps, total] = await Promise.all([tapsSeen, totalSeen]);
within("A's data seen by B", performance.now() - sent4, SEEN_BY_OTHER_MS);
check("B sees A's doc, stamped with A", taps.value[0]?.n === 1 && taps.value[0]._by?.id === A.creds.visitor_id, taps.value);
check("B sees the shared total, set by A", total.value.by?.id === A.creds.visitor_id, total.value);

// ---- 5. Timeline and restore ----------------------------------------------------------------------

const timeline = await B.client.query(api.versions.list, { ...B.creds, app_id: appId });
check(
  "the timeline lists the v1 and v2 builds, both asked by A, and not the starter",
  timeline.map((v) => `${v.number}:${v.kind}:${v.author?.id === A.creds.visitor_id ? "A" : "?"}`).join() === "1:build:A,2:build:A",
  timeline.map((v) => [v.number, v.kind, v.summary]),
);
check("each build version carries its summary and request", timeline.every((v) => v.summary.length > 0 && !!v.request_message_id));

// Viewing v1 is looking only: it shows the data everyone shares and writes none of it.
const past = await B.runtime(appId, 1, "watch");
const pastTaps = await B.client.query(api.runtime.list, { ...past, collection: "taps" });
const pastWrite = await B.client.mutation(api.runtime.insert, { ...past, collection: "taps", value: { n: 9 } }).then(() => "wrote", (e) => e.data?.message ?? String(e));
check("a past version reads the shared data", pastTaps.length === taps.value.length, pastTaps);
check("a past version cannot write it", /Looking only/.test(pastWrite), pastWrite);

const restoredForB = at(B.until("v3 live for B", api.apps.get, { ...B.creds, slug: made.slug }, (app) => app?.live_version === 3 && app));
const restoreNote = roomB.until("the restore note for B", () => roomB.latest().find((m) => m.note?.type === "restore"));
const sent5 = performance.now();
const restored = await A.client.mutation(api.versions.restore, { ...A.creds, app_id: appId, number: 1, expected_live: 2 });
const [, note] = await Promise.all([restoredForB, restoreNote]);
within("restore live for B", performance.now() - sent5, SEEN_BY_OTHER_MS);
check("restoring v1 appends v3", restored.number === 3, restored);
check("the room says who restored what", note.note?.type === "restore" && note.note.from_version === 1 && note.note.version === 3 && note.note.by?.id === A.creds.visitor_id, note.note);
const [f1, f3] = await Promise.all([1, 3].map((number) => B.client.query(api.versions.files, { ...B.creds, app_id: appId, number })));
check("v3 holds v1's files", !!f1 && f1.files_hash === f3?.files_hash);
const v3 = await B.client.query(api.versions.get, { ...B.creds, app_id: appId, number: 3 });
check("v3 is a restore of v1, after v2", v3?.kind === "restore" && v3.source?.version === 1 && v3.parent_number === 2, v3);
await checkServed(made.slug, 3);
const again = await B.client.mutation(api.versions.restore, { ...B.creds, app_id: appId, number: 1, expected_live: 2 }).then(() => "restored", (e) => e.data?.message ?? String(e));
check("a restore chosen against an old live version is refused", /changed/.test(again), again);
check("so nothing was appended", (await B.client.query(api.apps.get, { ...B.creds, slug: made.slug }))?.version_count === 3);

// ---- 6. A restore while a build runs ----------------------------------------------------------------

const sent6b = performance.now();
const late = await A.client.mutation(api.messages.send, { ...A.creds, app_id: appId, mode: "change", body: "make the button label say Tap" });
await roomB.until("the late change building", () => roomB.message(late.message_id)?.build?.status === "building");
await B.client.mutation(api.versions.restore, { ...B.creds, app_id: appId, number: 2, expected_live: 3 });
const restarted = await timeBuild(roomB, "change over a restore", late.message_id, sent6b, 2 * CHANGE_MS + 30_000);
reportBuild(restarted);
const lateStates = (roomB.history.get(late.message_id) ?? []).map((s) => s.message.build?.status);
check("the build started again rather than undo the restore", lateStates.lastIndexOf("queued") > lateStates.indexOf("building"), lateStates);
check("and went live on top of the restored v4, as v5", restarted.build.status === "live" && restarted.build.base_version === 4 && restarted.build.result_version === 5, restarted.build);
const v5 = await B.client.query(api.versions.get, { ...B.creds, app_id: appId, number: 5 });
check("v5's parent is the restore", v5?.parent_number === 4, v5);

// ---- 7. B forks v2 ------------------------------------------------------------------------------------

const forkNote = roomA.until("the fork note for A", () => roomA.latest().find((m) => m.note?.type === "fork"));
const forkMarker = A.until("the fork marker on v2", api.versions.list, { ...A.creds, app_id: appId }, (tl) => tl.find((v) => v.number === 2 && v.forks.length === 1));
const sent6 = performance.now();
const fork = await B.client.mutation(api.apps.fork, { ...B.creds, app_id: appId, number: 2, name: "Tally, take two" });
const forkId = fork.app_id;
const [noteA] = await Promise.all([forkNote, forkMarker]);
within("fork note seen by A", performance.now() - sent6, SEEN_BY_OTHER_MS);
check(
  "the source room names the fork",
  noteA.note?.type === "fork" && noteA.note.version === 2 && noteA.note.fork?.slug === fork.slug && noteA.note.by?.id === B.creds.visitor_id,
  noteA.note,
);
const forked = await A.client.query(api.apps.get, { ...A.creds, slug: fork.slug });
check("the fork links back to the source's v2", forked?.forked_from?.app_id === appId && forked.forked_from.version === 2 && forked.forked_from.slug === made.slug, forked?.forked_from);
check("the fork is its own app at v1", forked?.id === forkId && forked.live_version === 1 && forked.name === "Tally, take two", forked);
const [src2, fork1] = await Promise.all([
  A.client.query(api.versions.files, { ...A.creds, app_id: appId, number: 2 }),
  A.client.query(api.versions.files, { ...A.creds, app_id: forkId, number: 1 }),
]);
check("the fork's v1 holds v2's files", !!src2 && src2.files_hash === fork1?.files_hash);
const forkTimeline = await A.client.query(api.versions.list, { ...A.creds, app_id: forkId });
check("the fork's v1 is a fork of v2", forkTimeline.length === 1 && forkTimeline[0].kind === "fork" && forkTimeline[0].source?.version === 2, forkTimeline);
const rtForkA = await A.runtime(forkId);
const copied = await A.until("the copied data", api.runtime.list, { ...rtForkA, collection: "taps" }, (docs) => docs.length > 0 && docs);
const copiedTotal = await A.client.query(api.runtime.shared, { ...rtForkA, key: "total" });
check("the fork has a copy of the data", copied.value[0]?.n === 1 && copiedTotal?.value === 1, { taps: copied.value, total: copiedTotal });
timings["fork data copied"] = ms(copied.after);
const forkRoom = await A.client.query(api.messages.list, { ...A.creds, app_id: forkId, paginationOpts: { numItems: 10, cursor: null } });
check("the fork's room starts empty", forkRoom.page.length === 0, forkRoom.page.map((m) => m.body));
await A.client.mutation(api.runtime.insert, { ...rtForkA, collection: "taps", value: { n: 2 } });
const sourceTaps = await A.client.query(api.runtime.list, { ...rtA, collection: "taps" });
check("the fork's data is its own", sourceTaps.length === 1, sourceTaps);
await checkServed(fork.slug, 1);

// ---- Done ----------------------------------------------------------------------------------------------

roomA.stop();
roomB.stop();
console.log(`\ntimings: ${Object.entries(timings).map(([k, v]) => `${k} ${v}`).join("; ")}`);
console.log(`builds: first ${secs(first.total)}, change ${secs(changed.total)}`);
console.log(`app ${made.slug}, fork ${fork.slug}`);
await Promise.all([A.client.close(), B.client.close()]);
finish("e2e");

// End-to-end check of the timeline against the dev deployment in .env.local,
// with two visitors on their own live connections, timed the way the other
// person sees it:
//
//   1. A makes an app and it gets three more versions. They are committed
//      through the builder's own commit (versions:append), so this runs
//      without model calls; verify-builder.ts covers real builds.
//   2. A writes app data through the runtime, as the app would.
//   3. A restores v2: B sees v5 go live with v2's files, a restore bead and
//      the room's restore note, and the live link serves v5.
//   4. B forks v3: A sees the fork note in the source room and a fork marker
//      on v3; the fork's v1 holds v3's files, its data is a copy, and it
//      links back to the source.
//
//   bun scripts/verify-timeline.ts   exit 1 on any failure; prints timings
import type { Id } from "../convex/_generated/dataModel";
import { api } from "../convex/_generated/api";
import { livePath, versionPath } from "../convex/lib/runPaths";
import { ROOT, SITE, check, finish, ms, visitor, type Creds } from "./lib/harness";

/** Commit a version the way a finished build does. */
async function commit(appId: Id<"apps">, author: string, summary: string, files: { path: string; text: string }[]) {
  const args = JSON.stringify({ app_id: appId, kind: "build", summary, author_id: author, files });
  const proc = Bun.spawn(["npx", "convex", "run", "versions:append", args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

const A = await visitor();
const B = await visitor();
const room = (who: Creds, id: Id<"apps">) => ({ ...who, app_id: id, paginationOpts: { numItems: 50, cursor: null } });

// 1. An app with four versions, each a different color.
const made = await A.client.mutation(api.apps.create, { ...A.creds, name: "Timeline check" });
const appId = made.app_id as Id<"apps">;
const colors = ["#ff5b3a", "#3b7bff", "#2fd6a0"];
for (const [i, color] of colors.entries()) {
  const base = (await A.client.query(api.versions.files, { ...A.creds, app_id: appId, number: i + 1 }))!;
  const files = base.files.map((f) => ({
    path: f.path,
    text: f.path === "src/styles.css" ? `${f.text}\nbody { background: ${color}; }\n` : f.text!,
  }));
  await commit(appId, (i % 2 ? B : A).creds.visitor_id, `Paints the page ${color}`, files);
}
const timeline = await A.client.query(api.versions.list, { ...A.creds, app_id: appId });
check("the app has four versions", timeline.map((v) => v.number).join() === "1,2,3,4", timeline.map((v) => v.number));

// 2. Data the app wrote, so the fork has something to copy.
const runtime = await A.runtime(appId);
await A.client.mutation(api.runtime.insert, { ...runtime, collection: "moons", value: { name: "Io" } });
await A.client.mutation(api.runtime.setShared, { ...runtime, key: "count", value: 7 });

// 3. A restores v2; B is watching.
const seenLive = B.until("v5 live", api.apps.get, { ...B.creds, slug: made.slug }, (app) => app?.live_version === 5 && app);
const seenNote = B.until("the restore note", api.messages.list, room(B.creds, appId), (page) =>
  page.page.find((m) => m.note?.type === "restore"),
);
const t0 = performance.now();
const restored = await A.client.mutation(api.versions.restore, { ...A.creds, app_id: appId, number: 2, expected_live: 4 });
const confirmed = performance.now() - t0;
const [live, note] = await Promise.all([seenLive, seenNote]);
check("restore appends v5", restored.number === 5, restored);
check("B sees the restore note", note.value.note?.type === "restore" && note.value.note.from_version === 2 && note.value.note.by?.id === A.creds.visitor_id, note.value.note);
const [v2, v5] = await Promise.all(
  [2, 5].map((number) => B.client.query(api.versions.files, { ...B.creds, app_id: appId, number })),
);
check("v5 holds v2's files", v2!.files_hash === v5!.files_hash);
const after = await B.client.query(api.versions.list, { ...B.creds, app_id: appId });
check("v5 is a restore of v2", after[4]?.kind === "restore" && after[4]?.source?.version === 2, after[4]);
const liveRes = await fetch(`${SITE}${livePath(made.slug)}`, { redirect: "manual" });
check("the live link serves v5", liveRes.headers.get("location")?.endsWith(versionPath(made.slug, 5)) ?? false, liveRes.headers.get("location"));
console.log(`     restore: confirmed to A in ${ms(confirmed)}, live for B ${ms(live.after)}, note for B ${ms(note.after)}`);

// 4. B forks v3; A is watching the source.
const seenFork = A.until("the fork note", api.messages.list, room(A.creds, appId), (page) => page.page.find((m) => m.note?.type === "fork"));
const seenMarker = A.until("the fork marker", api.versions.list, { ...A.creds, app_id: appId }, (tl) => tl.find((v) => v.number === 3 && v.forks.length === 1));
const t1 = performance.now();
const fork = await B.client.mutation(api.apps.fork, { ...B.creds, app_id: appId, number: 3, name: "Timeline check, take two" });
const forkConfirmed = performance.now() - t1;
const [forkNote, marker] = await Promise.all([seenFork, seenMarker]);
const forkNoteView = forkNote.value.note;
check("A sees the fork note", forkNoteView?.type === "fork" && forkNoteView.fork?.slug === fork.slug && forkNoteView.version === 3, forkNoteView);
check("v3 carries a fork marker", marker.value.forks.length === 1);
const forked = (await B.client.query(api.apps.get, { ...B.creds, slug: fork.slug }))!;
check("the fork links back to v3", forked.forked_from?.app_id === appId && forked.forked_from.version === 3, forked.forked_from);
const [v3, f1] = await Promise.all([
  B.client.query(api.versions.files, { ...B.creds, app_id: appId, number: 3 }),
  B.client.query(api.versions.files, { ...B.creds, app_id: fork.app_id, number: 1 }),
]);
check("the fork's v1 holds v3's files", v3!.files_hash === f1!.files_hash);
const forkRuntime = await B.runtime(fork.app_id);
const moons = await B.until("the copied data", api.runtime.list, { ...forkRuntime, collection: "moons" }, (docs) => docs.length > 0 && docs);
const count = await B.client.query(api.runtime.shared, { ...forkRuntime, key: "count" });
check("the fork has a copy of the data", moons.value[0]?.name === "Io" && count?.value === 7, { moons: moons.value, count });
console.log(`     fork: confirmed to B in ${ms(forkConfirmed)}, note for A ${ms(forkNote.after)}, data copied within ${ms(moons.after)}`);

const unfurl = await fetch(`${SITE}/og/${fork.slug}`);
const html = await unfurl.text();
check("the fork's link preview names it", unfurl.ok && html.includes('content="Timeline check, take two"'), html.slice(0, 300));

await Promise.all([A.client.close(), B.client.close()]);
finish(`${made.slug} and ${fork.slug}`);

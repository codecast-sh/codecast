// The recording backend driven end to end through convex-test, against a fake
// LiveKit (Twirp over fetch) and a fake R2 (presigned DELETE, HEAD and list).
// What it pins: who may press, stop, read and delete; that a press in a room
// with no call record makes one; the exact egress requests (private bucket,
// the row's key, a screen at its own size, a live frame); how LiveKit's
// answers land on the rows; that the room is told every time recording
// starts or stops, whoever or whatever stopped it; that nothing LiveKit films
// goes untracked (a late answer, a lost answer, an egress with no row); and
// that the files a reader gets line up with the transcript's clock.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { CALL_RECORDING_STATUSES, CALL_RECORDING_URL_WINDOW_MS, callRecordingUrlWindow, dmRoomKey, guestIdentity, isRecordingFilming, locateCallMoment, recordingStoppedItselfWords } from "@codecast/shared/contracts";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { sha256Hex } from "./lib/hash";
import { mayWatchLive, ORPHAN_OBJECT_GRACE_MS, orphanedRecordingObjects, walkAccountedRecordingObjects, roomRecordingEnd, sharedCallVideoKey, signForCli, signingMoment, SIGNING_LEAD_MS, startFailure } from "./callRecordings";
import { LivekitApiError } from "./lib/livekitServer";
import { stableSigningWindow } from "./lib/r2";
import { claimShareToken } from "./publicShare";
import { roomNotice } from "./callGuests";
import { EGRESS_BEGIN_TIMEOUT_MS, EGRESS_FINISHING_SAVE_TIMEOUT_MS, EGRESS_SAVE_TIMEOUT_MS, EGRESS_UNREACHABLE_FAIL_MS, filmedSpan, restampRunShare, roomRecordingState } from "./lib/callRecordingRuns";

// The first test pays for loading the calls module graph.
setDefaultTimeout(60_000);

const api = anyApi as any;
const internal = anyApi as any;
const TOKEN = "r".repeat(64);
const GUEST_SECRET = "s".repeat(32);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./callRecordings.ts": () => import("./callRecordings"),
  "./calls.ts": () => import("./calls"),
  "./callGuests.ts": () => import("./callGuests"),
  "./transcripts.ts": () => import("./transcripts"),
  "./callChat.ts": () => import("./callChat"),
  "./publicShare.ts": () => import("./publicShare"),
  "./dispatch.ts": () => import("./dispatch"),
  "./teamFeatures.ts": () => import("./teamFeatures"),
};

const ENV: Record<string, string> = {
  LIVEKIT_URL: "wss://lk.test",
  LIVEKIT_API_KEY: "APIk",
  LIVEKIT_API_SECRET: "secret",
  R2_ENDPOINT: "https://acct.r2.test",
  CALL_REC_R2_BUCKET: "codecast-call-recordings",
  CALL_REC_R2_ACCESS_KEY_ID: "rec-key",
  CALL_REC_R2_SECRET_ACCESS_KEY: "rec-secret",
  CONVEX_SITE_URL: "https://site.test",
};
const saved: Record<string, string | undefined> = {};

// ── A fake LiveKit and a fake bucket ──────────────────────────────────────

type FakeEgress = { egress_id: string; room_name: string; status: string; kind: "room" | "track"; request: any; file_results: any[]; error?: string };
const NS = (ms: number) => String(ms * 1e6);
const RUNNING = ["EGRESS_STARTING", "EGRESS_ACTIVE", "EGRESS_ENDING"];

function fakeWorld() {
  const egresses = new Map<string, FakeEgress>();
  const calls: Array<{ method: string; body: any }> = [];
  const deletes: string[] = [];
  // What is in the bucket: key to size, and when each was written (a key
  // with no time reads as written long ago).
  const objects = new Map<string, number>();
  const modified = new Map<string, number>();
  let participants: any[] = [];
  let n = 0;
  // The start request reaches LiveKit, which starts the egress, but its
  // answer never comes back (a timeout, a dropped connection).
  let loseStartAnswers = false;
  // Refusals LiveKit gives the next starts of each kind, in order: the
  // resource_exhausted text for each (a busy minute, or spent minutes).
  const refusals: Record<"room" | "track", string[]> = { room: [], track: [] };
  const realFetch = globalThis.fetch;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const info = (e: FakeEgress) => ({
    egress_id: e.egress_id,
    room_name: e.room_name,
    status: e.status,
    [e.kind === "room" ? "room_composite" : "track_composite"]: e.request,
    file_results: e.file_results,
    ...(e.error ? { error: e.error } : {}),
  });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith(ENV.R2_ENDPOINT)) {
      const u = new URL(url);
      const key = decodeURIComponent(u.pathname.replace(/^\/codecast-call-recordings\/?/, ""));
      if (init?.method === "DELETE") {
        deletes.push(key);
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (init?.method === "HEAD") {
        const size = objects.get(key);
        return size === undefined ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { "content-length": String(size), "last-modified": new Date(1_790_000_000_000).toUTCString() } });
      }
      if (u.searchParams.get("list-type") === "2") {
        const prefix = u.searchParams.get("prefix") ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
        const at = (k: string) => new Date(modified.get(k) ?? 1_700_000_000_000).toISOString();
        return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key><LastModified>${at(k)}</LastModified></Contents>`).join("")}</ListBucketResult>`, { status: 200 });
      }
      throw new Error(`unexpected R2 request ${init?.method ?? "GET"} ${url}`);
    }
    const m = url.match(/\/twirp\/livekit\.(\w+\/\w+)$/);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(init?.body ?? "{}");
    calls.push({ method: m[1], body });
    switch (m[1]) {
      case "Egress/StartRoomCompositeEgress":
      case "Egress/StartTrackCompositeEgress": {
        const kind = m[1] === "Egress/StartRoomCompositeEgress" ? "room" : "track";
        const refusal = refusals[kind].shift();
        if (refusal !== undefined) return json(429, { code: "resource_exhausted", msg: refusal });
        const e: FakeEgress = { egress_id: `EG_${++n}`, room_name: body.room_name, status: "EGRESS_STARTING", kind, request: body, file_results: [] };
        egresses.set(e.egress_id, e);
        if (loseStartAnswers) throw new TypeError("fetch failed");
        return json(200, info(e));
      }
      case "Egress/StopEgress": {
        const e = egresses.get(body.egress_id);
        if (!e) return json(404, { code: "not_found", msg: "egress not found" });
        if (!["EGRESS_STARTING", "EGRESS_ACTIVE"].includes(e.status)) return json(412, { code: "failed_precondition", msg: "egress not active" });
        e.status = "EGRESS_ENDING";
        return json(200, info(e));
      }
      case "Egress/ListEgress": {
        if (body.egress_id) {
          const e = egresses.get(body.egress_id);
          return e ? json(200, { items: [info(e)] }) : json(404, { code: "not_found", msg: "egress not found" });
        }
        const items = [...egresses.values()].filter((e) => (!body.room_name || e.room_name === body.room_name) && (!body.active || RUNNING.includes(e.status)));
        return json(200, { items: items.map(info) });
      }
      case "RoomService/ListParticipants":
        return json(200, { participants });
      default:
        throw new Error(`unexpected LiveKit method ${m[1]}`);
    }
  }) as any;
  return {
    egresses,
    calls,
    deletes,
    objects,
    modified,
    stops: () => calls.filter((c) => c.method === "Egress/StopEgress").map((c) => c.body.egress_id),
    setParticipants: (p: any[]) => (participants = p),
    loseStartAnswers: (on: boolean) => (loseStartAnswers = on),
    refuse: (kind: "room" | "track", ...msgs: string[]) => refusals[kind].push(...msgs),
    starts: (kind: "room" | "track") =>
      calls.filter((c) => c.method === (kind === "room" ? "Egress/StartRoomCompositeEgress" : "Egress/StartTrackCompositeEgress")).length,
    fail(id: string, error: string) {
      const e = egresses.get(id)!;
      e.status = "EGRESS_FAILED";
      e.error = error;
    },
    activate(id: string, filename: string, startedAt: number) {
      const e = egresses.get(id)!;
      e.status = "EGRESS_ACTIVE";
      e.file_results = [{ filename, started_at: NS(startedAt) }];
    },
    complete(id: string, filename: string, startedAt: number, durationMs: number) {
      const e = egresses.get(id)!;
      e.status = "EGRESS_COMPLETE";
      e.file_results = [{ filename, started_at: NS(startedAt), ended_at: NS(startedAt + durationMs), duration: NS(durationMs), size: "123456" }];
      objects.set(filename, 123456);
    },
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

let world: ReturnType<typeof fakeWorld>;
// Every backend a test made. A run's loop keeps its own clock, and fetch is
// global: a loop left alive would look at the NEXT test's fake LiveKit (the
// room keys repeat, since convex-test ids do). So each test's loops retire
// when it ends.
const backends: any[] = [];
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  world = fakeWorld();
});
afterEach(async () => {
  for (const t of backends.splice(0)) {
    // Whatever the test left in flight (a start a last press scheduled)
    // finishes against this test's world, then its loops retire.
    await settle(t);
    await quietLoops(t);
  }
  world.restore();
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ── A team, a room, two people in it, one outsider ────────────────────────

async function seed() {
  const t = convexTest(schema, modules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x", features: { calls: true } } as any);
    const other = await ctx.db.insert("teams", { name: "O", created_at: now, invite_code: "y", features: { calls: true } } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@example.com" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben" } as any);
    const cat = await ctx.db.insert("users", { name: "Cat" } as any);
    for (const u of [ana, ben]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    await ctx.db.insert("team_memberships", { user_id: cat, team_id: other, role: "member", joined_at: now } as any);
    await ctx.db.insert("api_tokens", { user_id: ben, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const room = dmRoomKey(String(ana), String(ben));
    for (const [u, name] of [[ana, "Ana"], [ben, "Ben"]] as const) {
      await ctx.db.insert("call_members", { room_key: room, team_id: team, user_id: u, user_name: name, joined_at: now, last_seen: now, muted: false, camera: false, sharing: false } as any);
    }
    return { team, ana, ben, cat, room };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  return { t, ...ids, as };
}

/** Let what was just scheduled at 0 run (startRun, stopEgresses, deletes). */
async function settle(t: any) {
  await new Promise((r) => setTimeout(r, 30));
  await t.finishInProgressScheduledFunctions();
}

/** Retire every run's own loop, so a test drives each look by hand and a
 *  loop firing on its own clock mid-test cannot race it. */
const quietLoops = (t: any) =>
  t.run(async (ctx: any) => {
    for (const l of await ctx.db.query("call_recording_loops").collect()) await ctx.db.patch(l._id, { gen: -1 });
  });

const rows = (t: any) => t.run(async (ctx: any) => await ctx.db.query("call_recordings").collect());
const eventRows = (t: any) => t.run(async (ctx: any) => (await ctx.db.query("call_chat_messages").collect()).filter((r: any) => r.event));
const events = async (t: any) => (await eventRows(t)).map((r: any) => (r.event_reason ? `${r.event}:${r.event_reason}` : r.event));
const look = (t: any, run_id: string, extra: Record<string, unknown> = {}) => t.action(internal.callRecordings.reconcileRun, { run_id, once: true, ...extra });

/** The room's recording as clients read it: the live room list's row (the
 *  REC flag, the run behind it, whether a press could work), and how the
 *  room's last run ended (the stop notice's own query). */
const liveRoom = async (as: any, who: unknown, room: string) =>
  (await as(String(who)).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room) ?? null;
const roomEnd = (as: any, who: unknown, room: string) => as(String(who)).query(api.callRecordings.getRoomRecordingEnd, { room_key: room });

const screenShare = (who: string, sid = "TR_scr", width = 1920, height = 1080) => ({ identity: who, name: "Ana", tracks: [{ sid, type: "VIDEO", source: "SCREEN_SHARE", width, height }] });

describe("pressing Record", () => {
  test("someone in the huddle starts it; the room has a call record and is told", async () => {
    const { t, ana, ben, room, as } = await seed();
    world.setParticipants([screenShare(String(ana), "TR_scr", 2880, 1800), { identity: "EG_1", kind: "EGRESS", tracks: [] }]);
    const res = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    expect(res.existing).toBe(false);

    // Transcription never ran in this room: the press made the call record,
    // and everyone seated is in its video.
    const call = await t.run(async (ctx: any) => await ctx.db.get(res.transcript_id));
    expect(call).toMatchObject({ room_key: room, status: "live", started_by: ana });
    expect(call.short_id).toMatch(/^cl-\d+$/);
    expect(call.recorded_people.map(String).sort()).toEqual([String(ana), String(ben)].sort());

    // Shown on this round trip, before LiveKit has answered, and the run's
    // loop exists from the press.
    const state = await liveRoom(as, ana, room);
    expect(state).toMatchObject({ recording_configured: true, recording: true, recording_run: { status: "starting", started_by: { id: String(ana), name: "Ana" }, started_at: null } });
    expect(await events(t)).toEqual(["record_on"]);
    const loops = await t.run(async (ctx: any) => await ctx.db.query("call_recording_loops").collect());
    expect(loops).toMatchObject([{ run_id: res.recording_id, gen: 1 }]);

    await settle(t);
    const composite = world.calls.find((c) => c.method === "Egress/StartRoomCompositeEgress")!.body;
    const [row] = (await rows(t)).filter((r: any) => r.kind === "composite");
    expect(composite.room_name).toBe(room);
    expect(composite.file_outputs[0].filepath).toBe(row.r2_key);
    expect(row.r2_key).toBe(`calls/${res.transcript_id}/${row.requested_at}-composite.mp4`);
    // The private bucket, and only it; a live frame beside the file.
    expect(composite.file_outputs[0].s3).toMatchObject({ bucket: "codecast-call-recordings", access_key: "rec-key", force_path_style: true });
    expect(composite.image_outputs[0]).toMatchObject({ filename_prefix: `calls/${res.transcript_id}/${row.requested_at}-composite-live`, filename_suffix: "IMAGE_SUFFIX_NONE_OVERWRITE", capture_interval: 2 });
    expect(row.live_frame_key).toBe(`calls/${res.transcript_id}/${row.requested_at}-composite-live.jpeg`);
    expect(row.egress_id).toBe("EG_1");

    // Ana's share got its own file at her screen's size, and only the file:
    // LiveKit never starts a track composite asked for pictures beside an
    // MP4 (the share's file was lost on two real runs, 2026-10-02).
    // LiveKit's recorder got none.
    const track = world.calls.filter((c) => c.method === "Egress/StartTrackCompositeEgress");
    expect(track).toHaveLength(1);
    expect(track[0].body).toMatchObject({ video_track_id: "TR_scr", advanced: { width: 2880, height: 1800, framerate: 15, key_frame_interval: 1 } });
    expect(track[0].body).not.toHaveProperty("image_outputs");
    const [screen] = (await rows(t)).filter((r: any) => r.kind === "screen");
    expect(screen).toMatchObject({ run_id: row._id, participant_identity: String(ana), participant_name: "Ana", status: "starting", egress_id: "EG_2" });
    expect(screen.live_frame_key).toBeUndefined();
    expect(screen.r2_key).toBe(`calls/${res.transcript_id}/${row.requested_at}-screen-TR_scr.mp4`);

    // A second press, by anyone, is the same recording.
    const again = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    expect(again).toEqual({ recording_id: res.recording_id, transcript_id: res.transcript_id, existing: true });
    expect(await events(t)).toEqual(["record_on"]);
  });

  test("a record the press made has no scribe: the first client that asks writes the words, whoever pressed", async () => {
    const { t, ana, ben, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    // Ana presses on a phone, which never scribes.
    const { transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    const call = await t.run(async (ctx: any) => await ctx.db.get(transcript_id));
    expect(call).toMatchObject({ started_by: ana, scribe_open: true });
    // Nobody is writing yet, so no surface says the room is transcribed.
    expect((await as(String(ben)).query(api.transcripts.getLive, { room_key: room })).started_by).toBeNull();
    // Ben's window joins and asks: Ana's seat is no reason to observe.
    expect(await as(String(ben)).mutation(api.transcripts.start, { room_key: room, auto: true })).toMatchObject({ transcript_id, role: "scribe" });
    const taken = await t.run(async (ctx: any) => await ctx.db.get(transcript_id));
    expect(String(taken.started_by)).toBe(String(ben));
    expect(taken.scribe_open).toBeUndefined();
    expect(String((await as(String(ana)).query(api.transcripts.getLive, { room_key: room })).started_by)).toBe(String(ben));
    // From then on the seat is Ben's like any scribe's.
    expect(await as(String(ana)).mutation(api.transcripts.start, { room_key: room, auto: true })).toMatchObject({ role: "observer" });
  });

  test("nobody outside the huddle can press it, and a missing setup says so", async () => {
    const { t, ana, ben, cat, room, as } = await seed();
    await expect(as(String(cat)).mutation(api.callRecordings.startRecording, { room_key: room })).rejects.toThrow(/Cannot record this room/);
    await t.run(async (ctx: any) => {
      for (const m of await ctx.db.query("call_members").collect()) if (String(m.user_id) === String(ana)) await ctx.db.delete(m._id);
    });
    await expect(as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room })).rejects.toThrow(/Only someone in the huddle/);
    delete process.env.CALL_REC_R2_BUCKET;
    await expect(as(String(ben)).mutation(api.callRecordings.startRecording, { room_key: room })).rejects.toThrow(/not set up/);
    expect(await rows(t)).toEqual([]);
  });

  test("a press is a moment: one that arrives long after it was made is refused, Record and Stop alike", async () => {
    const { t, ana, room, as } = await seed();
    const press = (on: boolean, pressedAt: number) =>
      as(String(ana)).mutation(api.dispatch.dispatch, { action: "setRoomRecording", args: [room, on, pressedAt] });
    // Parked through an outage, or replayed when the tab reloaded.
    await expect(press(true, Date.now() - 5 * 60_000)).rejects.toThrow(/did not reach the server in time/);
    expect(await rows(t)).toEqual([]);
    // Made now: it records.
    await press(true, Date.now());
    expect((await rows(t)).map((r: any) => r.status)).toEqual(["starting"]);
    // A stale Stop does not end a run somebody is making now.
    await expect(press(false, Date.now() - 5 * 60_000)).rejects.toThrow(/was not stopped/);
    expect((await rows(t)).map((r: any) => r.status)).toEqual(["starting"]);
    await press(false, Date.now());
    expect((await rows(t)).every((r: any) => r.status !== "starting" && r.status !== "recording")).toBe(true);
  });

  test("a Stop ends only the run it was pressed on: one landing late leaves a newer run filming", async () => {
    const { t, ana, ben, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const press = (who: unknown, on: boolean, runId?: string) =>
      as(String(who)).mutation(api.dispatch.dispatch, { action: "setRoomRecording", args: [room, on, Date.now(), ...(runId ? [runId] : [])] });
    const first = await press(ana, true);
    await settle(t);
    // Ben's Stop ends run 1; Ana's Stop on run 1 is still in her outbox.
    await press(ben, false, String(first.recording_id));
    // Past the cooldown, Ana presses Record again: run 2.
    await t.run(async (ctx: any) => {
      for (const r of await ctx.db.query("call_recordings").collect()) await ctx.db.patch(r._id, { stop_requested_at: Date.now() - 60_000 });
    });
    const second = await press(ana, true);
    expect(second.existing).toBe(false);
    // Ana's retried Stop lands: run 1 is over, so it ends nothing.
    expect(await press(ana, false, String(first.recording_id))).toEqual({ stopped: 0 });
    expect((await rows(t)).find((r: any) => r._id === second.recording_id).status).toBe("starting");
    expect((await events(t)).filter((e: string) => e.startsWith("record_off"))).toHaveLength(1);
    // A press on run 2 ends it.
    expect((await press(ben, false, String(second.recording_id))).stopped).toBeGreaterThan(0);
  });

  test("a press right after a stop waits for the file to save", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    await expect(as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room })).rejects.toThrow(/still saving/);
    // A moment after the stop it is a new run, however recently LiveKit's
    // side wrote to the row (its upload can take minutes): the wait counts
    // from the stop, not from the row's last write.
    await t.run(async (ctx: any) => {
      for (const r of await ctx.db.query("call_recordings").collect()) await ctx.db.patch(r._id, { stop_requested_at: Date.now() - 10_000, updated_at: Date.now() });
    });
    expect((await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room })).existing).toBe(false);
  });
});

describe("a session huddle with transcription off", () => {
  // Record films the room; it never feeds the session's agent. The room's own
  // route (which seats the agent, mirrors its replies and dispatches its face)
  // is owed until transcription comes back on, and only then given.
  async function sessionRoomOff() {
    const ctx = await seed();
    const sroom = await ctx.t.run(async (db: any) => {
      const conv = await db.db.insert("conversations", { user_id: ctx.ana, team_id: ctx.team, title: "Fix the auth race", agent_type: "claude_code", started_at: Date.now() } as any);
      const key = `session:${conv}`;
      const now = Date.now();
      await db.db.insert("call_members", { room_key: key, team_id: ctx.team, user_id: ctx.ana, user_name: "Ana", joined_at: now, last_seen: now, muted: false, camera: false, sharing: false } as any);
      return key;
    });
    await ctx.as(String(ctx.ana)).mutation(api.calls.setRoomTranscribeOff, { room_key: sroom, off: true });
    return { ...ctx, sroom };
  }
  const feeds = (t: any) => t.run(async (ctx: any) => await ctx.db.query("call_agent_feeds").collect());

  test("pressing Record makes the record without summoning the agent", async () => {
    const { t, ana, as, sroom } = await sessionRoomOff();
    const { transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: sroom });
    const call = await t.run(async (ctx: any) => await ctx.db.get(transcript_id));
    expect(call.routes).toEqual([]);
    expect(call.own_route_owed).toBe(true);
    expect(await feeds(t)).toEqual([]);
    expect(await events(t)).not.toContain("agent_joined");
  });

  test("transcription back on pays the owed route, once", async () => {
    const { t, ana, as, sroom } = await sessionRoomOff();
    const { transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: sroom });
    await as(String(ana)).mutation(api.calls.setRoomTranscribeOff, { room_key: sroom, off: false });
    const call = await t.run(async (ctx: any) => await ctx.db.get(transcript_id));
    const conv = sroom.slice("session:".length);
    expect(call.routes).toMatchObject([{ kind: "session", target: conv, mode: "live", added_by: ana }]);
    expect(call.own_route_owed).toBeUndefined();
    expect((await feeds(t)).map((f: any) => String(f.conversation_id))).toEqual([conv]);
    expect(await events(t)).toContain("agent_joined");

    // Removed on purpose afterwards, it stays removed through another
    // off and on: only an owed route is ever given.
    await t.run(async (ctx: any) => await ctx.db.patch(transcript_id, { routes: [] }));
    await as(String(ana)).mutation(api.calls.setRoomTranscribeOff, { room_key: sroom, off: true });
    await as(String(ana)).mutation(api.calls.setRoomTranscribeOff, { room_key: sroom, off: false });
    await as(String(ana)).mutation(api.transcripts.start, { room_key: sroom });
    expect((await t.run(async (ctx: any) => await ctx.db.get(transcript_id))).routes).toEqual([]);
  });
});

describe("a run, start to finish", () => {
  test("LiveKit's file times land, anyone stops it, the finished files line up with the transcript", async () => {
    const { t, ana, ben, cat, room, as } = await seed();
    world.setParticipants([screenShare(String(ana))]);
    const { recording_id, transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const call = await t.run(async (ctx: any) => await ctx.db.get(transcript_id));
    const all0 = await rows(t);
    const comp0 = all0.find((r: any) => r.kind === "composite");
    const scr0 = all0.find((r: any) => r.kind === "screen");

    // LiveKit begins writing: the composite's first frame 5s after the call
    // record began, the screen's 8s after.
    const c0 = call.started_at + 5_000;
    const s0 = call.started_at + 8_000;
    world.activate("EG_1", comp0.r2_key, c0);
    world.activate("EG_2", scr0.r2_key, s0);
    await look(t, recording_id);
    expect((await liveRoom(as, ben, room)).recording_run).toMatchObject({ status: "recording", started_at: c0, call_short_id: call.short_id });
    // The live state never reads the call record nor the presser's users
    // row: writeSegments moves the record on every transcript line, the
    // daemon's heartbeat and every message the presser sends move their
    // users row, and the live room list (every teammate's window) and each
    // guest's notice carry this state. The run keeps the presser's name.
    const state = await t.run(async (ctx: any) => {
      const db = ctx.db;
      const guarded = {
        ...ctx,
        db: {
          query: (table: string) => db.query(table),
          normalizeId: (table: string, id: string) => db.normalizeId(table, id),
          get: async (id: any) => {
            if (db.normalizeId("transcripts", String(id))) throw new Error("roomRecordingState read the call record");
            if (db.normalizeId("users", String(id))) throw new Error("roomRecordingState read the presser's users row");
            return await db.get(id);
          },
        },
      };
      return await roomRecordingState(guarded, room);
    });
    expect(state).toMatchObject({ status: "recording", call_short_id: call.short_id, video_shared: false, started_by: { name: "Ana" } });
    // The screen file kept its run's presser too.
    expect((await rows(t)).every((r: any) => r.started_by_name === "Ana")).toBe(true);
    // The presser's users row moving (a heartbeat) moves nothing the live list returns.
    const listedBefore = (await as(String(ben)).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room);
    await t.run(async (ctx: any) => await ctx.db.patch(ana, { daemon_last_seen: Date.now() }));
    expect((await as(String(ben)).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room)).toEqual(listedBefore);
    // A row from before runs kept the name still names the presser.
    const legacy = await t.run(async (ctx: any) => {
      const { runStarterName } = await import("./lib/callRecordingRuns");
      return await runStarterName(ctx, { started_by: ana, started_by_name: undefined });
    });
    expect(legacy).toBe("Ana");
    // A transcript line moves the record and nothing the live list returns.
    const before = (await as(String(ben)).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room);
    await t.run(async (ctx: any) => await ctx.db.patch(transcript_id, { last_seq: (call.last_seq ?? 0) + 5 }));
    expect((await as(String(ben)).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room)).toEqual(before);
    // The live room list carries the same run (the client's one feed for the
    // room's recording): the flag, who pressed, the clock's time 0, and that
    // a press can work here.
    const listed0 = (await as(String(ben)).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room);
    expect(listed0).toMatchObject({
      recording: true,
      recording_configured: true,
      recording_run: { status: "recording", run_id: recording_id, started_at: c0, started_by: { id: String(ana), name: "Ana" } },
    });

    // While it records, the CLI gets the room's live frame, never a file URL
    // (nothing is in the bucket yet). The screen file has no live frame.
    const during = await signForCli(await t.query(internal.callRecordings.cliCallRecordings, { api_token: TOKEN, call: call.short_id }));
    expect(during.recordings.map((r: any) => [r.kind, r.url, r.live_frame_url && new URL(r.live_frame_url).pathname])).toEqual([
      ["composite", null, `/codecast-call-recordings/${comp0.live_frame_key}`],
      ["screen", null, null],
    ]);
    expect(during.live_frame_interval_ms).toBe(2000);
    expect(during.recordings.some((r: any) => "r2_key" in r || "live_frame_key" in r)).toBe(false);
    expect(during.live_watch).toBe(true);
    // `cast calls` marks the call as being filmed.
    const listed = (await t.query(api.transcripts.cliListCalls, { api_token: TOKEN })).find((r: any) => r._id === transcript_id);
    expect(listed.video).toBe("recording");

    // Ben, who did not press it, stops it; the room is told it was pressed.
    expect(await as(String(ben)).mutation(api.callRecordings.stopRecording, { room_key: room })).toEqual({ stopped: 2 });
    const stopping = await rows(t);
    expect(stopping.map((r: any) => [r.kind, r.status, r.stop_reason, r.stopped_by])).toEqual([
      ["composite", "stopping", "pressed", String(ben)],
      ["screen", "stopping", "pressed", String(ben)],
    ]);
    expect(await events(t)).toEqual(["record_on", "record_off:pressed"]);
    expect(String((await eventRows(t))[1].user_id)).toBe(String(ben));
    // Stopped and saving: the room is no longer being filmed (the flag), and
    // the run says so, which is what keeps every mark off REC meanwhile.
    const listed1 = (await as(String(ana)).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room);
    expect([listed1.recording, listed1.recording_run.status]).toEqual([false, "stopping"]);
    // How it ended, for the room's notice: still being finished, stopped by Ben.
    // Where the video went rides along: the call, its short id, and where in
    // the call the file begins (its first frame 5s in).
    const endFacts = {
      run_id: recording_id,
      status: "stopping",
      stop_reason: "pressed",
      error: null,
      stopped_by: { id: String(ben), name: "Ben" },
      transcript_id: String(transcript_id),
      short_id: call.short_id,
      at_ms: 5_000,
      started_by: String(ana),
      lost: false,
    };
    // The notice's own query answers the end and nothing else.
    expect(await roomEnd(as, ana, room)).toEqual(endFacts);
    expect(await as(String(cat)).query(api.callRecordings.getRoomRecordingEnd, { room_key: room })).toBeNull();
    await settle(t);
    expect(world.stops().sort()).toEqual(["EG_1", "EG_2"]);

    // LiveKit finishes and uploads; the live frames go with the live call.
    world.complete("EG_1", comp0.r2_key, c0, 120_000);
    world.complete("EG_2", scr0.r2_key, s0, 40_000);
    await look(t, recording_id);
    await settle(t);
    expect((await liveRoom(as, ana, room)).recording_run).toBeNull();
    expect(await roomEnd(as, ana, room)).toMatchObject({ run_id: recording_id, status: "ready", stop_reason: "pressed" });
    expect(world.deletes).toEqual([comp0.live_frame_key]);
    expect((await rows(t)).every((r: any) => r.live_frame_key === undefined)).toBe(true);
    // Stopped by a press: told once, not again when the file lands.
    expect(await events(t)).toEqual(["record_on", "record_off:pressed"]);

    const win = callRecordingUrlWindow();
    const read = await as(String(ana)).query(api.callRecordings.webCallRecordings, { call: call.short_id, url_window: win });
    expect(read.call_started_at).toBe(call.started_at);
    expect(read.recordings.map((r: any) => [r.kind, r.status, r.started_at, r.duration_ms, r.size_bytes, r.stop_reason])).toEqual([
      ["composite", "ready", c0, 120_000, 123456, "pressed"],
      ["screen", "ready", s0, 40_000, 123456, "pressed"],
    ]);
    for (const r of read.recordings) {
      const u = new URL(r.url);
      expect(u.origin).toBe(ENV.R2_ENDPOINT);
      expect(u.pathname).toBe(`/codecast-call-recordings/${r.kind === "composite" ? comp0.r2_key : scr0.r2_key}`);
      expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      expect(r.url_expires_at).toBeGreaterThan(Date.now());
    }
    // The URL is a function of the window asked for, nothing else: the same
    // on every read inside it, new in the next.
    const again = await as(String(ana)).query(api.callRecordings.webCallRecordings, { call: String(transcript_id), url_window: win });
    expect(again.recordings.map((r: any) => r.url)).toEqual(read.recordings.map((r: any) => r.url));
    const prev = await as(String(ana)).query(api.callRecordings.webCallRecordings, { call: String(transcript_id), url_window: win - 1 });
    expect(prev.recordings[0].url).not.toBe(read.recordings[0].url);

    // The transcript's clock lands on the files: a line 20s into the call is
    // 15s into the room's video, 12s into Ana's screen.
    const spans = read.recordings.map((r: any) => ({ ...r, id: r._id }));
    expect(locateCallMoment({ callStartedAt: read.call_started_at, atMs: 20_000, recordings: spans })).toMatchObject({ ok: true, recording: { kind: "composite" }, offsetMs: 15_000 });
    expect(locateCallMoment({ callStartedAt: read.call_started_at, atMs: 20_000, recordings: spans, prefer: "screen" })).toMatchObject({ ok: true, recording: { kind: "screen" }, offsetMs: 12_000 });

    // The CLI reads the same files through its token, signed at request
    // time for ten minutes; an outsider reads nothing.
    const cli = await signForCli(await t.query(internal.callRecordings.cliCallRecordings, { api_token: TOKEN, call: call.short_id }));
    expect(cli.recordings.map((r: any) => new URL(r.url).pathname)).toEqual(read.recordings.map((r: any) => new URL(r.url).pathname));
    expect(cli.recordings.every((r: any) => new URL(r.url).searchParams.get("X-Amz-Expires") === "600" && r.live_frame_url === null)).toBe(true);
    expect(Math.abs(cli.server_now - Date.now())).toBeLessThan(5_000);
    // The query's own answer carries keys and no URL, so a cached copy of it
    // (an ended call's rows never change again) cannot hand the CLI a link
    // that lapsed: the route signs on its own clock, two windows later too.
    const cached = await t.query(internal.callRecordings.cliCallRecordings, { api_token: TOKEN, call: call.short_id });
    expect(cached.recordings.every((r: any) => r.url === null && typeof r.r2_key === "string")).toBe(true);
    const realNow = Date.now;
    const later = realNow() + 2 * CALL_RECORDING_URL_WINDOW_MS;
    Date.now = () => later;
    try {
      const signedLater = await signForCli(cached);
      expect(signedLater.recordings.every((r: any) => r.url_expires_at > later)).toBe(true);
    } finally {
      Date.now = realNow;
    }
    expect((await t.query(api.transcripts.cliListCalls, { api_token: TOKEN })).find((r: any) => r._id === transcript_id).video).toBe("ready");
    expect(await as(String(cat)).query(api.callRecordings.webCallRecordings, { call: call.short_id, url_window: win })).toBeNull();
    expect(await roomEnd(as, cat, room)).toBeNull();
    expect((await liveRoom(as, cat, room))?.recording_run ?? null).toBeNull();
  });

  test("a page cannot sign further than a beat ahead of now, whatever window it asks for", () => {
    const W = CALL_RECORDING_URL_WINDOW_MS;
    const now = 100 * W + 5;
    expect(signingMoment(100, now)).toBe(100 * W);
    expect(signingMoment(10_000, now)).toBe(now + SIGNING_LEAD_MS);
    expect(signingMoment(1, now)).toBe(now - W);
    // Whatever is asked, a URL never outlives now by more than two windows
    // and the lead, which is the most a revocation can lag. At the very end
    // of a window the lead moves the signature into the next one, dated at
    // most the lead ahead of the server's clock.
    for (const at of [100 * W + 5, 101 * W - 1, 101 * W - SIGNING_LEAD_MS / 2]) {
      for (const asked of [0, 100, 101, 102, 10_000]) {
        const w = stableSigningWindow(signingMoment(asked, at), W);
        expect(w.expiresAt).toBeLessThanOrEqual(at + 2 * W + SIGNING_LEAD_MS);
        expect(w.signedAt.getTime()).toBeLessThanOrEqual(at + SIGNING_LEAD_MS);
      }
    }
  });

  test("the last person leaving stops the recording once the room stays empty, and the room is told why", async () => {
    const { t, ana, ben, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    await as(String(ana)).mutation(api.calls.leaveRoom, { room_key: room });
    expect((await rows(t))[0].status).toBe("starting");
    // The last leave is not yet the end: the web leaves on beforeunload, so a
    // reload is a leave and a join a second apart, and must not cut the video.
    await as(String(ben)).mutation(api.calls.leaveRoom, { room_key: room });
    expect((await rows(t))[0].status).toBe("starting");
    // LiveKit's room holding nobody for the empty-room window is the end,
    // counted from a while after a deliberate leave: a reload under load
    // can take longer than the window to sit back down.
    world.setParticipants([]);
    await look(t, recording_id, { empty_since: Date.now() - 31_000 });
    expect((await rows(t))[0].status).toBe("starting");
    await t.run(async (ctx: any) => {
      const [state] = await ctx.db.query("call_room_state").collect();
      await ctx.db.patch(state._id, { emptied_at: Date.now() - 121_000 });
    });
    await look(t, recording_id, { empty_since: Date.now() - 121_000 });
    const [row] = await rows(t);
    expect(row).toMatchObject({ status: "stopping", stop_reason: "room_empty" });
    expect(row.stopped_by).toBeUndefined();
    // Nobody pressed it: the line says the room emptied, on the presser's row.
    expect(await events(t)).toEqual(["record_on", "record_off:room_empty"]);
    expect(String((await eventRows(t))[1].user_id)).toBe(String(ana));
  });

  test("the last teammate pressing End stops it at once; a guest left behind is not filmed alone, and stays admitted", async () => {
    const { t, ana, ben, team, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const now = Date.now();
    const guest = await t.run(async (ctx: any) => {
      const link = await ctx.db.insert("call_guest_links", { room_key: room, team_id: team, token: "t".repeat(24), created_by: ana, created_at: now, expires_at: now + 3_600_000 });
      return await ctx.db.insert("call_guests", { link_id: link, room_key: room, team_id: team, name: "Dana", secret_hash: await sha256Hex(GUEST_SECRET), status: "admitted", created_at: now, knocked_at: now, last_seen: now });
    });
    // Ana hangs up with Ben still there: the room is not empty.
    await as(String(ana)).mutation(api.calls.leaveRoom, { room_key: room, hangup: true });
    expect((await rows(t))[0].status).toBe("starting");
    // Ben, the last teammate, presses End. (The same last leave without
    // `hangup`, a tab closing, keeps it for a reload: the test above.)
    await as(String(ben)).mutation(api.calls.leaveRoom, { room_key: room, hangup: true });
    expect((await rows(t))[0]).toMatchObject({ status: "stopping", stop_reason: "room_empty" });
    expect(await events(t)).toEqual(["record_on", "record_off:room_empty"]);
    expect((await t.run(async (ctx: any) => await ctx.db.get(guest))).status).toBe("admitted");
  });

  test("a room LiveKit shows holding only a guest stops like an empty one, once no seat is held either", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    world.setParticipants([{ identity: guestIdentity("g1"), name: "Dana", tracks: [] }]);
    // Ana and Ben's seats are still live: they are reconnecting, not gone.
    // LiveKit's list alone never stops the run.
    await look(t, recording_id, { empty_since: Date.now() - 31_000 });
    expect((await rows(t))[0].status).toBe("starting");
    // Their leases lapse (the tabs died): both clocks agree, and it stops,
    // saying the room emptied of teammates rather than that everyone left.
    await t.run(async (ctx: any) => {
      for (const m of await ctx.db.query("call_members").collect()) await ctx.db.patch(m._id, { last_seen: Date.now() - 10 * 60_000 });
    });
    await look(t, recording_id, { empty_since: Date.now() - 31_000 });
    expect((await rows(t))[0]).toMatchObject({ status: "stopping", stop_reason: "room_empty" });
  });

  test("stopped before LiveKit wrote a frame: the run leaves nothing behind", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    await settle(t);
    const e = world.egresses.get("EG_1")!;
    e.status = "EGRESS_ABORTED";
    e.error = "Start signal not received";
    // Exactly what LiveKit reports for an abort: a file at one instant.
    e.file_results = [{ filename: e.request.file_outputs[0].filepath, started_at: NS(1_000), ended_at: NS(1_000), duration: "0", size: "0" }];
    await look(t, recording_id);
    await settle(t);
    expect(await rows(t)).toEqual([]);
    // Whatever LiveKit may have written under the run is cleared too.
    expect(world.deletes.length).toBeGreaterThan(0);
  });

  test("a LiveKit refusal is a failed row that says what happened, and the room hears it", async () => {
    const { t, ana, room, as } = await seed();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).includes("StartRoomCompositeEgress")) return new Response(JSON.stringify({ code: "unauthenticated", msg: "bad key" }), { status: 401 });
      return realFetch(input, init);
    }) as any;
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    const [row] = await rows(t);
    expect(row).toMatchObject({ status: "failed", stop_reason: "failed", error: "LiveKit refused this server's credentials, so the recording could not start." });
    // A failed press frees the room to try again, and the room's notice can
    // say it failed rather than that a video is saving.
    expect((await liveRoom(as, ana, room)).recording_run).toBeNull();
    expect(await roomEnd(as, ana, room)).toMatchObject({ run_id: String(row._id), status: "failed", stop_reason: "failed", error: row.error, stopped_by: null, at_ms: null });
    expect(await events(t)).toEqual(["record_on", "record_off:failed"]);
    expect((await eventRows(t))[1].text).toBe(row.error);
  });

  test("LiveKit ending the room's video on its own tells the room", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t))[0];
    world.activate("EG_1", comp.r2_key, Date.now() - 60_000);
    await look(t, recording_id);
    const e = world.egresses.get("EG_1")!;
    e.status = "EGRESS_LIMIT_REACHED";
    e.file_results = [{ filename: comp.r2_key, started_at: NS(Date.now() - 60_000), duration: NS(60_000) }];
    await look(t, recording_id);
    expect((await rows(t))[0]).toMatchObject({ status: "ready", stop_reason: "limit" });
    expect(await events(t)).toEqual(["record_on", "record_off:limit"]);
  });
});

describe("a file LiveKit never begins", () => {
  test("a screen file still starting past the limit fails and is stopped; the room keeps recording", async () => {
    // The shape of the share files lost on 2026-10-02: accepted, never
    // written, and gone without a word once the run ended.
    const { t, ana, room, as } = await seed();
    world.setParticipants([screenShare(String(ana))]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t)).find((r: any) => r.kind === "composite");
    world.activate("EG_1", comp.r2_key, Date.now() - 10_000);
    await look(t, recording_id);
    expect((await rows(t)).find((r: any) => r.kind === "screen").status).toBe("starting");
    expect(world.stops()).toEqual([]);

    await t.run(async (ctx: any) => {
      const screen = (await ctx.db.query("call_recordings").collect()).find((r: any) => r.kind === "screen");
      await ctx.db.patch(screen._id, { requested_at: Date.now() - EGRESS_BEGIN_TIMEOUT_MS - 1_000 });
    });
    await look(t, recording_id);
    await settle(t);
    const after = await rows(t);
    expect(after.find((r: any) => r.kind === "screen")).toMatchObject({ status: "failed", error: "LiveKit accepted this recording but never began writing it.", stop_reason: "failed" });
    expect(after.find((r: any) => r.kind === "composite").status).toBe("recording");
    expect(world.stops()).toEqual(["EG_2"]);
    // The room is told about its own video, not about one share's file.
    expect(await events(t)).toEqual(["record_on"]);
  });
});

describe("nothing films untracked", () => {
  test("a start whose answer was lost is found by its path and attached, not failed", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    world.loseStartAnswers(true);
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    const [row] = await rows(t);
    expect(row).toMatchObject({ status: "starting", egress_id: "EG_1" });
    expect(world.stops()).toEqual([]);
  });

  test("an answer that lands after its row failed stops what it started", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    // The loop gave up on LiveKit before startRun's answer came back.
    await t.mutation(internal.callRecordings.failRecording, { id: recording_id, error: "LiveKit never started this recording." });
    const applied = await t.mutation(internal.callRecordings.applyEgress, {
      id: recording_id,
      egress: { egressId: "EG_9", roomName: room, status: "starting", files: [], paths: [] },
      attach: true,
    });
    expect(applied.stop).toBe(true);
    expect((await rows(t))[0]).toMatchObject({ status: "failed", egress_id: "EG_9" });
  });

  test("an egress LiveKit forgets: once is a blip, twice it is settled from the bucket", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t))[0];
    world.activate("EG_1", comp.r2_key, Date.now() - 30_000);
    await look(t, recording_id);
    world.egresses.delete("EG_1");
    // One empty answer changes nothing.
    await look(t, recording_id);
    expect((await rows(t))[0].status).toBe("recording");
    // Twice, with the file in the bucket: it finished while nobody looked.
    world.objects.set(comp.r2_key, 777);
    await look(t, recording_id, { missing: ["EG_1"] });
    expect((await rows(t))[0]).toMatchObject({ status: "ready", size_bytes: 777, ended_at: 1_790_000_000_000, stop_reason: "ended" });
    // Its live frame goes with the live call, as on every other way a file
    // ends, and the room is told it stopped without anyone saying why.
    await settle(t);
    expect((await rows(t))[0].live_frame_key).toBeUndefined();
    expect(world.deletes).toContain(comp.live_frame_key);
    expect(await events(t)).toEqual(["record_on", "record_off:ended"]);
  });

  // LiveKit closes an emptied room's video before codecast's own empty room
  // stop is due (the only teammate's page reloaded, say). The look that sees
  // it close reads the room, so the thread says why rather than a bare stop.
  test("a room video LiveKit closes by itself says why: the room emptied, or nothing the room could see", async () => {
    const { t, ana, ben, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t))[0];
    const began = Date.now() - 60_000;
    world.activate("EG_1", comp.r2_key, began);
    await look(t, recording_id);
    expect((await rows(t))[0].status).toBe("recording");
    // Nobody's seat is held when LiveKit finishes the file.
    await as(String(ana)).mutation(api.calls.leaveRoom, { room_key: room });
    await as(String(ben)).mutation(api.calls.leaveRoom, { room_key: room });
    world.setParticipants([]);
    world.complete("EG_1", comp.r2_key, began, 60_000);
    await look(t, recording_id);
    expect((await rows(t))[0]).toMatchObject({ status: "ready", stop_reason: "room_empty" });
    expect(await events(t)).toEqual(["record_on", "record_off:room_empty"]);
    expect(recordingStoppedItselfWords("room_empty")).toBe("Recording stopped: no teammate was left in the call");
  });

  test("a room video LiveKit closes while the room is still seated is said as LiveKit's doing, never as unexplained", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t))[0];
    const began = Date.now() - 60_000;
    world.activate("EG_1", comp.r2_key, began);
    await look(t, recording_id);
    world.complete("EG_1", comp.r2_key, began, 60_000);
    await look(t, recording_id);
    expect((await rows(t))[0]).toMatchObject({ status: "ready", stop_reason: "ended" });
    expect(recordingStoppedItselfWords("ended")).toBe("Recording stopped: the media server closed the file");
  });

  test("a stop whose save never finishes is settled from the bucket, or failed, so the room is never left saving", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t))[0];
    world.activate("EG_1", comp.r2_key, Date.now() - 60_000);
    await look(t, recording_id);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    await settle(t);
    // LiveKit keeps reporting the egress as ending: it is finishing the file.
    expect(world.egresses.get("EG_1")!.status).toBe("EGRESS_ENDING");
    await look(t, recording_id);
    expect((await rows(t))[0].status).toBe("stopping");
    const stuck = async (ms: number) =>
      t.run(async (ctx: any) => {
        for (const r of await ctx.db.query("call_recordings").collect()) await ctx.db.patch(r._id, { stop_requested_at: Date.now() - ms });
      });
    // Past the short timeout, a file LiveKit is visibly finishing is a long
    // upload, not a lost one: it keeps waiting.
    await stuck(EGRESS_SAVE_TIMEOUT_MS + 1_000);
    await look(t, recording_id);
    await settle(t);
    expect((await rows(t))[0].status).toBe("stopping");
    expect(await events(t)).toEqual(["record_on", "record_off:pressed"]);
    // Past the longer ceiling it is stuck after all. The room was told at the
    // stop that the video was saving, so it is told, once, that it is gone;
    // the file's end is its stop, not the moment the save was given up.
    await stuck(EGRESS_FINISHING_SAVE_TIMEOUT_MS + 1_000);
    await look(t, recording_id);
    await settle(t);
    const lost = (await rows(t))[0];
    expect(lost).toMatchObject({ status: "failed", error: "LiveKit never finished saving this recording.", stop_reason: "pressed" });
    expect(lost.ended_at).toBe(lost.stop_requested_at);
    expect((await liveRoom(as, ana, room)).recording_run).toBeNull();
    expect(await events(t)).toEqual(["record_on", "record_off:pressed", "record_lost:failed"]);
    expect((await eventRows(t))[2]).toMatchObject({ text: "LiveKit never finished saving this recording.", event_run_id: recording_id, user_id: ana });
    expect(await roomEnd(as, ana, room)).toMatchObject({ run_id: recording_id, status: "failed", lost: true, started_by: String(ana) });
    await look(t, recording_id);
    expect(await events(t)).toHaveLength(3);

    // The upload lands anyway: the bucket sweep finds the file its row
    // kept, and the video is there to watch.
    world.objects.set(lost.r2_key, 4242);
    world.modified.set(lost.r2_key, Date.now());
    expect(await t.action(internal.callRecordings.sweepRecordingObjects, {})).toMatchObject({ deleted: 0, landed: 1 });
    await settle(t);
    const landed = (await rows(t))[0];
    expect(landed).toMatchObject({ status: "ready", size_bytes: 4242, stop_reason: "pressed", ended_at: lost.ended_at });
    expect([landed.error, landed.error_kind]).toEqual([undefined, undefined]);
    expect((await roomEnd(as, ana, room)).lost).toBe(false);
    expect(await t.action(internal.callRecordings.sweepRecordingObjects, {})).toMatchObject({ landed: 0 });
  });

  test("a stop LiveKit ignored, or forgot, is stuck past the short timeout", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t))[0];
    world.activate("EG_1", comp.r2_key, Date.now() - 60_000);
    await look(t, recording_id);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    await settle(t);
    // The stop never took: LiveKit still films.
    world.egresses.get("EG_1")!.status = "EGRESS_ACTIVE";
    await t.run(async (ctx: any) => await ctx.db.patch(comp._id, { stop_requested_at: Date.now() - EGRESS_SAVE_TIMEOUT_MS - 1_000 }));
    await look(t, recording_id);
    await settle(t);
    expect((await rows(t))[0]).toMatchObject({ status: "failed", error: "LiveKit never finished saving this recording." });
  });

  test("a save that fails after somebody else's stop is said once, as its own line, and owed to the presser", async () => {
    const { t, ana, ben, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t))[0];
    world.activate("EG_1", comp.r2_key, Date.now() - 60_000);
    await look(t, recording_id);
    await as(String(ben)).mutation(api.callRecordings.stopRecording, { room_key: room });
    await settle(t);
    expect(await events(t)).toEqual(["record_on", "record_off:pressed"]);
    world.fail("EG_1", "upload failed: AccessDenied");
    await look(t, recording_id);
    await look(t, recording_id);
    await settle(t);
    expect(await events(t)).toEqual(["record_on", "record_off:pressed", "record_lost:failed"]);
    // The line is the presser's, whoever stopped it.
    expect(String((await eventRows(t))[2].user_id)).toBe(String(ana));
    expect(await roomEnd(as, ben, room)).toMatchObject({ lost: true, started_by: String(ana), stopped_by: { id: String(ben) } });
  });

  test("a start LiveKit cannot even be asked about fails after the ceiling, so the room stops showing it", async () => {
    const { t, ana, room, as } = await seed();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).includes("/twirp/livekit.Egress/")) throw new TypeError("fetch failed");
      return realFetch(input, init);
    }) as any;
    try {
      const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
      await settle(t);
      await quietLoops(t);
      // startRun's own adopt look could not list either, so the row failed
      // there already, or is still starting with no egress: force the
      // second case and look past the accept window only.
      await t.run(async (ctx: any) => {
        for (const r of await ctx.db.query("call_recordings").collect()) {
          await ctx.db.patch(r._id, { status: "starting", egress_id: undefined, error: undefined, stop_reason: undefined, requested_at: Date.now() - 2 * 60_000 });
        }
      });
      await look(t, recording_id);
      expect((await rows(t))[0].status).toBe("starting");
      await t.run(async (ctx: any) => {
        for (const r of await ctx.db.query("call_recordings").collect()) await ctx.db.patch(r._id, { requested_at: Date.now() - EGRESS_UNREACHABLE_FAIL_MS - 1_000 });
      });
      await look(t, recording_id);
      expect((await rows(t))[0]).toMatchObject({ status: "failed", error: "LiveKit could not be reached to start this recording." });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an egress LiveKit forgets with nothing in the bucket is stopped and failed", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t))[0];
    world.activate("EG_1", comp.r2_key, Date.now() - 30_000);
    await look(t, recording_id);
    world.egresses.delete("EG_1");
    await look(t, recording_id, { missing: ["EG_1"] });
    await settle(t);
    expect((await rows(t))[0]).toMatchObject({ status: "failed", error: "LiveKit lost track of this recording before it finished." });
    expect(world.stops()).toContain("EG_1");
    expect(await events(t)).toEqual(["record_on", "record_off:failed"]);
  });

  test("the sweep stops an egress writing into the bucket that no live row tracks", async () => {
    const { t, room } = await seed();
    world.egresses.set("EG_x", { egress_id: "EG_x", room_name: room, status: "EGRESS_ACTIVE", kind: "room", request: { file_outputs: [{ filepath: "calls/tX/1-composite.mp4" }] }, file_results: [] });
    // Somebody else's egress in the same LiveKit project is left alone.
    world.egresses.set("EG_y", { egress_id: "EG_y", room_name: "other", status: "EGRESS_ACTIVE", kind: "room", request: { file_outputs: [{ filepath: "elsewhere/a.mp4" }] }, file_results: [] });
    // Nothing was ever pressed here: the sweep asks LiveKit nothing.
    expect(await t.action(internal.callRecordings.sweepRecordings, {})).toEqual({ runs: 0, restarted: 0, orphans: 0 });
    expect(world.calls.filter((c) => c.method === "Egress/ListEgress")).toEqual([]);
    // A press that failed before LiveKit's answer is what leaves such an
    // egress, and it is recent: now the sweep looks, and stops it.
    await t.run(async (ctx: any) => {
      const user = (await ctx.db.query("users").first())._id;
      const team = (await ctx.db.query("teams").first())._id;
      const call = await ctx.db.insert("transcripts", { room_key: room, team_id: team, started_by: user, status: "ended", started_at: Date.now() - 60_000, routes: [], last_seq: 0 } as any);
      await ctx.db.insert("call_recordings", { transcript_id: call, room_key: room, team_id: team, kind: "composite", status: "failed", r2_key: "calls/tX/0-composite.mp4", started_by: user, requested_at: Date.now() - 30_000, updated_at: Date.now() });
    });
    expect(await t.action(internal.callRecordings.sweepRecordings, {})).toEqual({ runs: 0, restarted: 0, orphans: 1 });
    expect(world.stops()).toEqual(["EG_x"]);
  });

  test("an old run's loop ending its run never stops a newer press", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([screenShare(String(ana))]);
    const a = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    // Run A's room video fails while its screen file still records.
    await t.run(async (ctx: any) => await ctx.db.patch(a.recording_id, { status: "failed", stop_reason: "failed", error: "LiveKit: boom" }));
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const b = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    await look(t, a.recording_id);
    const after = await rows(t);
    expect(after.find((r: any) => r.kind === "screen").status).toBe("stopping");
    expect(after.find((r: any) => String(r._id) === String(b.recording_id)).status).toBe("starting");
  });
});

describe("guests", () => {
  test("an admitted guest may stop it, and the thread names them", async () => {
    const { t, ana, team, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    const now = Date.now();
    const guest = await t.run(async (ctx: any) => {
      const link = await ctx.db.insert("call_guest_links", { room_key: room, team_id: team, token: "t".repeat(24), created_by: ana, created_at: now, expires_at: now + 3_600_000 });
      return await ctx.db.insert("call_guests", { link_id: link, room_key: room, team_id: team, name: "Dana", secret_hash: await sha256Hex(GUEST_SECRET), status: "admitted", created_at: now, knocked_at: now, last_seen: now });
    });
    await expect(t.mutation(api.callRecordings.guestStopRecording, { guest_id: String(guest), secret: "x".repeat(32) })).rejects.toThrow(/Only someone in the huddle/);
    expect(await t.mutation(api.callRecordings.guestStopRecording, { guest_id: String(guest), secret: GUEST_SECRET })).toEqual({ stopped: 1 });
    expect((await rows(t))[0]).toMatchObject({ status: "stopping", stopped_by: guestIdentity(String(guest)) });
    const off = (await eventRows(t))[1];
    expect(off).toMatchObject({ event: "record_off", event_reason: "pressed", event_guest_name: "Dana" });
    const thread = await as(String(ana)).query(api.callChat.list, { room_key: room });
    expect(thread.at(-1)).toMatchObject({ event: "record_off", user_name: "Dana", event_guest_name: "Dana" });
  });

  test("the room's state names the presser without their address", async () => {
    const { t, ana, room, as } = await seed();
    await t.run(async (ctx: any) => await ctx.db.patch(ana, { name: undefined, github_username: "ana-gh" }));
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    expect((await liveRoom(as, ana, room)).recording_run.started_by.name).toBe("ana-gh");
  });
});

describe("is the room being filmed", () => {
  test("a member's REC flag and a guest's notice agree for every status a run can hold", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await quietLoops(t);
    for (const status of CALL_RECORDING_STATUSES) {
      await t.run(async (ctx: any) => await ctx.db.patch(recording_id, { status }));
      const member = (await liveRoom(as, ana, room)).recording;
      const guest = (await t.run(async (ctx: any) => await roomNotice(ctx, room))).recording;
      expect([status, member, guest]).toEqual([status, isRecordingFilming(status), isRecordingFilming(status)]);
    }
  });
});

describe("who may watch and delete", () => {
  test("the live frame is for someone in the room, or a session the call feeds live, never a reader outside it", async () => {
    const { t, ana, ben, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id, transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t))[0];
    world.activate("EG_1", comp.r2_key, Date.now() - 5_000);
    await look(t, recording_id);
    const call = await t.run(async (ctx: any) => await ctx.db.get(transcript_id));
    const snap = async () => signForCli(await t.query(internal.callRecordings.cliCallRecordings, { api_token: TOKEN, call: call.short_id }));

    // Ben (the token's owner) sits in the room: he sees it as it is now.
    const seated = await snap();
    expect(seated.live_watch).toBe(true);
    expect(seated.recordings[0].live_frame_url).not.toBeNull();

    // He steps out. He can still read the call, but watching it live from
    // outside would be unseen by the room: no live frame for him.
    const seat = await t.run(async (ctx: any) => (await ctx.db.query("call_members").collect()).find((m: any) => String(m.user_id) === String(ben)));
    await t.run(async (ctx: any) => ctx.db.patch(seat._id, { last_seen: Date.now() - 10 * 60_000 }));
    const outside = await snap();
    expect(outside.live_watch).toBe(false);
    expect(outside.recordings.map((r: any) => r.live_frame_url)).toEqual([null]);

    // A session of his that the call feeds live is in the room in his name.
    await t.run(async (ctx: any) => {
      const conv = await ctx.db.insert("conversations", { user_id: ben, agent_type: "claude_code", started_at: Date.now() } as any);
      await ctx.db.insert("call_agent_feeds", { conversation_id: conv, transcript_id, room_key: room, added_by: ben } as any);
    });
    const fed = await snap();
    expect(fed.live_watch).toBe(true);
    expect(fed.recordings[0].live_frame_url).not.toBeNull();
  });

  test("the presser or a team admin, only once stopped; rows now, the whole run's objects right after, and the room is told", async () => {
    const { t, ana, ben, team, room, as } = await seed();
    world.setParticipants([screenShare(String(ana))]);
    // Ben presses, but the call record is Ana's (she holds the scribe seat).
    const call = await t.run(async (ctx: any) =>
      await ctx.db.insert("transcripts", { room_key: room, team_id: team, started_by: ana, status: "live", started_at: Date.now(), routes: [], last_seq: 0, short_id: "cl-7" } as any),
    );
    const { recording_id, transcript_id } = await as(String(ben)).mutation(api.callRecordings.startRecording, { room_key: room });
    expect(transcript_id).toBe(call);
    await settle(t);
    await quietLoops(t);
    await expect(as(String(ben)).mutation(api.callRecordings.deleteRecording, { recording_id })).rejects.toThrow(/Stop the recording/);

    const all = await rows(t);
    const comp = all.find((r: any) => r.kind === "composite");
    const scr = all.find((r: any) => r.kind === "screen");
    await as(String(ben)).mutation(api.callRecordings.stopRecording, { room_key: room });
    await settle(t);
    world.complete("EG_1", comp.r2_key, Date.now(), 10_000);
    // The screen is still uploading: nobody is offered Delete yet.
    const midway = await as(String(ben)).query(api.callRecordings.webCallRecordings, { call: "cl-7", url_window: callRecordingUrlWindow() });
    await look(t, recording_id);
    const midRead = await as(String(ben)).query(api.callRecordings.webCallRecordings, { call: "cl-7", url_window: callRecordingUrlWindow() });
    expect(midway.recordings.every((r: any) => !r.can_delete)).toBe(true);
    expect(midRead.recordings.map((r: any) => [r.kind, r.status, r.can_delete])).toEqual([
      ["composite", "ready", false],
      ["screen", "stopping", false],
    ]);
    world.complete("EG_2", scr.r2_key, Date.now(), 5_000);
    await look(t, recording_id);
    // Something LiveKit wrote under the run that no row names.
    const stray = `${comp.r2_key.replace(/composite\.mp4$/, "")}screen-TR_old.mp4`;
    world.objects.set(stray, 1);

    // Ana holds the scribe seat, which grants nothing here; Ben pressed.
    const anaView = await as(String(ana)).query(api.callRecordings.webCallRecordings, { call: "cl-7", url_window: callRecordingUrlWindow() });
    expect(anaView.recordings.every((r: any) => !r.can_delete)).toBe(true);
    await expect(as(String(ana)).mutation(api.callRecordings.deleteRecording, { recording_id })).rejects.toThrow(/Only whoever started this recording, or a team admin/);
    const benView = await as(String(ben)).query(api.callRecordings.webCallRecordings, { call: "cl-7", url_window: callRecordingUrlWindow() });
    expect(benView.recordings.every((r: any) => r.can_delete)).toBe(true);

    // Dee is a teammate who is not in this DM: she cannot read it at all.
    const dee = await t.run(async (ctx: any) => {
      const u = await ctx.db.insert("users", { name: "Dee" } as any);
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "admin", joined_at: Date.now() } as any);
      return u;
    });
    expect(await as(String(dee)).query(api.callRecordings.webCallRecordings, { call: "cl-7", url_window: callRecordingUrlWindow() })).toBeNull();
    await expect(as(String(dee)).mutation(api.callRecordings.deleteRecording, { recording_id })).rejects.toThrow(/Recording not found/);

    // Deleting a screen file deletes its whole run, and everything under it.
    expect(await as(String(ben)).mutation(api.callRecordings.deleteRecording, { recording_id: scr._id })).toEqual({ deleted: 2 });
    expect(await rows(t)).toEqual([]);
    await settle(t);
    expect(world.objects.size).toBe(0);
    expect(world.deletes).toEqual(expect.arrayContaining([comp.r2_key, scr.r2_key, stray]));
    const events = await eventRows(t);
    const deleted = events.find((r: any) => r.event === "record_deleted");
    expect(deleted).toMatchObject({ transcript_id: call });
    expect(String(deleted.user_id)).toBe(String(ben));
    // The delete names the run, as its start and stop did, and what it had
    // filmed on the call's clock, so the thread can say which one went.
    expect(deleted.event_run_id).toBe(String(recording_id));
    expect(events.filter((r: any) => r.event === "record_on" || r.event === "record_off").map((r: any) => r.event_run_id)).toEqual(
      expect.arrayContaining([String(recording_id)]),
    );
    expect(deleted.event_span.to_ms).toBeGreaterThanOrEqual(deleted.event_span.from_ms);
  });

  test("a picture of a recording goes public only by whoever may publish it, the room is told, and it comes down with it", async () => {
    const { t, ana, ben, cat, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    world.complete("EG_1", (await rows(t))[0].r2_key, Date.now(), 1_000);
    await look(t, recording_id);
    // Someone else's object (an attachment, an avatar, a session's image)
    // that a client might name: sharing never takes a storage id, so it
    // survives the recording's delete.
    const theirs = await t.run(async (ctx: any) => ctx.storage.store(new Blob(["someone else's"], { type: "image/png" })));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
    const share = (api_token: string, image_base64: string, extra: Record<string, unknown> = {}) =>
      t.action(internal.callRecordings.cliShareFrame, { api_token, recording_id, image_base64, ...extra } as any);
    // The stop's scheduled work runs first: convex-test holds one
    // transaction at a time, and the share's store must not land inside it.
    await settle(t);
    // Ana pressed Record, so a picture of it is hers to publish; Ben (the
    // other token) may read the call but not put it on a public link, and
    // nothing is stored when he tries.
    const ANA = "a".repeat(64);
    await t.run(async (ctx: any) => ctx.db.insert("api_tokens", { user_id: ana, token_hash: await hashToken(ANA), name: "cli", created_at: Date.now(), last_used_at: Date.now() } as any));
    const stored = () => t.run(async (ctx: any) => (await ctx.db.system.query("_storage").collect()).length);
    const unshared = await stored();
    await expect(share(TOKEN, png)).rejects.toThrow(/whoever recorded this call, a team admin, or the person whose screen/);
    expect(await stored()).toBe(unshared);
    await expect(share(ANA, png, { storage_id: String(theirs) })).rejects.toThrow();
    // The same picture shared twice is one object, one link and one row, and
    // the row names the object it stored and the moment it shows.
    const first = await share(ANA, png, { at_ms: 150_400 });
    const again = await share(ANA, png, { at_ms: 150_400 });
    expect(again).toEqual(first);
    const shares = await t.run(async (ctx: any) => ctx.db.query("call_frame_shares").collect());
    expect(shares).toHaveLength(1);
    expect(String(shares[0].storage_id)).toBe(first.storage_id);
    expect(String(shares[0].storage_id)).not.toBe(String(theirs));
    expect(shares[0].at_ms).toBe(150_400);
    // The room's thread says a picture went public, once, with the moment.
    const told = (await eventRows(t)).filter((r: any) => r.event === "frame_shared");
    expect(told).toHaveLength(1);
    expect(String(told[0].user_id)).toBe(String(ana));
    expect(told[0].text).toMatch(/^cl-\d+@2:30$/);
    // The call page lists it for every reader, with what it shows and its link.
    const page = await as(String(ben)).query(api.callRecordings.webCallRecordings, { call: String(shares[0].transcript_id), url_window: callRecordingUrlWindow() });
    expect(page?.frame_shares).toHaveLength(1);
    expect(page?.frame_shares[0]).toMatchObject({ _id: String(shares[0]._id), kind: "composite", at_ms: 150_400, shared_by: String(ana), url: expect.any(String) });
    // Only pictures: anything else would be served publicly under its type.
    await expect(share(ANA, Buffer.from("<html>").toString("base64"))).rejects.toThrow(/PNG or JPEG/);
    // Someone who cannot read the call cannot share from it, and nothing is stored.
    const CAT = "c".repeat(64);
    await t.run(async (ctx: any) => ctx.db.insert("api_tokens", { user_id: cat, token_hash: await hashToken(CAT), name: "cli", created_at: Date.now(), last_used_at: Date.now() } as any));
    const before = await t.run(async (ctx: any) => (await ctx.db.system.query("_storage").collect()).length);
    await expect(share(CAT, Buffer.from([0xff, 0xd8, 0xff, 9]).toString("base64"))).rejects.toThrow(/Recording not found/);
    expect(await t.run(async (ctx: any) => (await ctx.db.system.query("_storage").collect()).length)).toBe(before);
    // Taking a picture down is any reader's, as taking the video off the link
    // is; Cat, who cannot read the call, changes nothing. Gone twice is fine.
    expect(await as(String(cat)).mutation(api.callRecordings.deleteCallFrameShare, { share_id: String(shares[0]._id) })).toEqual({ deleted: false });
    expect(await as(String(ben)).mutation(api.callRecordings.deleteCallFrameShare, { share_id: String(shares[0]._id) })).toEqual({ deleted: true });
    expect(await as(String(ben)).mutation(api.callRecordings.deleteCallFrameShare, { share_id: String(shares[0]._id) })).toEqual({ deleted: false });
    expect(await t.run(async (ctx: any) => ctx.storage.getUrl(first.storage_id))).toBeNull();
    // Shared again, it goes with the recording.
    const second = await share(ANA, png, { at_ms: 150_400 });

    expect(await as(String(ana)).mutation(api.callRecordings.deleteRecording, { recording_id })).toEqual({ deleted: 1 });
    expect(await t.run(async (ctx: any) => ctx.storage.getUrl(second.storage_id))).toBeNull();
    expect(await t.run(async (ctx: any) => ctx.storage.getUrl(theirs))).not.toBeNull();
    expect(await t.run(async (ctx: any) => (await ctx.db.query("call_frame_shares").collect()).length)).toBe(0);
  });

  test("a team admin who can read the call may delete it", async () => {
    const { t, ana, ben, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    world.complete("EG_1", (await rows(t))[0].r2_key, Date.now(), 1_000);
    await look(t, recording_id);
    await t.run(async (ctx: any) => {
      const m = (await ctx.db.query("team_memberships").collect()).find((x: any) => String(x.user_id) === String(ben));
      await ctx.db.patch(m._id, { role: "admin" });
    });
    expect(await as(String(ben)).mutation(api.callRecordings.deleteRecording, { recording_id })).toEqual({ deleted: 1 });
  });

  test("the store's delete is receipt-backed: a refusal is its recorded outcome, a retry reads it back, and a run already gone is done", async () => {
    const { t, ana, ben, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    world.complete("EG_1", (await rows(t))[0].r2_key, Date.now(), 1_000);
    await look(t, recording_id);
    const del = (u: string, commandId: string) =>
      as(u).mutation(api.dispatch.dispatch, {
        action: "deleteCallRecording",
        args: [recording_id],
        result: { receiptActionVersion: 1, commandId, localResult: { recordingId: recording_id } },
      });

    // Ben did not press it: refused as data, the run untouched, and the same
    // command asked again answers the same.
    const refused = await del(String(ben), "cmd-ben-1");
    expect(refused).toMatchObject({ commandId: "cmd-ben-1", status: "rejected", rejection: { code: "FORBIDDEN" } });
    expect(await del(String(ben), "cmd-ben-1")).toEqual(refused);
    expect(await rows(t)).toHaveLength(1);

    // Ana's delete lands once; its retry (an answer lost on the way back)
    // reads the receipt rather than meeting "not found".
    const done = await del(String(ana), "cmd-ana-1");
    expect(done).toMatchObject({ status: "acknowledged", result: { deleted: 1 } });
    expect(await rows(t)).toEqual([]);
    expect(await del(String(ana), "cmd-ana-1")).toEqual(done);
    // A second window's delete of the same run: already gone, so done.
    expect(await del(String(ana), "cmd-ana-2")).toMatchObject({ status: "acknowledged", result: { deleted: 0 } });
    expect((await eventRows(t)).filter((r: any) => r.event === "record_deleted")).toHaveLength(1);
  });

  test("everyone the video showed may watch it, spoken or not", async () => {
    const { t, ana, team, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    // Dee is on the team but no member of this DM (in by an invite grant,
    // say): filmed, never spoke, transcription off.
    const dee = await t.run(async (ctx: any) => {
      const u = await ctx.db.insert("users", { name: "Dee" } as any);
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: Date.now() } as any);
      return u;
    });
    expect(await as(String(dee)).query(api.callRecordings.webCallRecordings, { call: String(transcript_id), url_window: callRecordingUrlWindow() })).toBeNull();
    await t.run(async (ctx: any) => {
      const call = await ctx.db.get(transcript_id);
      await ctx.db.patch(transcript_id, { recorded_people: [...call.recorded_people, dee] });
    });
    expect(await as(String(dee)).query(api.callRecordings.webCallRecordings, { call: String(transcript_id), url_window: callRecordingUrlWindow() })).not.toBeNull();
  });
});

describe("the public share link", () => {
  test("shows the video only when somebody chose to, through a redirect that re-checks the link", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id, transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    const comp = (await rows(t))[0];
    const t0 = Date.now() - 60_000;
    world.complete("EG_1", comp.r2_key, t0, 60_000);
    await look(t, recording_id);

    const token = "0f5c9a1e-2b3d-4c5e-8f60-718293a4b5c6";
    await expect(as(String(ana)).mutation(api.callRecordings.setCallShareVideo, { call: String(transcript_id), include: true })).rejects.toThrow(/share link first/);
    await t.run(async (ctx: any) => await ctx.db.patch(transcript_id, { share_token: token }));
    // A link made for the transcript shows no video.
    expect((await t.query(api.publicShare.getSharedCall, { share_token: token })).videos).toEqual([]);
    expect(await as(String(ana)).mutation(api.callRecordings.setCallShareVideo, { call: String(transcript_id), include: true })).toEqual({ video_shared: true });
    const shared = await t.query(api.publicShare.getSharedCall, { share_token: token });
    expect(shared.videos).toEqual([{ id: `v${t0}`, started_at: t0, duration_ms: 60_000, url: `https://site.test/cli/share/call/video?token=${token}&at=${t0}` }]);
    expect(await t.query(internal.publicShare.sharedCallVideoObject, { share_token: token, at: t0 })).toBe(comp.r2_key);
    expect(await t.query(internal.publicShare.sharedCallVideoObject, { share_token: token, at: t0 + 1 })).toBeNull();

    // Turned off and on again is a new link, which starts without video.
    const fresh = "1f5c9a1e-2b3d-4c5e-8f60-718293a4b5c6";
    await t.run(async (ctx: any) => await ctx.db.patch(transcript_id, { share_token: fresh }));
    expect((await t.query(api.publicShare.getSharedCall, { share_token: fresh })).videos).toEqual([]);
    expect(await t.query(internal.publicShare.sharedCallVideoObject, { share_token: token, at: t0 })).toBeNull();
    const page = await as(String(ana)).query(api.callRecordings.webCallRecordings, { call: String(transcript_id), url_window: callRecordingUrlWindow() });
    expect(page).toMatchObject({ share_link: true, video_shared: false });
  });

  test("only the presser or an admin may publish the video, it covers the runs up to that choice, and the room is told", async () => {
    const { t, ana, ben, team, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const first = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    const comp = (await rows(t))[0];
    const t0 = Date.now() - 60_000;
    world.complete("EG_1", comp.r2_key, t0, 30_000);
    await look(t, first.recording_id);
    const token = "2f5c9a1e-2b3d-4c5e-8f60-718293a4b5c6";
    const call = String(first.transcript_id);
    await t.run(async (ctx: any) => await ctx.db.patch(first.transcript_id, { share_token: token }));

    // Ben may read the call and may switch the link on, but Ana recorded
    // it: putting faces on the internet takes her, or an admin.
    const benPage = await as(String(ben)).query(api.callRecordings.webCallRecordings, { call, url_window: callRecordingUrlWindow() });
    expect(benPage.can_share_video).toBe(false);
    await expect(as(String(ben)).mutation(api.callRecordings.setCallShareVideo, { call, include: true })).rejects.toThrow(/whoever recorded/);
    // Each change is a line in the room's thread, once: the people filmed
    // learn their faces went public, or came down, and who did it.
    const videoLines = async () => (await eventRows(t)).filter((r: any) => r.event === "video_shared" || r.event === "video_unshared");
    await as(String(ana)).mutation(api.callRecordings.setCallShareVideo, { call, include: true });
    expect((await t.query(api.publicShare.getSharedCall, { share_token: token })).videos).toHaveLength(1);
    const [shared] = await videoLines();
    // The stretch the link now shows, on the call's clock: the run it covers.
    const callRow = await t.run(async (ctx: any) => await ctx.db.get(first.transcript_id));
    expect(shared.event_span).toEqual(filmedSpan([(await rows(t))[0]], callRow.started_at));
    expect(shared).toMatchObject({ event: "video_shared", transcript_id: first.transcript_id });
    expect(String(shared.user_id)).toBe(String(ana));
    // Taking it off is anyone's who may read the call.
    expect(await as(String(ben)).mutation(api.callRecordings.setCallShareVideo, { call, include: false })).toEqual({ video_shared: false });
    expect((await t.query(api.publicShare.getSharedCall, { share_token: token })).videos).toEqual([]);
    await as(String(ben)).mutation(api.callRecordings.setCallShareVideo, { call, include: false });
    expect((await videoLines()).map((r: any) => [r.event, String(r.user_id)])).toEqual([
      ["video_shared", String(ana)],
      ["video_unshared", String(ben)],
    ]);
    // An admin may publish what someone else recorded.
    await t.run(async (ctx: any) => {
      const m = (await ctx.db.query("team_memberships").collect()).find((r: any) => String(r.user_id) === String(ben) && String(r.team_id) === String(team));
      await ctx.db.patch(m._id, { role: "admin" });
    });
    await as(String(ben)).mutation(api.callRecordings.setCallShareVideo, { call, include: true });

    // Record pressed again later: that run is the room being filmed AFTER
    // the choice. The room is told its video goes public only if it does.
    await t.run(async (ctx: any) => {
      for (const r of await ctx.db.query("call_recordings").collect()) await ctx.db.patch(r._id, { stop_requested_at: Date.now() - 60_000 });
    });
    const second = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    expect((await liveRoom(as, ana, room)).recording_run.video_shared).toBe(false);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    const comp2 = (await rows(t)).find((r: any) => String(r._id) === String(second.recording_id));
    world.complete("EG_2", comp2.r2_key, t0 + 40_000, 10_000);
    await look(t, second.recording_id);
    // The link still shows only the first run, and the page says one later
    // recording waits for a choice.
    expect((await t.query(api.publicShare.getSharedCall, { share_token: token })).videos.map((v: any) => v.started_at)).toEqual([t0]);
    const page = await as(String(ana)).query(api.callRecordings.webCallRecordings, { call, url_window: callRecordingUrlWindow() });
    expect(page).toMatchObject({ video_shared: true, video_later: 1, can_share_video: true });
    // Including again moves the cutoff to now: both are on the link, and
    // that is news; including once more, with nothing new, is not.
    expect((await videoLines()).map((r: any) => r.event)).toEqual(["video_shared", "video_unshared", "video_shared"]);
    await as(String(ana)).mutation(api.callRecordings.setCallShareVideo, { call, include: true });
    expect((await t.query(api.publicShare.getSharedCall, { share_token: token })).videos).toHaveLength(2);
    await as(String(ana)).mutation(api.callRecordings.setCallShareVideo, { call, include: true });
    expect((await videoLines()).map((r: any) => r.event)).toEqual(["video_shared", "video_unshared", "video_shared", "video_shared"]);
    // While a run that will be on the link records, the room is told.
    await t.run(async (ctx: any) => {
      for (const r of await ctx.db.query("call_recordings").collect()) await ctx.db.patch(r._id, { stop_requested_at: Date.now() - 60_000 });
    });
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    // The cutoff moving past the press restamps the running run (what
    // setCallShareVideo does), and the notice reads the run, not the record.
    await t.run(async (ctx: any) => {
      await ctx.db.patch(first.transcript_id, { share_video_through: Date.now() + 1 });
      await restampRunShare(ctx, await ctx.db.get(first.transcript_id));
    });
    expect((await as(String(ana)).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room).recording_run.video_shared).toBe(true);
  });

  test("a link cleared and claimed again, even with the old token, starts without the video", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id, transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    const comp = (await rows(t))[0];
    world.complete("EG_1", comp.r2_key, Date.now() - 60_000, 30_000);
    await look(t, recording_id);
    const token = "3f5c9a1e-2b3d-4c5e-8f60-718293a4b5c6";
    await t.run(async (ctx: any) => await claimShareToken(ctx, "transcripts", await ctx.db.get(transcript_id), token));
    await as(String(ana)).mutation(api.callRecordings.setCallShareVideo, { call: String(transcript_id), include: true });
    expect((await t.query(api.publicShare.getSharedCall, { share_token: token })).videos).toHaveLength(1);
    await t.run(async (ctx: any) => {
      await claimShareToken(ctx, "transcripts", await ctx.db.get(transcript_id), null);
      await claimShareToken(ctx, "transcripts", await ctx.db.get(transcript_id), token);
    });
    expect((await t.query(api.publicShare.getSharedCall, { share_token: token })).videos).toEqual([]);
    const row = await t.run(async (ctx: any) => await ctx.db.get(transcript_id));
    expect([row.share_video_token, row.share_video_through]).toEqual([undefined, undefined]);
  });
});

describe("a LiveKit plan out of recording minutes", () => {
  test("the first refusal is remembered: later presses are refused before the room is told anything, until LiveKit takes one again", async () => {
    const { t, ana, room, as } = await seed();
    const realFetch = globalThis.fetch;
    let spent = true;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (spent && String(input).includes("StartRoomCompositeEgress")) {
        return new Response(JSON.stringify({ code: "resource_exhausted", msg: "egress minutes exceeded" }), { status: 429 });
      }
      return realFetch(input, init);
    }) as any;
    try {
      await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
      await settle(t);
      expect((await rows(t)).map((r: any) => r.status)).toEqual(["failed"]);
      expect(await events(t)).toEqual(["record_on", "record_off:failed"]);
      expect((await as(String(ana)).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room).recording_unavailable).toMatch(/used its recording minutes/);

      // The next press is refused with the reason, and nobody hears a thing.
      await expect(as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room })).rejects.toThrow(/used its recording minutes/);
      expect(await rows(t)).toHaveLength(1);
      expect(await events(t)).toEqual(["record_on", "record_off:failed"]);

      // The stamp lapses on its own schedule; then a press probes again,
      // and an egress LiveKit accepts clears whatever is remembered.
      spent = false;
      const since = await t.run(async (ctx: any) => (await ctx.db.query("system_config").collect()).find((r: any) => r.key === "call_recording_outage").updated_at);
      await t.mutation(internal.callRecordings.clearRecordingOutage, { since });
      await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
      await settle(t);
      expect((await liveRoom(as, ana, room)).recording_unavailable).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("a refusal that passes", () => {
  const BUSY = "no egress workers available";
  const SPENT = "egress minutes exceeded";
  /** A run pressed with Ana sharing her screen; its room video filming. */
  async function sharing() {
    const ctx = await seed();
    world.setParticipants([screenShare(String(ctx.ana))]);
    const started = await ctx.as(String(ctx.ana)).mutation(api.callRecordings.startRecording, { room_key: ctx.room });
    await settle(ctx.t);
    await quietLoops(ctx.t);
    const comp = (await rows(ctx.t)).find((r: any) => r.kind === "composite");
    world.activate("EG_1", comp.r2_key, Date.now() - 5_000);
    return { ...ctx, ...started };
  }
  const screenRow = async (t: any) => (await rows(t)).find((r: any) => r.kind === "screen");
  /** Let the screen file's retry gap pass. */
  const age = (t: any) =>
    t.run(async (ctx: any) => {
      const r = (await ctx.db.query("call_recordings").collect()).find((x: any) => x.kind === "screen");
      await ctx.db.patch(r._id, { updated_at: Date.now() - 31_000 });
    });

  test("a screen file refused once for capacity gets its file on a later look, on the same row", async () => {
    world.refuse("track", BUSY);
    const { t, recording_id } = await sharing();
    expect(await screenRow(t)).toMatchObject({ status: "failed", stop_reason: "failed" });
    // Not straight away: the loop's beat carries the retry.
    await look(t, recording_id);
    expect((await screenRow(t)).status).toBe("failed");
    await age(t);
    await look(t, recording_id);
    const retried = await screenRow(t);
    expect(retried).toMatchObject({ status: "starting", egress_id: "EG_2", start_attempts: 2, track_sid: "TR_scr" });
    expect(retried.error).toBeUndefined();
    expect(retried.r2_key).toContain("screen-TR_scr-try2");
    expect((await rows(t)).filter((r: any) => r.kind === "screen")).toHaveLength(1);
    expect(await events(t)).toEqual(["record_on"]);
  });

  test("a screen file refused for spent minutes is never asked again", async () => {
    world.refuse("track", SPENT);
    const { t, recording_id } = await sharing();
    expect((await screenRow(t)).error).toMatch(/used its recording minutes/);
    await age(t);
    await look(t, recording_id);
    expect((await screenRow(t)).status).toBe("failed");
    expect(world.starts("track")).toBe(1);
  });

  test("a share that keeps being refused stops after its last try", async () => {
    world.refuse("track", BUSY, BUSY, BUSY, BUSY);
    const { t, recording_id } = await sharing();
    for (let i = 0; i < 4; i++) {
      await age(t);
      await look(t, recording_id);
    }
    expect(await screenRow(t)).toMatchObject({ status: "failed", start_attempts: 3 });
    expect(world.starts("track")).toBe(3);
  });

  test("a room video refused for capacity stays starting and is asked again: the room hears one start, no failure", async () => {
    world.refuse("room", BUSY);
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const waiting = (await rows(t))[0];
    expect(waiting.status).toBe("starting");
    expect(waiting.retry_after).toBeNumber();
    await t.run(async (ctx: any) => await ctx.db.patch(waiting._id, { retry_after: Date.now() - 1 }));
    await look(t, recording_id);
    await settle(t);
    expect((await rows(t))[0]).toMatchObject({ status: "starting", egress_id: "EG_1", start_attempts: 2 });
    expect(await events(t)).toEqual(["record_on"]);
    expect(world.starts("room")).toBe(2);
  });

  test("a screen shared while the room video waits for its retry gets no file until the room video is taken", async () => {
    world.refuse("room", BUSY);
    const { t, ana, room, as } = await seed();
    world.setParticipants([screenShare(String(ana))]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    // Waiting out its gap: a look sees the share and leaves it alone, so the
    // screen file cannot take the slot the room video is waiting for.
    const waiting = (await rows(t))[0];
    expect([waiting.status, waiting.egress_id, typeof waiting.retry_after]).toEqual(["starting", undefined, "number"]);
    await look(t, recording_id);
    expect((await rows(t)).filter((r: any) => r.kind === "screen")).toHaveLength(0);
    expect(world.starts("track")).toBe(0);
    // Once LiveKit takes the room video, the share gets its file.
    await t.run(async (ctx: any) => await ctx.db.patch(recording_id, { retry_after: Date.now() - 1 }));
    await look(t, recording_id);
    await settle(t);
    await look(t, recording_id);
    expect((await rows(t)).find((r: any) => r.kind === "composite")).toMatchObject({ egress_id: "EG_1" });
    expect(world.starts("track")).toBe(1);
  });

  test("a room video refused for spent minutes fails at once, and is remembered", async () => {
    world.refuse("room", SPENT);
    const { t, ana, room, as } = await seed();
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    expect((await rows(t))[0]).toMatchObject({ status: "failed" });
    expect(world.starts("room")).toBe(1);
  });

  test("LiveKit ending a running file for spent minutes is remembered as an outage", async () => {
    const { t, ana, room, as, recording_id } = await sharing();
    world.fail("EG_1", "egress minutes exceeded");
    await look(t, recording_id);
    const comp = (await rows(t)).find((r: any) => r.kind === "composite");
    expect(comp).toMatchObject({ status: "failed", error: expect.stringMatching(/used its recording minutes/) });
    expect((await liveRoom(as, ana, room)).recording_unavailable).toMatch(/used its recording minutes/);
    await expect(as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room })).rejects.toThrow(/used its recording minutes/);
  });
});

describe("the backstops", () => {
  test("the sweep replaces a loop that stopped looking, and the old loop retires", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    expect(await t.mutation(internal.callRecordings.restartStaleLoops, {})).toEqual({ runs: 1, restarted: 0, recent: true });
    await t.run(async (ctx: any) => {
      const [l] = await ctx.db.query("call_recording_loops").collect();
      await ctx.db.patch(l._id, { looked_at: Date.now() - 10 * 60_000 });
    });
    expect(await t.mutation(internal.callRecordings.restartStaleLoops, {})).toEqual({ runs: 1, restarted: 1, recent: true });
    const [loop] = await t.run(async (ctx: any) => await ctx.db.query("call_recording_loops").collect());
    expect(loop.gen).toBe(2);
    // The first loop wakes and finds it was replaced: it asks LiveKit nothing.
    const before = world.calls.length;
    await t.action(internal.callRecordings.reconcileRun, { run_id: recording_id, gen: 1 });
    expect(world.calls.length).toBe(before);
  });

  test("a client flapping its share flag cannot queue looks faster than the gap", async () => {
    const { t, ana, room, as } = await seed();
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    const nudges = async () =>
      (await t.run(async (ctx: any) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
        (f: any) => f.name.includes("reconcileRun") && f.args[0]?.once,
      ).length;
    await t.run(async (ctx: any) => {
      const [l] = await ctx.db.query("call_recording_loops").collect();
      await ctx.db.patch(l._id, { looked_at: Date.now() - 60_000 });
    });
    for (const sharing of [true, false, true, false, true]) await as(String(ana)).mutation(api.calls.heartbeat, { room_key: room, sharing });
    expect(await nudges()).toBe(1);
  });

  // A guest's page beats through guestHeartbeat, not calls.heartbeat. Without
  // the same word, a guest's share waited for the loop's next slow look
  // before its full-size file began (cl-133, 2026-10-05: 9 s of a guest's
  // screen only in the room file).
  test("a guest's share starts the screen file at once, the way a teammate's does", async () => {
    const { t, ana, room, as } = await seed();
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    const nudges = async () =>
      (await t.run(async (ctx: any) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
        (f: any) => f.name.includes("reconcileRun") && f.args[0]?.once,
      ).length;
    await t.run(async (ctx: any) => {
      const [l] = await ctx.db.query("call_recording_loops").collect();
      await ctx.db.patch(l._id, { looked_at: Date.now() - 60_000 });
    });
    const { token } = await as(String(ana)).mutation(api.callGuests.createGuestLink, { room_key: room });
    const riley = await t.mutation(api.callGuests.requestJoin, { token, name: "Riley", accept_notice: true });
    await as(String(ana)).mutation(api.callGuests.admitGuest, { guest_id: riley.guest_id });
    const beat = (extra: { in_media?: boolean; sharing?: boolean }) =>
      t.mutation(api.callGuests.guestHeartbeat, { guest_id: riley.guest_id, secret: riley.secret, ...extra });
    const guestRow = async () => await t.run(async (ctx: any) => await ctx.db.get(riley.guest_id));

    await beat({ in_media: true });
    // A page out of the media cannot be sharing into it.
    await beat({ sharing: true });
    expect(await nudges()).toBe(0);
    await beat({ in_media: true, sharing: true });
    expect(await nudges()).toBe(1);
    expect((await guestRow()).sharing).toBe(true);
    // Still sharing is not a new share.
    await beat({ in_media: true, sharing: true });
    expect(await nudges()).toBe(1);
    await beat({ in_media: true });
    expect((await guestRow()).sharing).toBeUndefined();
  });

  test("a huddle that was filmed but never transcribed stays in the call history", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id, transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t))[0];
    world.activate("EG_1", comp.r2_key, Date.now());
    world.complete("EG_1", comp.r2_key, Date.now(), 60_000);
    await look(t, recording_id);
    await t.run(async (ctx: any) => await ctx.db.patch(transcript_id, { status: "ended", ended_at: Date.now() }));
    const list = await as(String(ana)).query(api.transcripts.webListCalls, {});
    expect(list.map((c: any) => String(c._id))).toContain(String(transcript_id));
  });
});

describe("does the call have video", () => {
  const videoFlag = async (as: any, who: unknown, id: unknown) =>
    (await as(String(who)).query(api.transcripts.webListCalls, {})).find((c: any) => String(c._id) === String(id))?.filmed;

  test("a press LiveKit refused leaves none; a run deleted takes it back, and the glyph and the list agree", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).includes("StartRoomCompositeEgress")) return new Response(JSON.stringify({ code: "unauthenticated", msg: "bad key" }), { status: 401 });
      return realFetch(input, init);
    }) as any;
    const refused = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    // Shown as on its way while LiveKit is being asked.
    expect(await videoFlag(as, ana, refused.transcript_id)).toBe(true);
    await settle(t);
    globalThis.fetch = realFetch;
    expect((await rows(t))[0].status).toBe("failed");
    // The presser may still watch whatever there is (recorded_people), but
    // there is nothing to watch.
    const call = await t.run(async (ctx: any) => await ctx.db.get(refused.transcript_id));
    expect(call.recorded_people.length).toBeGreaterThan(0);
    expect(await videoFlag(as, ana, refused.transcript_id)).toBe(false);

    // A run that films, then is deleted.
    const { recording_id, transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    expect(transcript_id).toBe(refused.transcript_id);
    await settle(t);
    await quietLoops(t);
    const comp = (await rows(t)).find((r: any) => r._id === recording_id);
    world.activate("EG_1", comp.r2_key, Date.now());
    await look(t, recording_id);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    await settle(t);
    world.complete("EG_1", comp.r2_key, Date.now(), 10_000);
    await look(t, recording_id);
    expect(await videoFlag(as, ana, transcript_id)).toBe(true);
    await as(String(ana)).mutation(api.callRecordings.deleteRecording, { recording_id });
    expect(await videoFlag(as, ana, transcript_id)).toBe(false);
    // An ended huddle with nothing said and no video left is no call anybody
    // would look for: the list drops it by the same rule the glyph reads.
    await t.run(async (ctx: any) => await ctx.db.patch(transcript_id, { status: "ended", ended_at: Date.now() }));
    expect(await videoFlag(as, ana, transcript_id)).toBeUndefined();
  });

  test("the backfill counts the files a call already has", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    await t.run(async (ctx: any) => await ctx.db.patch(transcript_id, { video_runs: undefined }));
    expect(await videoFlag(as, ana, transcript_id)).toBe(false);
    await t.mutation(internal.callRecordings.backfillCallVideo, {});
    expect(await videoFlag(as, ana, transcript_id)).toBe(true);
  });
});

// A call belongs to its team, so a recording outlives its presser's account
// and leaves the bucket only when someone deletes its run or the team is
// deleted (teams.retireTeam schedules purgeTeamRecordings past the restore
// window).
describe("a deleted team", () => {
  /** A finished run in the seeded room, plus the manifest LiveKit leaves
   *  beside it under the call's prefix. */
  async function filmed() {
    const s = await seed();
    world.setParticipants([{ identity: String(s.ana), name: "Ana", tracks: [] }]);
    const { recording_id, transcript_id } = await s.as(String(s.ana)).mutation(api.callRecordings.startRecording, { room_key: s.room });
    await settle(s.t);
    await quietLoops(s.t);
    const comp = (await rows(s.t))[0];
    return { ...s, recording_id, transcript_id, comp };
  }
  const finish = async (t: any, recording_id: string, key: string) => {
    world.activate("EG_1", key, Date.now());
    world.complete("EG_1", key, Date.now(), 60_000);
    await look(t, recording_id);
  };
  const retire = (t: any, team: string) => t.run(async (ctx: any) => await ctx.db.patch(team, { deleted_at: Date.now() }));
  const loops = (t: any) => t.run(async (ctx: any) => await ctx.db.query("call_recording_loops").collect());

  test("a team still alive is never swept", async () => {
    const { t, team, recording_id, comp } = await filmed();
    await finish(t, recording_id, comp.r2_key);
    expect(await t.mutation(internal.callRecordings.purgeTeamRecordings, { team_id: team })).toEqual({ purged: 0, waiting: 0, done: true });
    expect(await rows(t)).toHaveLength(1);
    expect(world.objects.has(comp.r2_key)).toBe(true);
  });

  test("retiring a team removes its rows, their loops and everything under the call, manifests included", async () => {
    const { t, team, ana, recording_id, transcript_id, comp } = await filmed();
    await finish(t, recording_id, comp.r2_key);
    const manifest = `calls/${transcript_id}/EG_1.json`;
    world.objects.set(manifest, 200);
    // A frame of it someone shared as a public image goes with it.
    const image = await t.run(async (ctx: any) => ctx.storage.store(new Blob(["png"], { type: "image/png" })));
    await t.run(async (ctx: any) =>
      ctx.db.insert("call_frame_shares", { recording_id, transcript_id, storage_id: image, user_id: ana, created_at: Date.now() }),
    );
    await retire(t, team);
    expect(await t.mutation(internal.callRecordings.purgeTeamRecordings, { team_id: team })).toEqual({ purged: 1, waiting: 0, done: true });
    await settle(t);
    expect(await rows(t)).toHaveLength(0);
    expect(await loops(t)).toHaveLength(0);
    expect(world.objects.has(comp.r2_key)).toBe(false);
    expect(world.objects.has(manifest)).toBe(false);
    expect(await t.run(async (ctx: any) => (await ctx.db.query("call_frame_shares").collect()).length)).toBe(0);
    expect(await t.run(async (ctx: any) => ctx.storage.getUrl(image))).toBeNull();
  });

  test("retiring a team stops what its rooms are recording, and its public link stops serving video", async () => {
    const { t, team, ana, recording_id, transcript_id, comp } = await filmed();
    world.activate("EG_1", comp.r2_key, Date.now() - 5_000);
    await look(t, recording_id);
    const { retireTeam } = await import("./teams");
    await t.run(async (ctx: any) => await retireTeam(ctx, await ctx.db.get(team), ana));
    expect((await rows(t))[0]).toMatchObject({ status: "stopping", stop_reason: "ended" });
    await settle(t);
    expect(world.stops()).toContain("EG_1");
    // A finished video on a link that shares it: gone while the team is.
    world.complete("EG_1", comp.r2_key, Date.now() - 5_000, 60_000);
    await look(t, recording_id);
    const call = await t.run(async (ctx: any) => {
      await ctx.db.patch(transcript_id, { share_token: "tok", share_video_token: "tok" });
      return await ctx.db.get(transcript_id);
    });
    const at = (await rows(t))[0].started_at;
    expect(await t.run(async (ctx: any) => await sharedCallVideoKey(ctx, call, at))).toBeNull();
    await t.run(async (ctx: any) => await ctx.db.patch(team, { deleted_at: undefined }));
    expect(await t.run(async (ctx: any) => await sharedCallVideoKey(ctx, call, at))).toBe(comp.r2_key);
  });

  test("turning calls off for the team stops what its rooms are recording, and the thread says why", async () => {
    const { t, team, recording_id, comp } = await filmed();
    world.activate("EG_1", comp.r2_key, Date.now() - 5_000);
    await look(t, recording_id);
    // Another feature changing touches nothing.
    await t.mutation(internal.teamFeatures.setTeamFeatureInternal, { team_id: team, feature: "org", enabled: true });
    expect((await rows(t))[0].status).toBe("recording");
    await t.mutation(internal.teamFeatures.setTeamFeatureInternal, { team_id: team, feature: "calls", enabled: false });
    expect((await rows(t))[0]).toMatchObject({ status: "stopping", stop_reason: "calls_off" });
    expect((await events(t)).at(-1)).toBe("record_off:calls_off");
    await settle(t);
    expect(world.stops()).toContain("EG_1");
    // Off again is no change: nothing more is said.
    await t.mutation(internal.teamFeatures.setTeamFeatureInternal, { team_id: team, feature: "calls", enabled: false });
    expect((await events(t)).filter((e: string) => e.startsWith("record_off"))).toHaveLength(1);
  });

  test("retiring a team takes its shared pictures down at once, and its public link serves no words", async () => {
    const { t, team, ana, recording_id, transcript_id, comp } = await filmed();
    await finish(t, recording_id, comp.r2_key);
    const image = await t.run(async (ctx: any) => ctx.storage.store(new Blob(["png"], { type: "image/png" })));
    await t.run(async (ctx: any) => {
      await ctx.db.insert("call_frame_shares", { recording_id, transcript_id, storage_id: image, user_id: ana, created_at: Date.now() });
      await ctx.db.patch(transcript_id, { share_token: "4c7c324f-3077-486a-a63c-65f188d18a0c" });
    });
    const shared = () => t.query(api.publicShare.getSharedCall, { share_token: "4c7c324f-3077-486a-a63c-65f188d18a0c" });
    expect(await shared()).not.toBeNull();
    const { retireTeam } = await import("./teams");
    await t.run(async (ctx: any) => await retireTeam(ctx, await ctx.db.get(team), ana));
    await settle(t);
    expect(await t.run(async (ctx: any) => (await ctx.db.query("call_frame_shares").collect()).length)).toBe(0);
    expect(await t.run(async (ctx: any) => ctx.storage.getUrl(image))).toBeNull();
    expect(await shared()).toBeNull();
    // The private file waits out the restore window; the words come back with the team.
    expect(await rows(t)).toHaveLength(1);
    await t.run(async (ctx: any) => await ctx.db.patch(team, { deleted_at: undefined }));
    expect(await shared()).not.toBeNull();
  });

  test("a call still recording is left alone, and one fresh pass comes back for it", async () => {
    const { t, team } = await filmed();
    await retire(t, team);
    expect(await t.mutation(internal.callRecordings.purgeTeamRecordings, { team_id: team })).toEqual({ purged: 0, waiting: 1, done: true });
    expect((await rows(t)).length).toBeGreaterThan(0);
    const again = (await t.run(async (ctx: any) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
      (f: any) => f.name.includes("purgeTeamRecordings") && f.state.kind === "pending",
    );
    expect(again).toHaveLength(1);
    expect(again[0].scheduledTime - Date.now()).toBeGreaterThan(30 * 60_000);
  });
});

// LiveKit says resource_exhausted both for a busy minute and for a plan whose
// egress minutes are spent (seen on prod 2026-10-03); only the first is worth
// another press, so the room is told which one it hit.
describe("orphaned objects", () => {
  test("the rows are read page by page, and every page counts", async () => {
    const { t, room, team, ana } = await seed();
    await t.run(async (ctx: any) => {
      const call = await ctx.db.insert("transcripts", { room_key: room, team_id: team, started_by: ana, status: "ended", started_at: Date.now(), routes: [], last_seq: 0 } as any);
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("call_recordings", {
          transcript_id: call, room_key: room, team_id: team, kind: "composite", status: "ready",
          r2_key: `calls/t${i}/${i}00-composite.mp4`, ...(i === 4 ? { live_frame_key: "calls/t4/400-composite-live.jpeg" } : {}),
          started_by: ana, requested_at: Date.now(), updated_at: Date.now(),
        } as any);
      }
    });
    const pages: number[] = [];
    const accounted = await walkAccountedRecordingObjects(async (args) => {
      const page = await t.query(internal.callRecordings.accountedRecordingObjects, args);
      pages.push(page.keys.length);
      return page;
    }, 2);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(accounted.keys.sort()).toEqual([0, 1, 2, 3, 4].map((i) => `calls/t${i}/${i}00-composite.mp4`).concat("calls/t4/400-composite-live.jpeg").sort());
    expect(accounted.prefixes.sort()).toEqual([0, 1, 2, 3, 4].map((i) => `calls/t${i}/${i}00-`));
  });

  test("what no row accounts for goes once it is old enough, and every LiveKit manifest goes", () => {
    const now = 10 * ORPHAN_OBJECT_GRACE_MS;
    const old = now - ORPHAN_OBJECT_GRACE_MS - 1;
    const fresh = now - 60_000;
    const accounted = { keys: ["calls/t1/100-composite.mp4"], prefixes: ["calls/t1/100-"] };
    const objects = [
      { key: "calls/t1/100-composite.mp4", lastModified: old }, // a row's file
      { key: "calls/t1/100-screen-TR_a.mp4", lastModified: old }, // under a live run's prefix
      { key: "calls/t1/EG_abc.json", lastModified: old }, // a manifest, whoever it belonged to
      { key: "calls/t1/200-composite.mp4", lastModified: old }, // a run deleted, its upload late
      { key: "calls/t2/300-composite-live.jpeg", lastModified: fresh }, // too new to judge
      { key: "calls/t3/400-composite.mp4", lastModified: Number.NaN }, // the listing did not say
    ];
    expect(orphanedRecordingObjects(objects, accounted, now)).toEqual(["calls/t1/EG_abc.json", "calls/t1/200-composite.mp4"]);
  });
});

describe("why a start failed", () => {
  const exhausted = (msg: string) =>
    new LivekitApiError("Egress/StartRoomCompositeEgress", 429, "resource_exhausted", JSON.stringify({ code: "resource_exhausted", msg }));
  test("spent minutes are not a busy minute", () => {
    expect(startFailure(exhausted("egress minutes exceeded"))).toMatchObject({ kind: "minutes_spent", error: expect.stringMatching(/used its recording minutes/) });
    expect(startFailure(exhausted("no egress workers available"))).toMatchObject({ kind: "busy", error: expect.stringMatching(/Try again in a minute/) });
    expect(startFailure(new LivekitApiError("Egress/StartRoomCompositeEgress", 401, "unauthenticated", "")).kind).toBe("credentials");
    expect(startFailure(new Error("boom")).kind).toBe("server");
  });
});

// The pieces the runs above reach only on one path, each pinned on its own.
describe("one rule at a time", () => {
  /** A run pressed and begun: its room file filming, LiveKit's time 0 in. */
  async function filming() {
    const ctx = await seed();
    world.setParticipants([{ identity: String(ctx.ana), name: "Ana", tracks: [] }]);
    const started = await ctx.as(String(ctx.ana)).mutation(api.callRecordings.startRecording, { room_key: ctx.room });
    await settle(ctx.t);
    await quietLoops(ctx.t);
    const comp = (await rows(ctx.t))[0];
    world.activate("EG_1", comp.r2_key, Date.now() - 5_000);
    await look(ctx.t, started.recording_id);
    return { ...ctx, ...started, comp };
  }
  const recordOffs = async (t: any) => (await events(t)).filter((e: string) => e.startsWith("record_off")).length;

  test("watching live: a seat, or a session of your own the call feeds; never a feed of somebody else's session", async () => {
    const { t, ana, ben, cat, transcript_id } = await filming();
    const watch = (u: any) => t.run(async (ctx: any) => mayWatchLive(ctx, u, await ctx.db.get(transcript_id)));
    expect(await watch(ben)).toBe(true);
    // Ben leaves his seat; Ana's session is fed the call. It is in the room
    // in her name, not his.
    await t.run(async (ctx: any) => {
      const seat = (await ctx.db.query("call_members").collect()).find((m: any) => String(m.user_id) === String(ben));
      await ctx.db.patch(seat._id, { last_seen: Date.now() - 10 * 60_000 });
      const conv = await ctx.db.insert("conversations", { user_id: ana, agent_type: "claude_code", started_at: Date.now() } as any);
      await ctx.db.insert("call_agent_feeds", { conversation_id: conv, transcript_id, room_key: (await ctx.db.get(transcript_id)).room_key, added_by: ana } as any);
    });
    expect(await watch(ben)).toBe(false);
    expect(await watch(cat)).toBe(false);
    // Ana's own feed lets her watch even off her seat.
    await t.run(async (ctx: any) => {
      const seat = (await ctx.db.query("call_members").collect()).find((m: any) => String(m.user_id) === String(ana));
      await ctx.db.patch(seat._id, { last_seen: Date.now() - 10 * 60_000 });
    });
    expect(await watch(ana)).toBe(true);
  });

  test("two looks racing to claim one shared screen make one file", async () => {
    const { t, recording_id } = await filming();
    const claim = () => t.mutation(internal.callRecordings.claimScreen, { run_id: recording_id, track_sid: "TR_scr", identity: "u1", name: "Ana" });
    const first = await claim();
    expect(first).not.toBeNull();
    expect(await claim()).toBeNull();
    // Another track of the same run is its own file.
    expect(await t.mutation(internal.callRecordings.claimScreen, { run_id: recording_id, track_sid: "TR_two", identity: "u1", name: "Ana" })).not.toBeNull();
    expect((await rows(t)).filter((r: any) => r.kind === "screen").map((r: any) => r.track_sid).sort()).toEqual(["TR_scr", "TR_two"]);
  });

  test("a file finished while unobserved: ready with the bucket's size, an end only when LiveKit gave none, the room told once", async () => {
    const { t, comp } = await filming();
    const settleIt = (uploaded_at: number) => t.mutation(internal.callRecordings.settleFromObject, { id: comp._id, size_bytes: 999, uploaded_at });
    const row = () => t.run(async (ctx: any) => await ctx.db.get(comp._id));
    const offs = await recordOffs(t);

    // Nothing from LiveKit about its end: the upload's time is the end.
    await settleIt(1_790_000_000_000);
    expect(await row()).toMatchObject({ status: "ready", size_bytes: 999, ended_at: 1_790_000_000_000, stop_reason: "ended" });
    expect(await recordOffs(t)).toBe(offs + 1);

    // LiveKit's own end stays.
    await t.run(async (ctx: any) => ctx.db.patch(comp._id, { status: "recording", ended_at: 42 }));
    await settleIt(1_790_000_000_000);
    expect((await row()).ended_at).toBe(42);

    // Already being stopped: the stop told the room, so this does not again.
    const before = await recordOffs(t);
    await t.run(async (ctx: any) => ctx.db.patch(comp._id, { status: "stopping", stop_reason: "pressed" }));
    await settleIt(1_790_000_000_000);
    expect(await row()).toMatchObject({ status: "ready", stop_reason: "pressed" });
    expect(await recordOffs(t)).toBe(before);

    // A finished row is left alone.
    await settleIt(1);
    expect((await row()).ended_at).toBe(42);
  });

  test("a guest who pressed Stop is named as the room let them in, and only by this room", async () => {
    const { t, ana, team, room, comp } = await filming();
    const now = Date.now();
    const guestIn = async (roomKey: string) =>
      t.run(async (ctx: any) => {
        const link = await ctx.db.insert("call_guest_links", { room_key: roomKey, team_id: team, token: `${roomKey}`.padEnd(24, "t").slice(0, 24), created_by: ana, created_at: now, expires_at: now + 3_600_000 });
        return await ctx.db.insert("call_guests", { link_id: link, room_key: roomKey, team_id: team, name: "Pat", secret_hash: await sha256Hex(GUEST_SECRET), status: "admitted", created_at: now, knocked_at: now, last_seen: now });
      });
    const ended = async (guest: any) => {
      await t.run(async (ctx: any) => ctx.db.patch(comp._id, { status: "ready", stop_reason: "pressed", stopped_by: guestIdentity(String(guest)) }));
      return await t.run(async (ctx: any) => roomRecordingEnd(ctx, room));
    };
    const here = await guestIn(room);
    expect((await ended(here)).stopped_by).toEqual({ id: guestIdentity(String(here)), name: "Pat (guest)" });
    // A guest row of another room never lends its name to this one.
    const elsewhere = await guestIn("channel:elsewhere");
    expect((await ended(elsewhere)).stopped_by?.name).toBe("Guest (guest)");
  });

  test("a share link without the video opens no file", async () => {
    const { t, recording_id, transcript_id, comp } = await filming();
    world.complete("EG_1", comp.r2_key, comp.started_at ?? Date.now() - 5_000, 60_000);
    await look(t, recording_id);
    const done = await t.run(async (ctx: any) => await ctx.db.get(comp._id));
    expect(done.status).toBe("ready");
    const key = (patch: Record<string, unknown>) =>
      t.run(async (ctx: any) => {
        await ctx.db.patch(transcript_id, patch);
        return sharedCallVideoKey(ctx, await ctx.db.get(transcript_id), done.started_at);
      });
    expect(await key({})).toBeNull();
    // Shared, the words only.
    expect(await key({ share_token: "tok" })).toBeNull();
    // A video choice left over from an earlier link does not carry to a new one.
    expect(await key({ share_token: "tok2", share_video_token: "tok" })).toBeNull();
  });

  test("the CLI names an untitled call by its place, never its room key", async () => {
    const { t, ben, team, transcript_id } = await filming();
    const listed = async (id: any) => (await t.query(api.transcripts.cliListCalls, { api_token: TOKEN })).find((r: any) => r._id === id);
    // A people room: the others in it, the reader left out.
    expect((await listed(transcript_id)).place).toEqual({ session_title: null, peer_name: "Ana", channel_name: null });
    expect((await t.query(api.transcripts.cliGetCall, { api_token: TOKEN, transcript_id: String(transcript_id) })).place.peer_name).toBe("Ana");
    // A session's own room: the session's title.
    const sessionCall = await t.run(async (ctx: any) => {
      const conv = await ctx.db.insert("conversations", { user_id: ben, team_id: team, title: "Fix the auth race", agent_type: "claude_code", started_at: Date.now() } as any);
      return await ctx.db.insert("transcripts", { room_key: `session:${conv}`, team_id: team, started_by: ben, status: "ended", started_at: Date.now(), ended_at: Date.now(), routes: [], last_seq: 3 } as any);
    });
    expect((await listed(sessionCall)).place).toEqual({ session_title: "Fix the auth race", peer_name: null, channel_name: null });
  });

  test("the sweep deletes only what is old enough and no row accounts for", async () => {
    const { t, comp } = await filming();
    const old = Date.now() - ORPHAN_OBJECT_GRACE_MS - 60_000;
    const fresh = Date.now() - 60_000;
    for (const [key, at] of [
      [comp.r2_key, old], // a row's file
      ["calls/gone/100-composite.mp4", old], // nobody's
      ["calls/gone/200-composite.mp4", fresh], // nobody's, too new to judge
    ] as const) {
      world.objects.set(key, 1);
      world.modified.set(key, at);
    }
    expect(await t.action(internal.callRecordings.sweepRecordingObjects, {})).toEqual({ listed: 3, deleted: 1, landed: 0 });
    await settle(t);
    expect(world.deletes).toEqual(["calls/gone/100-composite.mp4"]);
  });
});

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
import { CALL_RECORDING_URL_WINDOW_MS, callRecordingUrlWindow, dmRoomKey, guestIdentity, locateCallMoment } from "@codecast/shared/contracts";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { sha256Hex } from "./lib/hash";
import { signForCli, signingMoment } from "./callRecordings";
import { EGRESS_BEGIN_TIMEOUT_MS } from "./lib/callRecordingRuns";

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
  "./transcripts.ts": () => import("./transcripts"),
  "./callChat.ts": () => import("./callChat"),
  "./publicShare.ts": () => import("./publicShare"),
  "./dispatch.ts": () => import("./dispatch"),
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
  // What is in the bucket: key to size.
  const objects = new Map<string, number>();
  let participants: any[] = [];
  let n = 0;
  // The start request reaches LiveKit, which starts the egress, but its
  // answer never comes back (a timeout, a dropped connection).
  let loseStartAnswers = false;
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
        return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`, { status: 200 });
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
    stops: () => calls.filter((c) => c.method === "Egress/StopEgress").map((c) => c.body.egress_id),
    setParticipants: (p: any[]) => (participants = p),
    loseStartAnswers: (on: boolean) => (loseStartAnswers = on),
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
    const state = await as(String(ana)).query(api.callRecordings.getRoomRecording, { room_key: room });
    expect(state).toMatchObject({ configured: true, live: { status: "starting", started_by: { id: String(ana), name: "Ana" }, started_at: null } });
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

  test("a press right after a stop waits for the file to save", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    await expect(as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room })).rejects.toThrow(/still saving/);
    // A moment later it is a new run.
    await t.run(async (ctx: any) => {
      for (const r of await ctx.db.query("call_recordings").collect()) await ctx.db.patch(r._id, { updated_at: Date.now() - 10_000 });
    });
    expect((await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room })).existing).toBe(false);
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
    const live = await as(String(ben)).query(api.callRecordings.getRoomRecording, { room_key: room });
    expect(live.live).toMatchObject({ status: "recording", started_at: c0, call_short_id: call.short_id });
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
    const whileStopping = await as(String(ana)).query(api.callRecordings.getRoomRecording, { room_key: room });
    expect(whileStopping.live.status).toBe("stopping");
    // Stopped and saving: the room is no longer being filmed (the flag), and
    // the run says so, which is what keeps every mark off REC meanwhile.
    const listed1 = (await as(String(ana)).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room);
    expect([listed1.recording, listed1.recording_run.status]).toEqual([false, "stopping"]);
    // How it ended, for the room's notice: still being finished, stopped by Ben.
    expect(whileStopping.ended).toEqual({
      run_id: recording_id,
      status: "stopping",
      stop_reason: "pressed",
      error: null,
      stopped_by: { id: String(ben), name: "Ben" },
    });
    await settle(t);
    expect(world.stops().sort()).toEqual(["EG_1", "EG_2"]);

    // LiveKit finishes and uploads; the live frames go with the live call.
    world.complete("EG_1", comp0.r2_key, c0, 120_000);
    world.complete("EG_2", scr0.r2_key, s0, 40_000);
    await look(t, recording_id);
    await settle(t);
    const after = await as(String(ana)).query(api.callRecordings.getRoomRecording, { room_key: room });
    expect(after.live).toBeNull();
    expect(after.ended).toMatchObject({ run_id: recording_id, status: "ready", stop_reason: "pressed" });
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
    const next = await as(String(ana)).query(api.callRecordings.webCallRecordings, { call: String(transcript_id), url_window: win + 1 });
    expect(next.recordings[0].url).not.toBe(read.recordings[0].url);

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
    expect(await as(String(cat)).query(api.callRecordings.getRoomRecording, { room_key: room })).toBeNull();
  });

  test("a page cannot sign further than a window from now, whatever window it asks for", () => {
    const now = 100 * CALL_RECORDING_URL_WINDOW_MS + 5;
    expect(signingMoment(100, now)).toBe(100 * CALL_RECORDING_URL_WINDOW_MS);
    expect(signingMoment(10_000, now)).toBe(now + CALL_RECORDING_URL_WINDOW_MS);
    expect(signingMoment(1, now)).toBe(now - CALL_RECORDING_URL_WINDOW_MS);
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
    // LiveKit's room holding nobody for the empty-room window is the end.
    world.setParticipants([]);
    await look(t, recording_id, { empty_since: Date.now() - 31_000 });
    const [row] = await rows(t);
    expect(row).toMatchObject({ status: "stopping", stop_reason: "huddle_ended" });
    expect(row.stopped_by).toBeUndefined();
    // Nobody pressed it: the line says the room emptied, on the presser's row.
    expect(await events(t)).toEqual(["record_on", "record_off:huddle_ended"]);
    expect(String((await eventRows(t))[1].user_id)).toBe(String(ana));
  });

  test("a room LiveKit shows holding only a guest stops like an empty one", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await quietLoops(t);
    world.setParticipants([{ identity: guestIdentity("g1"), name: "Dana", tracks: [] }]);
    await look(t, recording_id, { empty_since: Date.now() - 31_000 });
    expect((await rows(t))[0]).toMatchObject({ status: "stopping", stop_reason: "huddle_ended" });
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
    const state = await as(String(ana)).query(api.callRecordings.getRoomRecording, { room_key: room });
    expect(state.live).toBeNull();
    expect(state.ended).toEqual({ run_id: String(row._id), status: "failed", stop_reason: "failed", error: row.error, stopped_by: null });
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
    expect((await rows(t))[0]).toMatchObject({ status: "ready", size_bytes: 777, ended_at: 1_790_000_000_000 });
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
    const state = await as(String(ana)).query(api.callRecordings.getRoomRecording, { room_key: room });
    expect(state.live.started_by.name).toBe("ana-gh");
  });
});

describe("who may watch and delete", () => {
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
    const deleted = (await eventRows(t)).find((r: any) => r.event === "record_deleted");
    expect(deleted).toMatchObject({ transcript_id: call });
    expect(String(deleted.user_id)).toBe(String(ben));
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
});

describe("the backstops", () => {
  test("the sweep replaces a loop that stopped looking, and the old loop retires", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    expect(await t.mutation(internal.callRecordings.restartStaleLoops, {})).toEqual({ runs: 1, restarted: 0 });
    await t.run(async (ctx: any) => {
      const [l] = await ctx.db.query("call_recording_loops").collect();
      await ctx.db.patch(l._id, { looked_at: Date.now() - 10 * 60_000 });
    });
    expect(await t.mutation(internal.callRecordings.restartStaleLoops, {})).toEqual({ runs: 1, restarted: 1 });
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

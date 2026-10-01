// The recording backend driven end to end through convex-test, against a fake
// LiveKit (Twirp over fetch) and a fake R2 that answers presigned DELETEs.
// What it pins: who may press, stop, read and delete; that a press in a room
// with no call record makes one; the exact egress requests (private bucket,
// the row's key, a screen at its own size); how LiveKit's answers land on the
// rows; that the room is told (thread events, live state); and that the
// files a reader gets line up with the transcript's clock.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { dmRoomKey, locateCallMoment } from "@codecast/shared/contracts";
import schema from "./schema";
import { hashToken } from "./apiTokens";

// The first test pays for loading the calls module graph.
setDefaultTimeout(60_000);

const api = anyApi as any;
const internal = anyApi as any;
const TOKEN = "r".repeat(64);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./callRecordings.ts": () => import("./callRecordings"),
  "./calls.ts": () => import("./calls"),
  "./transcripts.ts": () => import("./transcripts"),
  "./callChat.ts": () => import("./callChat"),
};

const ENV: Record<string, string> = {
  LIVEKIT_URL: "wss://lk.test",
  LIVEKIT_API_KEY: "APIk",
  LIVEKIT_API_SECRET: "secret",
  R2_ENDPOINT: "https://acct.r2.test",
  CALL_REC_R2_BUCKET: "codecast-call-recordings",
  CALL_REC_R2_ACCESS_KEY_ID: "rec-key",
  CALL_REC_R2_SECRET_ACCESS_KEY: "rec-secret",
};
const saved: Record<string, string | undefined> = {};

// ── A fake LiveKit ────────────────────────────────────────────────────────

type FakeEgress = { egress_id: string; room_name: string; status: string; request: any; file_results: any[]; error?: string };
const NS = (ms: number) => String(ms * 1e6);

function fakeWorld() {
  const egresses = new Map<string, FakeEgress>();
  const calls: Array<{ method: string; body: any }> = [];
  const deletes: string[] = [];
  let participants: any[] = [];
  let n = 0;
  const realFetch = globalThis.fetch;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const info = (e: FakeEgress) => ({ egress_id: e.egress_id, room_name: e.room_name, status: e.status, file_results: e.file_results, ...(e.error ? { error: e.error } : {}) });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (init?.method === "DELETE" && url.startsWith(ENV.R2_ENDPOINT)) {
      deletes.push(new URL(url).pathname);
      return new Response(null, { status: 204 });
    }
    const m = url.match(/\/twirp\/livekit\.(\w+\/\w+)$/);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(init?.body ?? "{}");
    calls.push({ method: m[1], body });
    switch (m[1]) {
      case "Egress/StartRoomCompositeEgress":
      case "Egress/StartTrackCompositeEgress": {
        const e: FakeEgress = { egress_id: `EG_${++n}`, room_name: body.room_name, status: "EGRESS_STARTING", request: body, file_results: [] };
        egresses.set(e.egress_id, e);
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
        const e = egresses.get(body.egress_id);
        if (!e) return json(404, { code: "not_found", msg: "egress not found" });
        return json(200, { items: [info(e)] });
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
    setParticipants: (p: any[]) => (participants = p),
    activate(id: string, filename: string, startedAt: number) {
      const e = egresses.get(id)!;
      e.status = "EGRESS_ACTIVE";
      e.file_results = [{ filename, started_at: NS(startedAt) }];
    },
    complete(id: string, filename: string, startedAt: number, durationMs: number) {
      const e = egresses.get(id)!;
      e.status = "EGRESS_COMPLETE";
      e.file_results = [{ filename, started_at: NS(startedAt), ended_at: NS(startedAt + durationMs), duration: NS(durationMs), size: "123456" }];
    },
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

let world: ReturnType<typeof fakeWorld>;
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  world = fakeWorld();
});
afterEach(() => {
  world.restore();
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ── A team, a room, two people in it, one outsider ────────────────────────

async function seed() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x", features: { calls: true } } as any);
    const other = await ctx.db.insert("teams", { name: "O", created_at: now, invite_code: "y", features: { calls: true } } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
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

/** Let what was just scheduled at 0 run (startRun, stopEgresses). */
async function settle(t: any) {
  await new Promise((r) => setTimeout(r, 30));
  await t.finishInProgressScheduledFunctions();
}

const rows = (t: any) => t.run(async (ctx: any) => await ctx.db.query("call_recordings").collect());
const events = (t: any) =>
  t.run(async (ctx: any) => (await ctx.db.query("call_chat_messages").collect()).filter((r: any) => r.event).map((r: any) => r.event));

describe("pressing Record", () => {
  test("someone in the huddle starts it; the room has a call record and is told", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([
      { identity: String(ana), name: "Ana", tracks: [{ sid: "TR_scr", type: "VIDEO", source: "SCREEN_SHARE", width: 2880, height: 1800 }] },
      { identity: "EG_1", kind: "EGRESS", tracks: [] },
    ]);
    const res = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    expect(res.existing).toBe(false);

    // Transcription never ran in this room: the press made the call record.
    const call = await t.run(async (ctx: any) => await ctx.db.get(res.transcript_id));
    expect(call).toMatchObject({ room_key: room, status: "live", started_by: ana });
    expect(call.short_id).toMatch(/^cl-\d+$/);

    // Shown on this round trip, before LiveKit has answered.
    const state = await as(String(ana)).query(api.callRecordings.getRoomRecording, { room_key: room });
    expect(state).toMatchObject({ configured: true, live: { status: "starting", started_by: { id: String(ana), name: "Ana" }, started_at: null } });
    expect(await events(t)).toEqual(["record_on"]);

    await settle(t);
    const composite = world.calls.find((c) => c.method === "Egress/StartRoomCompositeEgress")!.body;
    const [row] = (await rows(t)).filter((r: any) => r.kind === "composite");
    expect(composite.room_name).toBe(room);
    expect(composite.file_outputs[0].filepath).toBe(row.r2_key);
    expect(row.r2_key).toBe(`calls/${res.transcript_id}/${row.requested_at}-composite.mp4`);
    // The private bucket, and only it.
    expect(composite.file_outputs[0].s3).toMatchObject({ bucket: "codecast-call-recordings", access_key: "rec-key", force_path_style: true });
    expect(row.egress_id).toBe("EG_1");

    // Ana's share got its own file at her screen's size; LiveKit's recorder did not.
    const track = world.calls.filter((c) => c.method === "Egress/StartTrackCompositeEgress");
    expect(track).toHaveLength(1);
    expect(track[0].body).toMatchObject({ video_track_id: "TR_scr", advanced: { width: 2880, height: 1800, framerate: 15, key_frame_interval: 1 } });
    const [screen] = (await rows(t)).filter((r: any) => r.kind === "screen");
    expect(screen).toMatchObject({ run_id: row._id, participant_identity: String(ana), participant_name: "Ana", status: "starting", egress_id: "EG_2" });
    expect(screen.r2_key).toBe(`calls/${res.transcript_id}/${row.requested_at}-screen-TR_scr.mp4`);

    // A second press, by anyone, is the same recording.
    const again = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    expect(again).toEqual({ recording_id: res.recording_id, transcript_id: res.transcript_id, existing: true });
    expect(await events(t)).toEqual(["record_on"]);
  });

  test("nobody outside the huddle can press it, and a missing setup says so", async () => {
    const { t, ana, cat, room, as } = await seed();
    await expect(as(String(cat)).mutation(api.callRecordings.startRecording, { room_key: room })).rejects.toThrow(/Cannot record this room/);
    await t.run(async (ctx: any) => {
      for (const m of await ctx.db.query("call_members").collect()) if (String(m.user_id) === String(ana)) await ctx.db.delete(m._id);
    });
    await expect(as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room })).rejects.toThrow(/Only someone in the huddle/);
    delete process.env.CALL_REC_R2_BUCKET;
    const ben = (await t.run(async (ctx: any) => (await ctx.db.query("users").collect()).find((u: any) => u.name === "Ben")._id)) as string;
    await expect(as(String(ben)).mutation(api.callRecordings.startRecording, { room_key: room })).rejects.toThrow(/not set up/);
    expect(await rows(t)).toEqual([]);
  });
});

describe("a run, start to finish", () => {
  test("LiveKit's file times land, anyone stops it, the finished files line up with the transcript", async () => {
    const { t, ana, ben, cat, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [{ sid: "TR_scr", type: "VIDEO", source: "SCREEN_SHARE", width: 1920, height: 1080 }] }]);
    const { recording_id, transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
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
    await t.action(internal.callRecordings.reconcileRun, { run_id: recording_id, once: true });
    const live = await as(String(ben)).query(api.callRecordings.getRoomRecording, { room_key: room });
    expect(live.live).toMatchObject({ status: "recording", started_at: c0, call_short_id: call.short_id });

    // Ben, who did not press it, stops it.
    expect(await as(String(ben)).mutation(api.callRecordings.stopRecording, { room_key: room })).toEqual({ stopped: 2 });
    const stopping = await rows(t);
    expect(stopping.map((r: any) => [r.kind, r.status, r.stop_reason, r.stopped_by])).toEqual([
      ["composite", "stopping", "pressed", String(ben)],
      ["screen", "stopping", "pressed", String(ben)],
    ]);
    expect(await events(t)).toEqual(["record_on", "record_off"]);
    expect((await as(String(ana)).query(api.callRecordings.getRoomRecording, { room_key: room })).live.status).toBe("stopping");
    await settle(t);
    expect(world.calls.filter((c) => c.method === "Egress/StopEgress").map((c) => c.body.egress_id).sort()).toEqual(["EG_1", "EG_2"]);

    // LiveKit finishes and uploads.
    world.complete("EG_1", comp0.r2_key, c0, 120_000);
    world.complete("EG_2", scr0.r2_key, s0, 40_000);
    await t.action(internal.callRecordings.reconcileRun, { run_id: recording_id, once: true });
    expect((await as(String(ana)).query(api.callRecordings.getRoomRecording, { room_key: room })).live).toBeNull();

    const read = await as(String(ana)).query(api.callRecordings.webCallRecordings, { call: call.short_id, url_window: 1 });
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
    // The URL is the same on every read inside one window.
    const again = await as(String(ana)).query(api.callRecordings.webCallRecordings, { call: String(transcript_id), url_window: 1 });
    expect(again.recordings.map((r: any) => r.url)).toEqual(read.recordings.map((r: any) => r.url));

    // The transcript's clock lands on the files: a line 20s into the call is
    // 15s into the room's video, 12s into Ana's screen.
    const spans = read.recordings.map((r: any) => ({ ...r, id: r._id }));
    expect(locateCallMoment({ callStartedAt: read.call_started_at, atMs: 20_000, recordings: spans })).toMatchObject({ ok: true, recording: { kind: "composite" }, offsetMs: 15_000 });
    expect(locateCallMoment({ callStartedAt: read.call_started_at, atMs: 20_000, recordings: spans, prefer: "screen" })).toMatchObject({ ok: true, recording: { kind: "screen" }, offsetMs: 12_000 });

    // The CLI reads the same through its token; an outsider reads nothing.
    const cli = await t.query(api.callRecordings.cliCallRecordings, { api_token: TOKEN, call: call.short_id });
    expect(cli.recordings.map((r: any) => r.url)).toEqual(read.recordings.map((r: any) => r.url));
    expect(await as(String(cat)).query(api.callRecordings.webCallRecordings, { call: call.short_id })).toBeNull();
    expect(await as(String(cat)).query(api.callRecordings.getRoomRecording, { room_key: room })).toBeNull();
  });

  test("the last person leaving stops the recording", async () => {
    const { t, ana, ben, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await as(String(ana)).mutation(api.calls.leaveRoom, { room_key: room });
    expect((await rows(t))[0].status).toBe("starting");
    await as(String(ben)).mutation(api.calls.leaveRoom, { room_key: room });
    const [row] = await rows(t);
    expect(row).toMatchObject({ status: "stopping", stop_reason: "huddle_ended" });
    expect(row.stopped_by).toBeUndefined();
    // Nobody pressed it, so nobody is credited in the thread.
    expect(await events(t)).toEqual(["record_on"]);
  });

  test("stopped before LiveKit wrote a frame: the run leaves nothing behind", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    await as(String(ana)).mutation(api.callRecordings.stopRecording, { room_key: room });
    await settle(t);
    const e = world.egresses.get("EG_1")!;
    e.status = "EGRESS_ABORTED";
    e.error = "Start signal not received";
    await t.action(internal.callRecordings.reconcileRun, { run_id: recording_id, once: true });
    expect(await rows(t)).toEqual([]);
  });

  test("a LiveKit refusal is a failed row that says what happened", async () => {
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
    // A failed press frees the room to try again.
    expect((await as(String(ana)).query(api.callRecordings.getRoomRecording, { room_key: room })).live).toBeNull();
  });
});

describe("deleting", () => {
  test("only the presser or the call's owner, only once stopped, rows now and files right after", async () => {
    const { t, ana, ben, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [{ sid: "TR_scr", type: "VIDEO", source: "SCREEN_SHARE", width: 1920, height: 1080 }] }]);
    // Ben presses, but the call record is Ana's (she transcribes).
    const call = await t.run(async (ctx: any) =>
      await ctx.db.insert("transcripts", { room_key: room, team_id: (await ctx.db.query("teams").first())._id, started_by: ana, status: "live", started_at: Date.now(), routes: [], last_seq: 0, short_id: "cl-7" } as any),
    );
    const { recording_id, transcript_id } = await as(String(ben)).mutation(api.callRecordings.startRecording, { room_key: room });
    expect(transcript_id).toBe(call);
    await settle(t);
    await expect(as(String(ben)).mutation(api.callRecordings.deleteRecording, { recording_id })).rejects.toThrow(/Stop the recording/);

    const all = await rows(t);
    const comp = all.find((r: any) => r.kind === "composite");
    const scr = all.find((r: any) => r.kind === "screen");
    await as(String(ben)).mutation(api.callRecordings.stopRecording, { room_key: room });
    await settle(t);
    world.complete("EG_1", comp.r2_key, Date.now(), 10_000);
    world.complete("EG_2", scr.r2_key, Date.now(), 5_000);
    await t.action(internal.callRecordings.reconcileRun, { run_id: recording_id, once: true });

    // Ana owns the call; Ben pressed; both may. A third teammate may not.
    const dee = await t.run(async (ctx: any) => {
      const u = await ctx.db.insert("users", { name: "Dee" } as any);
      await ctx.db.insert("team_memberships", { user_id: u, team_id: (await ctx.db.query("teams").first())._id, role: "member", joined_at: Date.now() } as any);
      return u;
    });
    const asDee = await as(String(dee)).query(api.callRecordings.webCallRecordings, { call: "cl-7" });
    // Dee is not in this DM, so she cannot read it at all: one error for both.
    expect(asDee).toBeNull();
    await expect(as(String(dee)).mutation(api.callRecordings.deleteRecording, { recording_id })).rejects.toThrow(/Recording not found/);
    const seen = await as(String(ana)).query(api.callRecordings.webCallRecordings, { call: "cl-7" });
    expect(seen.recordings.every((r: any) => r.can_delete)).toBe(true);

    // Deleting a screen file deletes its whole run.
    expect(await as(String(ana)).mutation(api.callRecordings.deleteRecording, { recording_id: scr._id })).toEqual({ deleted: 2 });
    expect(await rows(t)).toEqual([]);
    await settle(t);
    expect(world.deletes.sort()).toEqual([`/codecast-call-recordings/${comp.r2_key}`, `/codecast-call-recordings/${scr.r2_key}`].sort());
  });
});

describe("the backstops", () => {
  test("the sweep restarts the loop of a run nobody has looked at", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    expect(await t.mutation(internal.callRecordings.sweepStaleRecordings, {})).toEqual({ runs: 1, restarted: 0 });
    await t.run(async (ctx: any) => await ctx.db.patch(recording_id, { requested_at: Date.now() - 10 * 60_000, polled_at: undefined }));
    expect(await t.mutation(internal.callRecordings.sweepStaleRecordings, {})).toEqual({ runs: 1, restarted: 1 });
  });

  test("a huddle that was filmed but never transcribed stays in the call history", async () => {
    const { t, ana, room, as } = await seed();
    world.setParticipants([{ identity: String(ana), name: "Ana", tracks: [] }]);
    const { recording_id, transcript_id } = await as(String(ana)).mutation(api.callRecordings.startRecording, { room_key: room });
    await settle(t);
    const comp = (await rows(t))[0];
    world.activate("EG_1", comp.r2_key, Date.now());
    world.complete("EG_1", comp.r2_key, Date.now(), 60_000);
    await t.action(internal.callRecordings.reconcileRun, { run_id: recording_id, once: true });
    await t.run(async (ctx: any) => await ctx.db.patch(transcript_id, { status: "ended", ended_at: Date.now() }));
    const list = await as(String(ana)).query(api.transcripts.webListCalls, {});
    expect(list.map((c: any) => String(c._id))).toContain(String(transcript_id));
  });
});

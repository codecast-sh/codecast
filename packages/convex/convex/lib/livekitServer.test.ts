import { afterEach, describe, expect, test } from "bun:test";
import {
  egressS3Upload,
  listEgressRequest,
  livekitHttpBase,
  livekitTwirp,
  LivekitApiError,
  parseEgressInfo,
  parseParticipant,
  recordingFieldsFromEgress,
  recordingStatusFromEgress,
  removeParticipant,
  roomCompositeEgressRequest,
  screenShareTracks,
  stopEgress,
  trackCompositeEgressRequest,
} from "./livekitServer";

const cfg = { url: "wss://lk.example", apiKey: "APIkey", apiSecret: "secret" };
const bucket = { endpoint: "https://acct.r2.cloudflarestorage.com", accessKeyId: "rk", secretAccessKey: "rs", bucket: "codecast-call-recordings" };
const upload = egressS3Upload(bucket);
const jwtPayload = (token: string) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function recordFetch(reply: (url: string) => { status?: number; body: unknown }) {
  const sent: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: string, init: any) => {
    sent.push({ url, init });
    const r = reply(url);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as any;
  return sent;
}

describe("request bodies", () => {
  test("R2 as LiveKit's S3 upload: region auto, path style", () => {
    expect(upload).toEqual({ access_key: "rk", secret: "rs", region: "auto", endpoint: bucket.endpoint, bucket: "codecast-call-recordings", force_path_style: true });
  });

  test("the room composite is one MP4, speaker layout at 1080p unless told otherwise", () => {
    expect(roomCompositeEgressRequest({ room: "dm:a:b", filepath: "calls/t1/composite-1.mp4", upload })).toEqual({
      room_name: "dm:a:b",
      layout: "speaker",
      audio_only: false,
      preset: "H264_1080P_30",
      file_outputs: [{ file_type: "MP4", filepath: "calls/t1/composite-1.mp4", disable_manifest: true, s3: upload }],
    });
    expect(roomCompositeEgressRequest({ room: "r", filepath: "f", upload, layout: "grid", preset: "H264_720P_30" })).toMatchObject({ layout: "grid", preset: "H264_720P_30" });
  });

  test("a track composite takes either a preset or the share's own size", () => {
    expect(trackCompositeEgressRequest({ room: "r", videoTrackSid: "TR_v", filepath: "f.mp4", upload })).toEqual({
      room_name: "r",
      video_track_id: "TR_v",
      preset: "H264_1080P_30",
      file_outputs: [{ file_type: "MP4", filepath: "f.mp4", disable_manifest: true, s3: upload }],
    });
    const sized = trackCompositeEgressRequest({ room: "r", videoTrackSid: "TR_v", audioTrackSid: "TR_a", filepath: "f.mp4", upload, advanced: { width: 2880, height: 1800, framerate: 15 } });
    expect(sized).toMatchObject({ audio_track_id: "TR_a", advanced: { width: 2880, height: 1800, framerate: 15 } });
    expect("preset" in sized).toBe(false);
  });

  test("a live frame is one JPEG rewritten in place, uploaded beside the file", () => {
    const frame = { prefix: "calls/t1/1-screen-TR_v-live", intervalSeconds: 2, width: 2880, height: 1800 };
    expect(trackCompositeEgressRequest({ room: "r", videoTrackSid: "TR_v", filepath: "f.mp4", upload, liveFrame: frame }).image_outputs).toEqual([
      { capture_interval: 2, width: 2880, height: 1800, filename_prefix: frame.prefix, filename_suffix: "IMAGE_SUFFIX_NONE_OVERWRITE", disable_manifest: true, s3: upload },
    ]);
    // No size: LiveKit's own (the composite's 1080p).
    expect(roomCompositeEgressRequest({ room: "r", filepath: "f", upload, liveFrame: { prefix: "p", intervalSeconds: 2 } }).image_outputs?.[0]).not.toHaveProperty("width");
    expect(roomCompositeEgressRequest({ room: "r", filepath: "f", upload })).not.toHaveProperty("image_outputs");
  });

  test("listing names only what it filters by", () => {
    expect(listEgressRequest()).toEqual({});
    expect(listEgressRequest({ room: "r", active: true })).toEqual({ room_name: "r", active: true });
    expect(listEgressRequest({ egressId: "EG_1", active: false })).toEqual({ egress_id: "EG_1" });
  });
});

describe("answers", () => {
  // The shape LiveKit Cloud sends: snake_case, int64 as strings, ns times,
  // enum names.
  const complete = {
    egress_id: "EG_abc",
    room_id: "RM_1",
    room_name: "dm:a:b",
    status: "EGRESS_COMPLETE",
    started_at: "1727000000123456789",
    ended_at: "1727000600000000000",
    file_results: [
      {
        filename: "calls/t1/composite-1.mp4",
        started_at: "1727000001000000000",
        ended_at: "1727000600000000000",
        duration: "599000000000",
        size: "48211234",
        location: "https://acct.r2.cloudflarestorage.com/codecast-call-recordings/calls/t1/composite-1.mp4",
      },
    ],
  };

  test("times come back in ms, sizes as numbers", () => {
    expect(parseEgressInfo(complete)).toEqual({
      egressId: "EG_abc",
      roomName: "dm:a:b",
      status: "complete",
      startedAtMs: 1727000000123,
      endedAtMs: 1727000600000,
      error: undefined,
      files: [
        {
          filename: "calls/t1/composite-1.mp4",
          location: complete.file_results[0].location,
          startedAtMs: 1727000001000,
          endedAtMs: 1727000600000,
          durationMs: 599000,
          sizeBytes: 48211234,
        },
      ],
      paths: ["calls/t1/composite-1.mp4"],
    });
  });

  test("an egress names every path it writes, asked for or reported", () => {
    // Running, before any file result: only the request knows the path.
    const running = parseEgressInfo({
      egress_id: "EG_2",
      status: "EGRESS_ACTIVE",
      room_composite: { room_name: "r", file_outputs: [{ filepath: "calls/t1/1-composite.mp4" }] },
    });
    expect(running.paths).toEqual(["calls/t1/1-composite.mp4"]);
    const track = parseEgressInfo({ egress_id: "EG_3", track_composite: { fileOutputs: [{ filepath: "calls/t1/1-screen-TR_x.mp4" }] }, file_results: [{ filename: "calls/t1/1-screen-TR_x.mp4" }] });
    expect(track.paths).toEqual(["calls/t1/1-screen-TR_x.mp4"]);
    expect(parseEgressInfo({ egress_id: "EG_4", track: { file: { filepath: "x/y" } } }).paths).toEqual(["x/y"]);
  });

  test("a status left out is the zero value, numbers and camelCase read too", () => {
    expect(parseEgressInfo({ egress_id: "EG_1" }).status).toBe("starting");
    expect(parseEgressInfo({ egressId: "EG_1", status: 1, startedAt: 1727000000000000000 })).toMatchObject({ egressId: "EG_1", status: "active", startedAtMs: 1727000000000 });
    // Zero means "not yet", not the epoch.
    expect(parseEgressInfo({ egress_id: "EG_1", started_at: "0", ended_at: 0 })).toMatchObject({ startedAtMs: undefined, endedAtMs: undefined });
  });

  test("a single deprecated `file` stands in for file_results", () => {
    expect(parseEgressInfo({ egress_id: "EG_1", status: "EGRESS_COMPLETE", file: { filename: "x.webm", duration: "1000000" } }).files).toEqual([
      { filename: "x.webm", location: undefined, startedAtMs: undefined, endedAtMs: undefined, durationMs: 1, sizeBytes: undefined },
    ]);
  });

  test("LiveKit's states map onto a recording's", () => {
    const f = [{ filename: "x.mp4" }];
    expect(recordingStatusFromEgress({ status: "starting", files: [] })).toBe("starting");
    expect(recordingStatusFromEgress({ status: "active", files: [] })).toBe("recording");
    expect(recordingStatusFromEgress({ status: "ending", files: [] })).toBe("stopping");
    expect(recordingStatusFromEgress({ status: "complete", files: f })).toBe("ready");
    expect(recordingStatusFromEgress({ status: "limit_reached", files: f })).toBe("ready");
    expect(recordingStatusFromEgress({ status: "complete", files: [] })).toBe("failed");
    expect(recordingStatusFromEgress({ status: "aborted", files: f })).toBe("failed");
    expect(recordingStatusFromEgress(parseEgressInfo({ status: "EGRESS_SOMETHING_NEW" }))).toBe("failed");
  });

  test("a recording row takes the file's own time 0, and its length only once it is final", () => {
    // From a real composite (2026-10-02): the egress was taken 5s before its
    // first frame, so the egress start must never stand in for the file's.
    expect(recordingFieldsFromEgress(parseEgressInfo(complete))).toEqual({
      status: "ready",
      r2_key: "calls/t1/composite-1.mp4",
      started_at: 1727000001000,
      ended_at: 1727000600000,
      duration_ms: 599000,
      size_bytes: 48211234,
    });
    const live = parseEgressInfo({ egress_id: "EG_1", status: "EGRESS_ACTIVE", started_at: "1727000000000000000", file: { filename: "calls/t1/screen-TR_x.webm", started_at: "1727000002000000000" } });
    expect(recordingFieldsFromEgress(live)).toEqual({ status: "recording", r2_key: "calls/t1/screen-TR_x.webm", started_at: 1727000002000 });
    expect(recordingFieldsFromEgress(parseEgressInfo({ egress_id: "EG_1", status: "EGRESS_STARTING" }))).toEqual({ status: "starting" });
    // The real answer for a composite stopped in an empty room.
    const aborted = parseEgressInfo({
      egress_id: "EG_z",
      status: "EGRESS_ABORTED",
      error: "Start signal not received",
      file_results: [],
      file: { filename: "probe/x.mp4", started_at: "1790933862746968202", ended_at: "1790933862746968202", duration: "0", size: "0", location: "" },
    });
    expect(recordingFieldsFromEgress(aborted)).toEqual({ status: "failed", r2_key: "probe/x.mp4", started_at: 1790933862747, ended_at: 1790933862747, error: "Start signal not received" });
  });

  test("participants and the screens they share", () => {
    const ana = parseParticipant({
      sid: "PA_1",
      identity: "u_ana",
      name: "Ana",
      state: "ACTIVE",
      joined_at: "1727000000",
      tracks: [
        { sid: "TR_mic", type: "AUDIO", source: "MICROPHONE" },
        { sid: "TR_scr", type: "VIDEO", source: "SCREEN_SHARE", width: 2880, height: 1800, mime_type: "video/VP8" },
        { sid: "TR_scra", type: "AUDIO", source: "SCREEN_SHARE_AUDIO" },
      ],
    });
    expect(ana).toMatchObject({ identity: "u_ana", state: "active", joinedAtMs: 1727000000000 });
    expect(ana.tracks[1]).toEqual({ sid: "TR_scr", type: "video", source: "screen_share", name: undefined, width: 2880, height: 1800, muted: false, mimeType: "video/VP8" });
    const guest = parseParticipant({ identity: "guest:g1", name: "Ben", joined_at_ms: "1727000000500", tracks: [{ sid: "TR_cam", type: 1, source: 1 }] });
    expect(guest.joinedAtMs).toBe(1727000000500);
    expect(screenShareTracks([ana, guest])).toEqual([{ identity: "u_ana", name: "Ana", trackSid: "TR_scr", width: 2880, height: 1800 }]);
  });
});

describe("the wire", () => {
  test("one POST to the Twirp path, with a minute-long token carrying the grant", async () => {
    const sent = recordFetch(() => ({ body: { items: [] } }));
    await livekitTwirp(cfg, "Egress/ListEgress", { room_name: "r" }, { room: "r", grant: { roomRecord: true } });
    expect(sent[0].url).toBe("https://lk.example/twirp/livekit.Egress/ListEgress");
    expect(JSON.parse(sent[0].init.body)).toEqual({ room_name: "r" });
    const claims = jwtPayload(sent[0].init.headers.authorization.slice("Bearer ".length));
    expect(claims).toMatchObject({ iss: "APIkey", sub: "codecast-server", video: { room: "r", roomRecord: true } });
    expect(claims.video.roomJoin).toBeUndefined();
    expect(claims.exp - claims.nbf).toBe(70);
    // A hung LiveKit cannot hold the caller: every request is bounded.
    expect(sent[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test("an error carries Twirp's code", async () => {
    recordFetch(() => ({ status: 404, body: { code: "not_found", msg: "requested room does not exist" } }));
    const err = await livekitTwirp(cfg, "RoomService/ListParticipants", {}, { grant: { roomAdmin: true } }).catch((e) => e);
    expect(err).toBeInstanceOf(LivekitApiError);
    expect(err).toMatchObject({ status: 404, code: "not_found" });
    expect(err.message).toContain("RoomService/ListParticipants: 404");
  });

  test("stopping what already stopped, and removing who already left, are not failures", async () => {
    recordFetch(() => ({ status: 412, body: { code: "failed_precondition", msg: "egress already ended" } }));
    expect(await stopEgress(cfg, "EG_1")).toBeNull();
    recordFetch(() => ({ status: 404, body: { code: "not_found", msg: "participant not found" } }));
    expect(await removeParticipant(cfg, "r", "guest:g1")).toBeUndefined();
    recordFetch(() => ({ status: 500, body: { code: "internal", msg: "boom" } }));
    expect(await stopEgress(cfg, "EG_1").catch((e) => e.code)).toBe("internal");
  });

  test("the API origin follows the client URL", () => {
    expect(livekitHttpBase("wss://x.livekit.cloud/")).toBe("https://x.livekit.cloud");
    expect(livekitHttpBase("ws://localhost:7880")).toBe("http://localhost:7880");
  });
});

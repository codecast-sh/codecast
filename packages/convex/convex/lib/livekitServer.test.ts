import { afterEach, describe, expect, test } from "bun:test";
import {
  egressS3Upload,
  listEgressRequest,
  livekitHttpBase,
  livekitTwirp,
  LivekitApiError,
  parseEgressInfo,
  parseParticipant,
  recordingStatusFromEgress,
  removeParticipant,
  roomCompositeEgressRequest,
  screenShareTracks,
  stopEgress,
  trackCompositeEgressRequest,
  trackEgressRequest,
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
      file_outputs: [{ file_type: "MP4", filepath: "calls/t1/composite-1.mp4", s3: upload }],
    });
    expect(roomCompositeEgressRequest({ room: "r", filepath: "f", upload, layout: "grid", preset: "H264_720P_30" })).toMatchObject({ layout: "grid", preset: "H264_720P_30" });
  });

  test("a screen track is recorded as published, one file per track", () => {
    expect(trackEgressRequest({ room: "r", trackSid: "TR_x", filepath: "calls/t1/screen-TR_x", upload })).toEqual({
      room_name: "r",
      track_id: "TR_x",
      file: { filepath: "calls/t1/screen-TR_x", s3: upload },
    });
  });

  test("a track composite takes either a preset or the share's own size", () => {
    expect(trackCompositeEgressRequest({ room: "r", videoTrackSid: "TR_v", filepath: "f.mp4", upload })).toEqual({
      room_name: "r",
      video_track_id: "TR_v",
      preset: "H264_1080P_30",
      file_outputs: [{ file_type: "MP4", filepath: "f.mp4", s3: upload }],
    });
    const sized = trackCompositeEgressRequest({ room: "r", videoTrackSid: "TR_v", audioTrackSid: "TR_a", filepath: "f.mp4", upload, advanced: { width: 2880, height: 1800, framerate: 15 } });
    expect(sized).toMatchObject({ audio_track_id: "TR_a", advanced: { width: 2880, height: 1800, framerate: 15 } });
    expect("preset" in sized).toBe(false);
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
    });
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

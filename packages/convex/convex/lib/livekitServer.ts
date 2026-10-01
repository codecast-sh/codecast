// LiveKit's server API, spoken directly: Twirp over JSON, a POST to
// `<host>/twirp/livekit.<Service>/<Method>` with a bearer JWT whose video
// grant says what the caller may do. No server SDK, for the same reason the
// participant tokens have none (livekitJwt.ts): the Convex runtime would pay
// for a Node dependency to send a handful of JSON requests.
//
// Two halves, kept apart so the first can be tested without a network:
//   building   pure functions that return the exact request body each method
//              takes, and parsers that read LiveKit's answers into plain
//              shapes with ms timestamps
//   calling    `livekitTwirp` and thin wrappers that send one request each
//
// What LiveKit sends back is protobuf's JSON mapping, which differs from what
// one would guess in three ways the parsers absorb: fields arrive snake_case
// (`egress_id`, `file_results`); int64 fields arrive as STRINGS
// ("1727000000123456789"), and egress times are NANOseconds; enums arrive as
// their names ("EGRESS_ACTIVE"), or as numbers from older servers, and a field
// at its zero value may be left out entirely (so a missing status is
// STARTING, not unknown). Requests may be written either case; these builders
// write snake_case to match what comes back.

import type { CallRecordingStatus } from "@codecast/shared/contracts";
import { signLivekitJwt } from "./livekitJwt";
import type { R2Bucket } from "./r2";

export type LivekitServerConfig = { url: string; apiKey: string; apiSecret: string };

/** The project's server credentials, or null when calling is not configured. */
export function livekitConfigFromEnv(): LivekitServerConfig | null {
  const url = process.env.LIVEKIT_URL, apiKey = process.env.LIVEKIT_API_KEY, apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

/** The HTTP origin of a LiveKit URL (clients are given wss://, the API is https://). */
export function livekitHttpBase(url: string): string {
  return url.replace(/^ws/, "http").replace(/\/+$/, "");
}

export type LivekitService = "RoomService" | "Egress" | "AgentDispatchService";

/** The video grant a server request carries. RoomService methods on one room
 *  want roomAdmin (with that room named), listing rooms wants roomList, and
 *  every Egress method wants roomRecord. */
export type LivekitServerGrant = { roomAdmin?: boolean; roomRecord?: boolean; roomList?: boolean; roomCreate?: boolean };

/** An error LiveKit answered with. `code` is Twirp's ("not_found",
 *  "failed_precondition", "invalid_argument"...), so a caller can tell an
 *  egress that already ended from a real failure. */
export class LivekitApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly code: string | null,
    body: string,
  ) {
    super(`LiveKit ${method}: ${status} ${body.slice(0, 300)}`);
    this.name = "LivekitApiError";
  }
}

/** One Twirp call. The token lives a minute: it authorizes this request and
 *  nothing after it. */
export async function livekitTwirp<T = any>(
  cfg: LivekitServerConfig,
  method: `${LivekitService}/${string}`,
  body: unknown,
  auth: { room?: string; grant: LivekitServerGrant },
): Promise<T> {
  const token = await signLivekitJwt({
    apiKey: cfg.apiKey,
    apiSecret: cfg.apiSecret,
    identity: "codecast-server",
    name: "codecast",
    room: auth.room ?? "",
    grant: auth.grant as Record<string, boolean>,
    ttlSeconds: 60,
  });
  const res = await fetch(`${livekitHttpBase(cfg.url)}/twirp/livekit.${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) {
    let code: string | null = null;
    try {
      const parsed = JSON.parse(text);
      code = typeof parsed?.code === "string" ? parsed.code : null;
    } catch {}
    throw new LivekitApiError(method, res.status, code, text);
  }
  return (text ? JSON.parse(text) : null) as T;
}

// ── Egress: request bodies ────────────────────────────────────────────────

/** Where an egress uploads its file: an S3 bucket, which R2 is with region
 *  "auto" and path-style addressing (R2 has no per-bucket hostnames under a
 *  custom endpoint). */
export function egressS3Upload(b: R2Bucket) {
  return {
    access_key: b.accessKeyId,
    secret: b.secretAccessKey,
    region: "auto",
    endpoint: b.endpoint,
    bucket: b.bucket,
    force_path_style: true,
  };
}

/** The room as people saw it, to one MP4. "speaker" is LiveKit's layout that
 *  gives a screen share the stage and the faces a strip, which is the
 *  meeting a person wants to rewatch; 1080p because the share is the thing
 *  most worth reading. */
export function roomCompositeEgressRequest(opts: {
  room: string;
  filepath: string;
  upload: ReturnType<typeof egressS3Upload>;
  layout?: "speaker" | "grid" | "single-speaker";
  preset?: string;
  audioOnly?: boolean;
}) {
  return {
    room_name: opts.room,
    layout: opts.layout ?? "speaker",
    audio_only: opts.audioOnly ?? false,
    preset: opts.preset ?? "H264_1080P_30",
    file_outputs: [{ file_type: "MP4", filepath: opts.filepath, s3: opts.upload }],
  };
}

/** One track exactly as it was published, with no transcode: a screen share
 *  at the sharer's own resolution and codec. The container follows the codec
 *  (VP8/VP9 to WebM, H.264 to MP4); a filepath without an extension gets the
 *  right one from LiveKit, and the file result names what was written. */
export function trackEgressRequest(opts: { room: string; trackSid: string; filepath: string; upload: ReturnType<typeof egressS3Upload> }) {
  return {
    room_name: opts.room,
    track_id: opts.trackSid,
    file: { filepath: opts.filepath, s3: opts.upload },
  };
}

/** One video track (and optionally one audio track) transcoded to an MP4.
 *  The alternative to a raw track egress when the file must be H.264/MP4;
 *  pass `advanced` to keep a share's resolution rather than a preset's. */
export function trackCompositeEgressRequest(opts: {
  room: string;
  videoTrackSid: string;
  audioTrackSid?: string;
  filepath: string;
  upload: ReturnType<typeof egressS3Upload>;
  preset?: string;
  advanced?: { width: number; height: number; framerate?: number; video_codec?: string; key_frame_interval?: number };
}) {
  return {
    room_name: opts.room,
    video_track_id: opts.videoTrackSid,
    ...(opts.audioTrackSid ? { audio_track_id: opts.audioTrackSid } : {}),
    ...(opts.advanced ? { advanced: opts.advanced } : { preset: opts.preset ?? "H264_1080P_30" }),
    file_outputs: [{ file_type: "MP4", filepath: opts.filepath, s3: opts.upload }],
  };
}

export function stopEgressRequest(egressId: string) {
  return { egress_id: egressId };
}

export function listEgressRequest(opts: { room?: string; egressId?: string; active?: boolean } = {}) {
  return {
    ...(opts.room ? { room_name: opts.room } : {}),
    ...(opts.egressId ? { egress_id: opts.egressId } : {}),
    ...(opts.active ? { active: true } : {}),
  };
}

// ── Egress: answers ───────────────────────────────────────────────────────

export const LIVEKIT_EGRESS_STATUSES = ["starting", "active", "ending", "complete", "failed", "aborted", "limit_reached"] as const;
export type LivekitEgressStatus = (typeof LIVEKIT_EGRESS_STATUSES)[number];

export type LivekitEgressFile = {
  /** The object key in the bucket (the filepath, with any template and
   *  extension LiveKit filled in). */
  filename: string;
  location?: string;
  startedAtMs?: number;
  endedAtMs?: number;
  durationMs?: number;
  sizeBytes?: number;
};

export type LivekitEgress = {
  egressId: string;
  roomName: string;
  status: LivekitEgressStatus;
  startedAtMs?: number;
  endedAtMs?: number;
  /** LiveKit's reason when it failed, aborted or hit a limit. */
  error?: string;
  files: LivekitEgressFile[];
};

const pick = (o: any, snake: string, camel: string) => (o?.[snake] !== undefined ? o[snake] : o?.[camel]);

/** An int64 as JSON gives it (string or number), or undefined for zero and
 *  absent: LiveKit writes 0 for "not yet". */
function int64(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}
const nsToMs = (value: unknown) => {
  const n = int64(value);
  return n === undefined ? undefined : Math.round(n / 1e6);
};

/** An enum as JSON gives it: its name (with or without the type's prefix) or
 *  its number. Absent is the zero value. */
function enumOf<T extends string>(value: unknown, names: readonly T[], prefix = ""): T | undefined {
  if (value === undefined || value === null) return names[0];
  if (typeof value === "number") return names[value];
  const s = String(value).toLowerCase();
  const bare = prefix && s.startsWith(prefix) ? s.slice(prefix.length) : s;
  return (names as readonly string[]).includes(bare) ? (bare as T) : undefined;
}

export function parseEgressFile(raw: any): LivekitEgressFile {
  return {
    filename: String(raw?.filename ?? ""),
    location: raw?.location || undefined,
    startedAtMs: nsToMs(pick(raw, "started_at", "startedAt")),
    endedAtMs: nsToMs(pick(raw, "ended_at", "endedAt")),
    durationMs: nsToMs(raw?.duration),
    sizeBytes: int64(raw?.size),
  };
}

export function parseEgressInfo(raw: any): LivekitEgress {
  // A finished egress lists its files in file_results; older servers and
  // track egress may answer with the single deprecated `file` instead.
  const results = pick(raw, "file_results", "fileResults");
  const files = (Array.isArray(results) && results.length ? results : raw?.file ? [raw.file] : []).map(parseEgressFile);
  return {
    egressId: String(pick(raw, "egress_id", "egressId") ?? ""),
    roomName: String(pick(raw, "room_name", "roomName") ?? ""),
    status: enumOf(raw?.status, LIVEKIT_EGRESS_STATUSES, "egress_") ?? "failed",
    startedAtMs: nsToMs(pick(raw, "started_at", "startedAt")),
    endedAtMs: nsToMs(pick(raw, "ended_at", "endedAt")),
    error: raw?.error || undefined,
    files,
  };
}

/** What a recording row should say given LiveKit's view of its egress. A
 *  complete egress with no file is a failure: there is nothing to watch. */
export function recordingStatusFromEgress(e: Pick<LivekitEgress, "status" | "files">): CallRecordingStatus {
  switch (e.status) {
    case "starting":
      return "starting";
    case "active":
      return "recording";
    case "ending":
      return "stopping";
    case "complete":
    case "limit_reached":
      return e.files.some((f) => f.filename) ? "ready" : "failed";
    default:
      return "failed";
  }
}

// ── Rooms and participants ────────────────────────────────────────────────

export function listParticipantsRequest(room: string) {
  return { room };
}

export function removeParticipantRequest(room: string, identity: string) {
  return { room, identity };
}

const TRACK_TYPES = ["audio", "video", "data"] as const;
const TRACK_SOURCES = ["unknown", "camera", "microphone", "screen_share", "screen_share_audio"] as const;
const PARTICIPANT_STATES = ["joining", "joined", "active", "disconnected"] as const;

export type LivekitTrack = {
  sid: string;
  type: (typeof TRACK_TYPES)[number] | undefined;
  source: (typeof TRACK_SOURCES)[number] | undefined;
  name?: string;
  width?: number;
  height?: number;
  muted: boolean;
  mimeType?: string;
};

export type LivekitParticipant = {
  sid: string;
  identity: string;
  name: string;
  state: (typeof PARTICIPANT_STATES)[number] | undefined;
  joinedAtMs?: number;
  metadata?: string;
  tracks: LivekitTrack[];
};

export function parseParticipant(raw: any): LivekitParticipant {
  const joinedMs = int64(pick(raw, "joined_at_ms", "joinedAtMs"));
  const joinedS = int64(pick(raw, "joined_at", "joinedAt"));
  return {
    sid: String(raw?.sid ?? ""),
    identity: String(raw?.identity ?? ""),
    name: String(raw?.name ?? ""),
    state: enumOf(raw?.state, PARTICIPANT_STATES),
    joinedAtMs: joinedMs ?? (joinedS !== undefined ? joinedS * 1000 : undefined),
    metadata: raw?.metadata || undefined,
    tracks: (Array.isArray(raw?.tracks) ? raw.tracks : []).map(
      (t: any): LivekitTrack => ({
        sid: String(t?.sid ?? ""),
        type: enumOf(t?.type, TRACK_TYPES),
        source: enumOf(t?.source, TRACK_SOURCES),
        name: t?.name || undefined,
        width: int64(t?.width),
        height: int64(t?.height),
        muted: !!t?.muted,
        mimeType: pick(t, "mime_type", "mimeType") || undefined,
      }),
    ),
  };
}

/** Every screen being shared in a room right now: the tracks a screen
 *  recording follows. Screen audio is not a screen. */
export function screenShareTracks(participants: readonly LivekitParticipant[]): Array<{ identity: string; name: string; trackSid: string; width?: number; height?: number }> {
  return participants.flatMap((p) =>
    p.tracks
      .filter((t) => t.source === "screen_share" && t.type === "video" && t.sid)
      .map((t) => ({ identity: p.identity, name: p.name, trackSid: t.sid, width: t.width, height: t.height })),
  );
}

// ── Calling ───────────────────────────────────────────────────────────────

const RECORD = { roomRecord: true };

export async function startRoomCompositeEgress(cfg: LivekitServerConfig, req: ReturnType<typeof roomCompositeEgressRequest>): Promise<LivekitEgress> {
  return parseEgressInfo(await livekitTwirp(cfg, "Egress/StartRoomCompositeEgress", req, { room: req.room_name, grant: RECORD }));
}

export async function startTrackEgress(cfg: LivekitServerConfig, req: ReturnType<typeof trackEgressRequest>): Promise<LivekitEgress> {
  return parseEgressInfo(await livekitTwirp(cfg, "Egress/StartTrackEgress", req, { room: req.room_name, grant: RECORD }));
}

export async function startTrackCompositeEgress(cfg: LivekitServerConfig, req: ReturnType<typeof trackCompositeEgressRequest>): Promise<LivekitEgress> {
  return parseEgressInfo(await livekitTwirp(cfg, "Egress/StartTrackCompositeEgress", req, { room: req.room_name, grant: RECORD }));
}

/** Stop an egress. One that has already ended answers with an error LiveKit
 *  calls failed_precondition (or not_found once it is forgotten); both mean
 *  the stop already happened, so they return null instead of throwing. */
export async function stopEgress(cfg: LivekitServerConfig, egressId: string): Promise<LivekitEgress | null> {
  try {
    return parseEgressInfo(await livekitTwirp(cfg, "Egress/StopEgress", stopEgressRequest(egressId), { grant: RECORD }));
  } catch (e) {
    if (e instanceof LivekitApiError && (e.code === "failed_precondition" || e.code === "not_found")) return null;
    throw e;
  }
}

export async function listEgress(cfg: LivekitServerConfig, opts: { room?: string; egressId?: string; active?: boolean } = {}): Promise<LivekitEgress[]> {
  const res = await livekitTwirp(cfg, "Egress/ListEgress", listEgressRequest(opts), { room: opts.room, grant: RECORD });
  return (Array.isArray(res?.items) ? res.items : []).map(parseEgressInfo);
}

/** One egress by id, or null when LiveKit no longer knows it (asked for by
 *  id, an unknown egress is a not_found error rather than an empty list). */
export async function getEgress(cfg: LivekitServerConfig, egressId: string): Promise<LivekitEgress | null> {
  try {
    return (await listEgress(cfg, { egressId })).find((e) => e.egressId === egressId) ?? null;
  } catch (e) {
    if (e instanceof LivekitApiError && e.code === "not_found") return null;
    throw e;
  }
}

/** Who is in a room. A room nobody is in has closed, and LiveKit answers
 *  not_found for it: that is an empty room, not an error. */
export async function listParticipants(cfg: LivekitServerConfig, room: string): Promise<LivekitParticipant[]> {
  try {
    const res = await livekitTwirp(cfg, "RoomService/ListParticipants", listParticipantsRequest(room), { room, grant: { roomAdmin: true } });
    return (Array.isArray(res?.participants) ? res.participants : []).map(parseParticipant);
  } catch (e) {
    if (e instanceof LivekitApiError && e.code === "not_found") return [];
    throw e;
  }
}

/** Put a participant out of a room. Someone already gone is not an error:
 *  the outcome the caller wanted is true either way. */
export async function removeParticipant(cfg: LivekitServerConfig, room: string, identity: string): Promise<void> {
  try {
    await livekitTwirp(cfg, "RoomService/RemoveParticipant", removeParticipantRequest(room, identity), { room, grant: { roomAdmin: true } });
  } catch (e) {
    if (e instanceof LivekitApiError && e.code === "not_found") return;
    throw e;
  }
}

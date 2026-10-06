import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getFunctionName } from "convex/server";
import {
  appendRecordingSegments,
  appendSegments,
  asrTranscriptionSession,
  attachRecording,
  beat,
  cliHoldCall,
  fedSessionPacing,
  finishRecordingTranscript,
  flush,
  HOLD_MAX_MS,
  sessionDeliveryVerdict,
  start,
  stop,
  ROLLING_SUMMARY_GAP_MS,
  ROLLING_SUMMARY_MIN_WORDS,
  huddleDigestTarget,
  needsServerTranscription,
  ownRoomTarget,
  parseTranscriptionSegments,
  recLeaseExpired,
  setRecordingScope,
  setSummary,
  generateSummary,
  getForSummary,
  callSummaryKind,
  callSummaryRequest,
  callSummarySource,
  withDefaultRoutes,
  linkExcerpt,
  markRouteSent,
  webCallsForConversation,
  webGetCall,
  webGetCallRef,
  writeSegments,
  backfillCallShortIds,
  webListCalls,
  webCallPlaces,
  endTranscript,
  HUDDLE_GRACE_MS,
  deliverRoutes,
  deliverToSession,
  deliveryClientId,
  dropDeadRoute,
  readUnsent,
  CATCH_UP_QUIET_MS,
  DELIVER_RETRY_MAX,
  DELIVER_RETRY_MS,
} from "./transcripts";
import { LIVE_TRANSCRIBE_MODEL, lineSaidAt } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";
import { captureFetch, goldenBody, recordGolden, type GoldenCase } from "./__golden__/golden.testkit";
import { characterOf } from "@codecast/shared/contracts/sessionCharacter";
import { hashToken } from "./apiTokens";
import {
  CALL_MEMBER_STALE_MS,
  MAX_RECORDING_MS,
  REC_LEASE_STALE_MS,
  RECORDING_BYTES_PER_SECOND,
  TRANSCRIBE_MAX_BYTES,
} from "@codecast/shared/contracts";

// A recording is the one live transcript with nobody seated in a room, and the
// orphan sweep has to tell that apart from a huddle everybody left. Getting it
// wrong is not subtle: the sweep runs every two minutes, so a recording would
// end itself in the middle of the meeting it was recording.
describe("recLeaseExpired", () => {
  const now = 1_800_000_000_000;

  test("a recording beating right now is not an orphan", () => {
    expect(recLeaseExpired({ started_at: now - 3_600_000, last_beat: now - 1_000 }, now)).toBe(false);
  });

  test("a recording that has not beaten yet is measured from its start", () => {
    // The first beat is fifteen seconds in; a tab that died before it still
    // has to be swept, and a recording that just began must not be.
    expect(recLeaseExpired({ started_at: now - 5_000 }, now)).toBe(false);
    expect(recLeaseExpired({ started_at: now - REC_LEASE_STALE_MS - 1 }, now)).toBe(true);
  });

  test("a locked-phone recording outlives a seat's 45 second window", () => {
    // Locking the phone freezes JS heartbeats. A seat-sized lease would end
    // the transcript a minute in while native capture was still running.
    expect(recLeaseExpired({ started_at: now - CALL_MEMBER_STALE_MS - 1 }, now)).toBe(false);
    expect(recLeaseExpired({ started_at: 0, last_beat: now - CALL_MEMBER_STALE_MS }, now)).toBe(false);
  });

  test("the window is the recording lease, so a missed beat of that length is an orphan", () => {
    expect(recLeaseExpired({ started_at: 0, last_beat: now - REC_LEASE_STALE_MS + 1 }, now)).toBe(false);
    expect(recLeaseExpired({ started_at: 0, last_beat: now - REC_LEASE_STALE_MS }, now)).toBe(true);
  });
});

// The two rec-only mutations must refuse a huddle transcript even from its own
// starter. A huddle's transcript is shared: an audio blob attached by one seat
// would publish that seat's microphone on the whole room's detail page, and a
// lease beaten onto it would teach the orphan sweep to trust a field huddles
// never maintain.
describe("rec-only mutations refuse huddle transcripts", () => {
  const huddle = (over: Record<string, unknown> = {}) => ({
    _id: "t1",
    room_key: "dm:ua:ub",
    team_id: "team1",
    started_by: "ua",
    status: "live",
    started_at: 1_000,
    routes: [],
    last_seq: 0,
    ...over,
  });
  const ctx = (rows: any[]) => {
    const scheduled: { delay: number; name: string; args: any }[] = [];
    return {
      db: makeFakeDb({ transcripts: rows, transcript_segments: [] }),
      auth: {
        async getUserIdentity() {
          return { subject: "ua|session" };
        },
      },
      scheduler: {
        async runAfter(delay: number, reference: unknown, args: any) {
          scheduled.push({ delay, name: getFunctionName(reference as any), args });
        },
      },
      _scheduled: scheduled,
    };
  };
  const call = (fn: any, c: any, args: any) => (fn as any)._handler(c, args);

  test("attachRecording refuses the huddle's own starter", async () => {
    await expect(
      call(attachRecording, ctx([huddle()]), { transcript_id: "t1", storage_id: "s1" }),
    ).rejects.toThrow("Not a recording");
  });

  test("attachRecording lands on a rec transcript, even after it ended", async () => {
    const rec = huddle({ room_key: "rec:9f8e7d6c-1234-4abc-9def-0123456789ab", status: "ended" });
    const c = ctx([rec]);
    await call(attachRecording, c, { transcript_id: "t1", storage_id: "s1" });
    expect((await c.db.get("t1" as any)).recording_storage_id).toBe("s1");
  });

  test("beat refuses a huddle transcript", async () => {
    await expect(call(beat, ctx([huddle()]), { transcript_id: "t1" })).rejects.toThrow(
      "Not a recording",
    );
  });

  test("stopping an already-ended recording moves ended_at to now", async () => {
    const rec = huddle({
      room_key: "rec:9f8e7d6c-1234-4abc-9def-0123456789ab",
      status: "ended",
      started_at: 1_000,
      ended_at: 1_000,
    });
    const c = ctx([rec]);
    const before = Date.now();
    await call(stop, c, { transcript_id: "t1" });
    const t = await c.db.get("t1" as any);
    expect(t.ended_at).toBeGreaterThanOrEqual(before);
    expect(t.status).toBe("ended");
  });

  test("stopping an already-ended huddle leaves ended_at alone", async () => {
    const c = ctx([huddle({ status: "ended", started_at: 1_000, ended_at: 2_000 })]);
    await call(stop, c, { transcript_id: "t1" });
    expect((await c.db.get("t1" as any)).ended_at).toBe(2_000);
  });

  test("live recording appends do not invent a Speaker participant", async () => {
    const rec = huddle({
      room_key: "rec:9f8e7d6c-1234-4abc-9def-0123456789ab",
      status: "live",
    });
    const c = ctx([rec]);
    await call(appendSegments, c, {
      transcript_id: "t1",
      segments: [
        { speaker_id: "mic", speaker_name: "Speaker", text: "hello", t0: 0, t1: 1000 },
      ],
    });
    expect((await c.db.get("t1" as any)).participants).toBeUndefined();
  });
});

// ── The phone recorder's server side ──────────────────────────────────────

const REC_KEY = "rec:9f8e7d6c-1234-4abc-9def-0123456789ab";

// The trigger is the whole feature. Too loose and a recording is transcribed
// twice (two API bills, a doubled transcript); too tight and a phone recording
// is silently wordless forever, which is the one outcome nobody can debug from
// the app.
describe("needsServerTranscription", () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    room_key: REC_KEY,
    status: "ended",
    last_seq: 0,
    ...over,
  });

  test("an ended recording with no words needs the server to read them", () => {
    expect(needsServerTranscription(rec())).toBe(true);
  });

  test("a recording still running is left to whatever is recognizing it", () => {
    expect(needsServerTranscription(rec({ status: "live" }))).toBe(false);
  });

  test("a recording that already has words is never transcribed twice", () => {
    // The desktop recorder streams to the live recognizer, so its transcript
    // arrives full. Paying to read the same audio again would also append a
    // second copy of every line.
    expect(needsServerTranscription(rec({ last_seq: 42 }))).toBe(false);
  });

  test("a huddle is never a candidate, however empty it ended", () => {
    expect(needsServerTranscription(rec({ room_key: "dm:ua:ub" }))).toBe(false);
  });
});

// Somebody else's JSON becoming our rows. The shape is documented but not
// guaranteed, and the degraded reply (words, no segments) is the one that
// would otherwise throw away a whole meeting's transcript.
describe("parseTranscriptionSegments", () => {
  test("verbose_json segments become rows with millisecond bounds", () => {
    const out = parseTranscriptionSegments(
      {
        text: "Morning everyone. Let us start.",
        segments: [
          { id: 0, start: 0, end: 1.44, text: " Morning everyone." },
          { id: 1, start: 1.44, end: 3.2, text: " Let us start." },
        ],
      },
      99_000,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ text: "Morning everyone.", t0: 0, t1: 1440 });
    expect(out[1]).toMatchObject({ text: "Let us start.", t0: 1440, t1: 3200 });
    // One microphone, one label, and no name invented for anybody in the room.
    expect(new Set(out.map((s) => s.speaker_name))).toEqual(new Set(["Speaker"]));
  });

  test("a reply with words but no segments still lands, spanning the recording", () => {
    const out = parseTranscriptionSegments({ text: "  just the words  " }, 12_000);
    expect(out).toEqual([
      { speaker_id: "mic", speaker_name: "Speaker", text: "just the words", t0: 0, t1: 12_000 },
    ]);
  });

  test("blank segments are dropped rather than written as empty lines", () => {
    const out = parseTranscriptionSegments(
      { text: "hello", segments: [{ start: 0, end: 1, text: "   " }, { start: 1, end: 2, text: "hello" }] },
      5_000,
    );
    expect(out).toEqual([
      { speaker_id: "mic", speaker_name: "Speaker", text: "hello", t0: 1000, t1: 2000 },
    ]);
  });

  test("silence transcribes to nothing, and nothing is not a segment", () => {
    expect(parseTranscriptionSegments({ text: "   " }, 1_000)).toEqual([]);
    expect(parseTranscriptionSegments({}, 1_000)).toEqual([]);
    expect(parseTranscriptionSegments(null, 1_000)).toEqual([]);
  });

  test("a segment whose end precedes its start never writes a backwards span", () => {
    const out = parseTranscriptionSegments(
      { segments: [{ start: 5, end: 2, text: "garbled" }] },
      0,
    );
    expect(out[0].t0).toBe(5000);
    expect(out[0].t1).toBe(5000);
  });

});

// The huddle coming back in Japanese was auto-detect with no allowlist.
// The mint is the only place the live recognizer is configured, so the
// languages the room actually uses have to be on this object.
describe("asrTranscriptionSession", () => {
  test("sends the allowlist the live recognizer may not leave", () => {
    const session = asrTranscriptionSession(LIVE_TRANSCRIBE_MODEL, ["en", "ja"]);
    expect(session.audio.input.transcription).toEqual({
      model: LIVE_TRANSCRIBE_MODEL,
      languages: ["en", "ja"],
    });
  });

  test("omits languages when the caller did not name any", () => {
    const session = asrTranscriptionSession(LIVE_TRANSCRIBE_MODEL);
    expect(session.audio.input.transcription).toEqual({
      model: LIVE_TRANSCRIBE_MODEL,
    });
  });
});

// attachRecording is where the whole server-side path is armed. These drive
// the real mutation handler over the real fake db.
describe("attachRecording arms the transcription", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    _id: "t1",
    room_key: REC_KEY,
    team_id: "team1",
    started_by: "ua",
    status: "ended",
    started_at: 1_000,
    routes: [],
    last_seq: 0,
    ...over,
  });
  const ctx = (rows: any[]) => {
    const scheduled: { name: string; args: any }[] = [];
    return {
      db: makeFakeDb({ transcripts: rows }),
      auth: { async getUserIdentity() { return { subject: "ua|session" }; } },
      scheduler: {
        async runAfter(_d: number, reference: unknown, args: any) {
          scheduled.push({ name: getFunctionName(reference as any), args });
        },
      },
      _scheduled: scheduled,
    };
  };
  const call = (fn: any, c: any, args: any) => (fn as any)._handler(c, args);

  test("an empty finished recording is queued for transcription", async () => {
    const c = ctx([row()]);
    await call(attachRecording, c, { transcript_id: "t1", storage_id: "s1" });
    expect(c._scheduled.map((s) => s.name)).toEqual(["transcripts:transcribeRecording"]);
    const t = await c.db.get("t1" as any);
    expect(t.transcribe_status).toBe("pending");
    // `stop` already summarized an empty transcript and got "skipped" for it.
    // Leaving that on screen would say the meeting had nothing in it while the
    // words were still being fetched.
    expect(t.summary_status).toBe("pending");
  });

  test("a recording that already has its words is only given the audio", async () => {
    const c = ctx([row({ last_seq: 12, summary_status: "done" })]);
    await call(attachRecording, c, { transcript_id: "t1", storage_id: "s1" });
    expect(c._scheduled).toEqual([]);
    const t = await c.db.get("t1" as any);
    expect(t.recording_storage_id).toBe("s1");
    expect(t.transcribe_status).toBeUndefined();
    expect(t.summary_status).toBe("done");
  });

  test("audio uploaded while the recording still runs waits for it to end", async () => {
    const c = ctx([row({ status: "live" })]);
    await call(attachRecording, c, { transcript_id: "t1", storage_id: "s1" });
    expect(c._scheduled).toEqual([]);
  });
});

describe("the transcription's own writes", () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    _id: "t1",
    room_key: REC_KEY,
    team_id: "team1",
    started_by: "ua",
    status: "ended",
    started_at: 1_000,
    routes: [],
    last_seq: 0,
    ...over,
  });
  const ctx = (rows: any[]) => {
    const scheduled: { name: string; args: any }[] = [];
    return {
      db: makeFakeDb({ transcripts: rows, transcript_segments: [] }),
      scheduler: {
        async runAfter(_d: number, reference: unknown, args: any) {
          scheduled.push({ name: getFunctionName(reference as any), args });
        },
      },
      _scheduled: scheduled,
    };
  };
  const call = (fn: any, c: any, args: any) => (fn as any)._handler(c, args);
  const seg = (text: string, t0: number, t1: number) => ({
    speaker_id: "mic",
    speaker_name: "Speaker",
    text,
    t0,
    t1,
  });

  test("segments land in order and move the delivery watermark", async () => {
    const c = ctx([rec()]);
    const first = await call(appendRecordingSegments, c, {
      transcript_id: "t1",
      segments: [seg("one", 0, 1000), seg("two", 1000, 2000)],
    });
    expect(first.last_seq).toBe(2);
    // A second batch continues the count — that watermark is what the routes
    // deliver against, so a restarted count would re-send everything.
    const second = await call(appendRecordingSegments, c, {
      transcript_id: "t1",
      segments: [seg("three", 2000, 3000)],
    });
    expect(second.last_seq).toBe(3);
    expect((await c.db.get("t1" as any)).last_seq).toBe(3);
    expect(c.db._inserted.map((r: any) => r.doc.text)).toEqual(["one", "two", "three"]);
  });

  test("a recording puts nobody on the participant roster", async () => {
    // One microphone in a room cannot name a voice. Filling the roster with
    // the placeholder label would put a person called "Speaker" on the call
    // object that the list, the detail view and the summary all read.
    const c = ctx([rec()]);
    await call(appendRecordingSegments, c, {
      transcript_id: "t1",
      segments: [seg("hello", 0, 1000)],
    });
    expect((await c.db.get("t1" as any)).participants).toBeUndefined();
  });

  test("it refuses to write into a huddle", async () => {
    const c = ctx([rec({ room_key: "dm:ua:ub" })]);
    const out = await call(appendRecordingSegments, c, {
      transcript_id: "t1",
      segments: [seg("hello", 0, 1000)],
    });
    expect(out.last_seq).toBe(0);
    expect(c.db._inserted).toEqual([]);
  });

  test("finishing well hands the words to the routes and the summary", async () => {
    const c = ctx([rec({ transcribe_status: "pending", last_seq: 3 })]);
    await call(finishRecordingTranscript, c, { transcript_id: "t1", ok: true });
    expect((await c.db.get("t1" as any)).transcribe_status).toBe("done");
    expect(c._scheduled.map((s) => s.name)).toEqual([
      "transcripts:deliverRoutes",
      "transcripts:generateSummary",
    ]);
  });

  test("finishing badly says so instead of spinning forever", async () => {
    const c = ctx([rec({ transcribe_status: "pending", summary_status: "pending" })]);
    await call(finishRecordingTranscript, c, { transcript_id: "t1", ok: false });
    const t = await c.db.get("t1" as any);
    expect(t.transcribe_status).toBe("failed");
    // The audio is still there and still plays; what is gone is anything to
    // summarize, which is what "skipped" means everywhere else in this file.
    expect(t.summary_status).toBe("skipped");
    expect(c._scheduled).toEqual([]);
  });
});

// The recorder's length ceiling exists because an m4a cannot be split after
// the fact — there is no decoder in a Convex action. So the phone must stop
// before it makes a file the transcriber refuses, and this is that arithmetic.
describe("the recording length ceiling", () => {
  test("a file recorded to the ceiling still fits the transcriber", () => {
    const bytes = (MAX_RECORDING_MS / 1000) * RECORDING_BYTES_PER_SECOND;
    expect(bytes).toBeLessThan(TRANSCRIBE_MAX_BYTES);
  });

  test("it covers a meeting nobody would call short", () => {
    expect(MAX_RECORDING_MS).toBeGreaterThan(2 * 60 * 60 * 1000);
  });
});

// A finished huddle leaves one row where it was held: a chat message in a
// channel or DM room, a turn for the agent in a session room. The agent gets
// the summary and the command that reads the transcript — never the words.
describe("the huddle digest", () => {
  test("a room key says where the digest goes", () => {
    expect(huddleDigestTarget("channel:chan1")).toEqual({ kind: "chat" });
    expect(huddleDigestTarget("dm:ua:ub")).toEqual({ kind: "chat" });
    expect(huddleDigestTarget("session:conv1")).toEqual({ kind: "session", conversationId: "conv1" });
    expect(huddleDigestTarget("rec:0123456789ab")).toBeNull();
    expect(huddleDigestTarget("garbage")).toBeNull();
  });

  const huddle = (over: Record<string, unknown> = {}) => ({
    _id: "t1",
    room_key: "channel:chan1",
    team_id: "team1",
    started_by: "ua",
    status: "ended",
    started_at: 1_000,
    ended_at: 1_000 + 12 * 60_000,
    summary_status: "pending",
    participants: [{ id: "ua", name: "Alice" }, { id: "ub", name: "Bob" }],
    routes: [],
    last_seq: 3,
    ...over,
  });
  const ctx = (rows: any[], segments: any[] = [], recordings: any[] = []) => {
    const scheduled: { name: string; args: any }[] = [];
    return {
      db: makeFakeDb({ transcripts: rows, transcript_segments: segments, users: [], push_outbox: [], call_recordings: recordings }),
      scheduler: {
        async runAfter(_d: number, reference: unknown, args: any) {
          scheduled.push({ name: getFunctionName(reference as any), args });
        },
      },
      _scheduled: scheduled,
    };
  };
  const call = (fn: any, c: any, args: any) => (fn as any)._handler(c, args);
  const verdict = {
    transcript_id: "t1",
    summary_status: "done" as const,
    title: "Auth rollout",
    summary: "Alice and Bob agreed to ship the fix behind a flag.",
    action_items: ["Bob: ship the fix behind a flag"],
  };

  test("a channel huddle posts its summary into the channel as the scribe", async () => {
    const c = ctx([huddle()]);
    await call(setSummary, c, verdict);
    expect(c._scheduled.map((s) => s.name)).toEqual(["chat:postCallDigest"]);
    const { args } = c._scheduled[0];
    expect(args.transcript_id).toBe("t1");
    expect(args.room_key).toBe("channel:chan1");
    expect(args.team_id).toBe("team1");
    expect(args.author).toBe("ua");
    expect(args.content).toContain("**Auth rollout** · 12 min huddle with Alice and Bob");
    expect(args.content).toContain("agreed to ship the fix behind a flag");
    expect(args.content).toContain("- Bob: ship the fix behind a flag");
  });

  test("a people room posts too — the DM is resolved from the member set later", async () => {
    const c = ctx([huddle({ room_key: "dm:ua:ub" })]);
    await call(setSummary, c, verdict);
    expect(c._scheduled.map((s) => s.name)).toEqual(["chat:postCallDigest"]);
    expect(c._scheduled[0].args.room_key).toBe("dm:ua:ub");
  });

  test("a session huddle wakes the agent with the summary and the transcript command, not the words", async () => {
    const c = ctx([huddle({ room_key: "session:conv1" })]);
    await call(setSummary, c, verdict);
    expect(c._scheduled.map((s) => s.name)).toEqual(["transcripts:deliverToSession"]);
    const { args } = c._scheduled[0];
    expect(args.as_user).toBe("ua");
    expect(args.to).toBe("conv1");
    expect(args.body.startsWith('<huddle-summary transcript="t1" title="Auth rollout" minutes="12" speakers="Alice, Bob">')).toBe(true);
    expect(args.body).toContain("agreed to ship the fix behind a flag");
    expect(args.body).toContain("cast call t1 --transcript");
    expect(args.body.endsWith("</huddle-summary>")).toBe(true);
  });

  test("a session that heard the huddle live gets the digest as a record, not a second ask", async () => {
    const c = ctx([
      huddle({
        room_key: "session:conv1",
        routes: [{ kind: "session", target: "conv1", mode: "live", sent_seq: 3, added_by: "ua" }],
      }),
    ]);
    await call(setSummary, c, verdict);
    const { args } = c._scheduled[0];
    expect(args.body).toContain("You already heard it live");
    // Still the whole digest: the summary, the action items, the pointer.
    expect(args.body).toContain("- Bob: ship the fix behind a flag");
    expect(args.body).toContain("cast call t1 --transcript");
  });

  test("a feed pointed somewhere ELSE does not make the digest a record here", async () => {
    const c = ctx([
      huddle({
        room_key: "session:conv1",
        routes: [{ kind: "session", target: "conv9", mode: "live", sent_seq: 3, added_by: "ua" }],
      }),
    ]);
    await call(setSummary, c, verdict);
    expect(c._scheduled[0].args.body).toContain("A huddle just ended in this session's room.");
  });

  test("the digest posts once: a second verdict on a settled row is not a second row", async () => {
    const c = ctx([huddle({ summary_status: "done" })]);
    await call(setSummary, c, verdict);
    expect(c._scheduled).toEqual([]);
  });

  test("a huddle nobody spoke in leaves nothing behind", async () => {
    const c = ctx([huddle({ last_seq: 0 })]);
    await call(setSummary, c, { transcript_id: "t1", summary_status: "skipped" });
    expect(c._scheduled).toEqual([]);
  });

  // A filmed huddle is content whether anyone spoke or not (a screen walked
  // through in silence, transcription off): the place it was held is where
  // a teammate looks for its video, so the digest posts and names it.
  describe("a huddle recorded on video", () => {
    // The room's file from 4:40 to 7:20 of the call, a screen inside it, and
    // a failed second run that filmed nothing.
    const recs = [
      { _id: "r1", transcript_id: "t1", kind: "composite", status: "ready", started_at: 1_000 + 280_000, duration_ms: 160_000 },
      { _id: "r2", transcript_id: "t1", kind: "screen", status: "ready", started_at: 1_000 + 300_000, duration_ms: 60_000 },
      { _id: "r3", transcript_id: "t1", kind: "composite", status: "failed", started_at: 1_000 + 500_000, duration_ms: 9_000 },
    ];
    const filmed = (over: Record<string, unknown> = {}) =>
      huddle({ last_seq: 0, participants: [], recorded_people: ["ua"], video_runs: 2, short_id: "cl-42", ...over });

    test("nobody spoke: the digest still posts, and names the video", async () => {
      const c = ctx([filmed()], [], recs);
      await call(setSummary, c, { transcript_id: "t1", summary_status: "skipped" });
      expect(c._scheduled.map((s) => s.name)).toEqual(["chat:postCallDigest"]);
      expect(c._scheduled[0].args.content).toBe("**Huddle** · 12 min huddle\n\nRecorded on video: 4:40-7:20.");
    });

    test("a session's agent is told it can snap a frame of it", async () => {
      const c = ctx([filmed({ room_key: "session:conv1" })], [], recs);
      await call(setSummary, c, { transcript_id: "t1", summary_status: "skipped" });
      const { body } = c._scheduled[0].args;
      expect(body).toContain("Recorded on video: 4:40-7:20.");
      expect(body).toContain("`cast call snap cl-42:<line>`");
    });

    test("with words too: the video line sits above the summary", async () => {
      const c = ctx([filmed({ last_seq: 3, participants: [{ id: "ua", name: "Alice" }] })], [], recs);
      await call(setSummary, c, verdict);
      expect(c._scheduled[0].args.content).toContain("with Alice\n\nRecorded on video: 4:40-7:20.\n\nAlice and Bob agreed");
    });

    test("never filmed: nothing about video", async () => {
      const c = ctx([huddle()], [], recs);
      await call(setSummary, c, verdict);
      expect(c._scheduled[0].args.content).not.toContain("video");
    });
  });

  test("too few words to summarize: the words themselves are the digest", async () => {
    const c = ctx(
      [huddle({ last_seq: 2 })],
      [
        { _id: "s1", transcript_id: "t1", seq: 1, speaker_id: "ua", speaker_name: "Alice", text: "ship it", t0: 0, t1: 1 },
        { _id: "s2", transcript_id: "t1", seq: 2, speaker_id: "ub", speaker_name: "Bob", text: "done", t0: 1, t1: 2 },
      ],
    );
    await call(setSummary, c, { transcript_id: "t1", summary_status: "skipped" });
    expect(c._scheduled.map((s) => s.name)).toEqual(["chat:postCallDigest"]);
    expect(c._scheduled[0].args.content).toContain("**Alice**: ship it\n**Bob**: done");
  });

  test("a failed summary still posts, and says the summary is missing", async () => {
    const c = ctx([huddle()]);
    await call(setSummary, c, { transcript_id: "t1", summary_status: "failed" });
    expect(c._scheduled.map((s) => s.name)).toEqual(["chat:postCallDigest"]);
    expect(c._scheduled[0].args.content).toContain("The summary could not be generated.");
  });

  test("a recording has no room to report into", async () => {
    const c = ctx([huddle({ room_key: REC_KEY })]);
    await call(setSummary, c, verdict);
    expect(c._scheduled).toEqual([]);
  });
});

// A PREWARM ROW MUST NOT EXTEND A DEAD HUDDLE'S RECORDING.
//
// Being heard from the first word means opening a DM connects to the media
// server ahead of anybody speaking, which leaves a row in call_members for a
// person who is not in the room. `liveMembers` hides it from every reader that
// asks who is here — but this sweep asks a different question. It dates a dead
// huddle's end from the last lease anybody refreshed, deliberately reading
// STALE rows, and a connection opened after the huddle died is the freshest
// lease in the room while meaning nothing about when people stopped talking.
describe("the orphan sweep dates the end from seats, never from a prewarm", () => {
  // Anchored to the real clock, because the handler reads Date.now() itself:
  // a fixed timestamp in the future makes every lease read as current and the
  // sweep silently does nothing.
  const T = Date.now();
  const STALE = CALL_MEMBER_STALE_MS;

  function sweepCtx(callRows: any[]) {
    const transcripts = [
      { _id: "tr1", room_key: "channel:ch1", status: "live", started_at: T - 600_000, last_beat: T - 300_000 },
    ];
    const patches: any[] = [];
    const ctx: any = {
      db: {
        query: (t: string) => ({
          withIndex: (_i: string, builder: any) => {
            const eqs: Array<[string, any]> = [];
            builder({ eq(f: string, v: any) { eqs.push([f, v]); return this; } });
            const src = t === "transcripts" ? transcripts : t === "call_members" ? callRows : [];
            return { collect: async () => src.filter((r: any) => eqs.every(([f, v]) => String(r[f]) === String(v))) };
          },
        }),
        get: async (id: string) => transcripts.find((r) => r._id === id) ?? null,
        patch: async (id: string, doc: any) => { patches.push({ id, ...doc }); },
        insert: async () => "x",
      },
      scheduler: { runAfter: async () => {} },
      runMutation: async () => {},
    };
    return { ctx, patches };
  }

  async function sweep(ctx: any) {
    const { sweepOrphanedLive } = await import("./transcripts");
    const handler = (sweepOrphanedLive as any)._handler ?? (sweepOrphanedLive as any).handler;
    return handler(ctx, {});
  }

  const row = (over: Record<string, unknown>) => ({
    _id: "cm", room_key: "channel:ch1", team_id: "t1", user_id: "u1",
    muted: false, camera: false, sharing: false, joined_at: T - 600_000, ...over,
  });

  test("ends at the last real seat's lease, not the prewarm's", async () => {
    // The speaker's tab died longer ago than the grace; somebody opened this
    // DM afterwards and their connection is now the freshest row in the table.
    const seatSeen = T - HUDDLE_GRACE_MS - 60_000;
    const { ctx, patches } = sweepCtx([
      row({ _id: "dead", last_seen: seatSeen }),
      row({ _id: "warm", last_seen: T - 1_000, prewarm: true }),
    ]);
    const res = await sweep(ctx);
    expect(res.ended).toBe(1);
    const ended = patches.find((p) => p.id === "tr1");
    // MUTATION CHECK: drop the `.filter(isSeat)` in sweepOrphanedLive and this
    // becomes T - 1_000 — the recording grows by however long the connection
    // had been held, up to the full ninety second idle window.
    expect(ended.ended_at).toBe(seatSeen);
  });

  test("a room holding nothing but a prewarm reads empty and starts its grace", async () => {
    // The prewarm must not keep the transcript alive either: liveMembers drops
    // it, so the room reads empty. With no seat to date the quiet from, the
    // sweep stamps it now and the next pass past the grace ends it.
    const { ctx, patches } = sweepCtx([row({ _id: "warm", last_seen: T, prewarm: true })]);
    const res = await sweep(ctx);
    expect(res.ended).toBe(0);
    expect(patches.find((p) => p.id === "tr1").idle_since).toBeGreaterThanOrEqual(T);
  });

  test("a room emptied inside the grace is left to resume", async () => {
    const { ctx, patches } = sweepCtx([row({ _id: "gone", last_seen: T - STALE - 10_000 })]);
    expect((await sweep(ctx)).ended).toBe(0);
    expect(patches.find((p) => p.id === "tr1")).toBeUndefined();
  });

  test("a live seat still protects the transcript", async () => {
    const { ctx } = sweepCtx([row({ _id: "here", last_seen: T })]);
    expect((await sweep(ctx)).ended).toBe(0);
  });
});

// A huddle that ended with nothing in it (no words, no line typed or
// answered) is no call anybody would look for: the history leaves it out.
describe("the call history leaves out empty huddles", () => {
  const huddle = (id: string, over: Record<string, unknown> = {}) => ({
    _id: id, room_key: "channel:ch1", team_id: "teamA", started_by: "ua", status: "ended",
    started_at: 1_000, ended_at: 2_000, routes: [], last_seq: 0, participants: [{ id: "ua", name: "Ada" }], ...over,
  });
  test("words or a typed line keep a huddle; events alone or nothing do not", async () => {
    const c = {
      db: makeFakeDb({
        transcripts: [
          huddle("spoken", { last_seq: 4, started_at: 5_000 }),
          huddle("typed", { started_at: 4_000 }),
          huddle("events", { started_at: 3_000 }),
          huddle("empty", { started_at: 2_000 }),
          huddle("live", { status: "live", ended_at: undefined, started_at: 6_000 }),
        ],
        call_chat_messages: [
          { _id: "l1", room_key: "channel:ch1", user_id: "ua", text: "the link", transcript_id: "typed" },
          { _id: "l2", room_key: "channel:ch1", user_id: "ua", text: "", event: "transcribe_off", transcript_id: "events" },
        ],
        team_memberships: [{ user_id: "ua", team_id: "teamA" }],
        teams: [{ _id: "teamA", features: { calls: true } }],
        transcript_segments: [],
      }),
      auth: { async getUserIdentity() { return { subject: "ua|session" }; } },
    };
    const rows = await (webListCalls as any)._handler(c, {});
    expect(rows.map((r: any) => r._id)).toEqual(["live", "spoken", "typed"]);
  });

  // The list keeps `limit` calls per source WHILE it walks. Taking `limit`
  // rows and filtering afterwards let six scratch huddles hide the one real
  // call behind them (cast calls -n 5 skipped the recorded calls on prod).
  const listCtx = (transcripts: any[]) => ({
    db: makeFakeDb({
      transcripts,
      call_chat_messages: [],
      team_memberships: [{ user_id: "ua", team_id: "teamA" }],
      teams: [{ _id: "teamA", features: { calls: true } }, { _id: "teamB", features: { calls: true } }],
      transcript_segments: [],
    }),
    auth: { async getUserIdentity() { return { subject: "ua|session" }; } },
  });

  test("silent huddles newer than a real call do not crowd it out of a short list", async () => {
    const silent = Array.from({ length: 6 }, (_, i) => huddle(`silent${i}`, { started_at: 10_000 + i }));
    const c = listCtx([...silent, huddle("real", { last_seq: 2, started_at: 1_000 })]);
    const rows = await (webListCalls as any)._handler(c, { limit: 3 });
    expect(rows.map((r: any) => r._id)).toEqual(["real"]);
  });

  test("a personal recording filed under another team interleaves by start time", async () => {
    const rec = (id: string, started_at: number) => ({
      ...huddle(id, { started_at, last_seq: 1 }),
      room_key: "rec:1f8e7d6c-1234-4abc-9def-0123456789ab",
      team_id: "teamB",
    });
    const c = listCtx([
      ...Array.from({ length: 4 }, (_, i) => huddle(`silent${i}`, { started_at: 20_000 + i })),
      huddle("newest", { last_seq: 2, started_at: 9_000 }),
      rec("rec_mid", 7_000),
      huddle("older", { last_seq: 2, started_at: 5_000 }),
      rec("rec_old", 3_000),
    ]);
    const rows = await (webListCalls as any)._handler(c, { limit: 3 });
    expect(rows.map((r: any) => r._id)).toEqual(["newest", "rec_mid", "older"]);
  });
});

// The web names a call from its own store and asks the server only for the
// places it could not find (a session never loaded). The answer is the one
// `cast calls` prints, and only for calls the viewer may read: a room key is
// never enough to learn a name.
describe("webCallPlaces names only the calls the viewer may read", () => {
  test("a readable call gets its place, an unreadable one gets nothing", async () => {
    const row = (id: string, room_key: string, who: string) => ({
      _id: id, room_key, team_id: "teamA", started_by: who, status: "ended",
      started_at: 1_000, ended_at: 2_000, routes: [], last_seq: 2, participants: [{ id: who, name: who }],
    });
    const c = {
      db: makeFakeDb({
        transcripts: [row("mine", "dm:ua:ub", "ua"), row("theirs", "dm:ub:uc", "ub")],
        users: [
          { _id: "ua", name: "Ada" },
          { _id: "ub", name: "Bo Chen" },
          { _id: "uc", name: "Cy" },
        ],
        team_memberships: [
          { user_id: "ua", team_id: "teamA" },
          { user_id: "ub", team_id: "teamA" },
          { user_id: "uc", team_id: "teamA" },
        ],
        teams: [{ _id: "teamA", features: { calls: true } }],
      }),
      auth: { async getUserIdentity() { return { subject: "ua|session" }; } },
    };
    const places = await (webCallPlaces as any)._handler(c, { transcript_ids: ["mine", "theirs"] });
    expect(places).toEqual({ mine: { session_title: null, peer_name: "Bo Chen", channel_name: null } });
  });
});

// ── Recording scope: private shelf, team triage ───────────────────────────
//
// A recording is born private to its creator, listed on their personal shelf
// whatever team it was routed to, and reaches teammates only after the
// creator files it into a team (setRecordingScope). These tests walk the
// whole gate: the list, the detail read, the share, the unshare.
describe("recording scope and triage", () => {
  const REC = "rec:1f8e7d6c-1234-4abc-9def-0123456789ab";
  const recRow = (over: Record<string, unknown> = {}) => ({
    _id: "tr_rec",
    room_key: REC,
    team_id: "teamA",
    started_by: "ua",
    status: "ended",
    started_at: 2_000,
    ended_at: 3_000,
    routes: [],
    last_seq: 3,
    ...over,
  });
  const ctxFor = (user: string, rows: any[], memberships: any[]) => ({
    db: makeFakeDb({
      transcripts: rows,
      team_memberships: memberships,
      teams: [{ _id: "teamA", features: { calls: true } }],
      transcript_segments: [],
    }),
    auth: {
      async getUserIdentity() {
        return { subject: `${user}|session` };
      },
    },
  });
  const call = (fn: any, c: any, args: any = {}) => (fn as any)._handler(c, args);
  const member = (user: string) => ({ user_id: user, team_id: "teamA" });

  test("the creator lists their recording even with no team membership at all", async () => {
    const c = ctxFor("ua", [recRow()], []);
    const rows = await call(webListCalls, c, {});
    expect(rows.map((r: any) => r._id)).toEqual(["tr_rec"]);
    expect(rows[0].rec_shared).toBe(false);
  });

  test("a teammate does not see a private recording, in list or detail", async () => {
    const c = ctxFor("ub", [recRow()], [member("ua"), member("ub")]);
    expect(await call(webListCalls, c, {})).toEqual([]);
    expect(await call(webGetCall, c, { transcript_id: "tr_rec" })).toBeNull();
  });

  test("sharing files it into the team and opens the team door", async () => {
    const c = ctxFor("ua", [recRow()], [member("ua"), member("ub")]);
    await call(setRecordingScope, c, { transcript_id: "tr_rec", team_id: "teamA" });
    const row = await c.db.get("tr_rec" as any);
    expect(row.rec_shared).toBe(true);
    expect(row.team_id).toBe("teamA");

    const teammate = ctxFor("ub", [row], [member("ua"), member("ub")]);
    expect((await call(webListCalls, teammate, {})).map((r: any) => r._id)).toEqual(["tr_rec"]);
    expect((await call(webGetCall, teammate, { transcript_id: "tr_rec" }))?._id).toBe("tr_rec");
  });

  test("unsharing closes the team door again and keeps the routing team", async () => {
    const shared = recRow({ rec_shared: true });
    const c = ctxFor("ua", [shared], [member("ua"), member("ub")]);
    await call(setRecordingScope, c, { transcript_id: "tr_rec" });
    const row = await c.db.get("tr_rec" as any);
    expect(row.rec_shared).toBe(false);
    expect(row.team_id).toBe("teamA");
    const teammate = ctxFor("ub", [row], [member("ua"), member("ub")]);
    expect(await call(webListCalls, teammate, {})).toEqual([]);
  });

  test("only the creator may move the scope, and only into their own team", async () => {
    const teammate = ctxFor("ub", [recRow()], [member("ua"), member("ub")]);
    await expect(
      call(setRecordingScope, teammate, { transcript_id: "tr_rec", team_id: "teamA" }),
    ).rejects.toThrow("Recording not found");

    const outsider = ctxFor("ua", [recRow()], [member("ub")]);
    await expect(
      call(setRecordingScope, outsider, { transcript_id: "tr_rec", team_id: "teamA" }),
    ).rejects.toThrow("Not a member of that team");
  });

  test("a huddle transcript refuses the recording gesture", async () => {
    const huddleRow = recRow({ room_key: "dm:ua:ub" });
    const c = ctxFor("ua", [huddleRow], [member("ua")]);
    await expect(
      call(setRecordingScope, c, { transcript_id: "tr_rec", team_id: "teamA" }),
    ).rejects.toThrow("Recording not found");
  });
});

// Talking in a session's huddle is talking to its agent: the room's transcript
// carries a live feed into that session from its first breath, so no one has to
// point the words at the agent whose room they are already standing in.
describe("the routes a room starts with", () => {
  test("a session room feeds itself, live", () => {
    expect(withDefaultRoutes("session:conv1", [])).toEqual([
      { kind: "session", target: "conv1", mode: "live", sent_seq: 0 },
    ]);
  });

  test("every other room starts with nothing", () => {
    expect(withDefaultRoutes("channel:chan1", [])).toEqual([]);
    expect(withDefaultRoutes("dm:ua:ub", [])).toEqual([]);
    expect(withDefaultRoutes("rec:0123456789ab", [])).toEqual([]);
    expect(withDefaultRoutes("garbage", [])).toEqual([]);
  });

  test("a caller that named this session's feed keeps its own mode", () => {
    const asked = [{ kind: "session" as const, target: "conv1", mode: "after" as const, sent_seq: 0 }];
    expect(withDefaultRoutes("session:conv1", asked)).toEqual(asked);
  });

  test("feeds pointed elsewhere are kept, and the room's own is added", () => {
    const asked = [{ kind: "doc" as const, target: "doc1", mode: "live" as const, sent_seq: 0 }];
    expect(withDefaultRoutes("session:conv1", asked)).toEqual([
      ...asked,
      { kind: "session", target: "conv1", mode: "live", sent_seq: 0 },
    ]);
  });

  test("the room's own session is the one a live chunk addresses directly", () => {
    expect(ownRoomTarget("session:conv1")).toBe("conv1");
    expect(ownRoomTarget("channel:chan1")).toBeNull();
  });
});

// THE RECAP WHILE THE CALL IS STILL GOING. The thread shows "So far" from the
// same summary the end of the call rewrites. The throttle lives in flush (it
// runs on every silence gap and has the db), and the claim is written in the
// same mutation as the schedule so two gaps landing together run it once.
describe("the rolling recap", () => {
  const now = 1_800_000_000_000;
  const huddle = (over: Record<string, unknown> = {}) => ({
    _id: "t1",
    room_key: "channel:chan1",
    team_id: "team1",
    started_by: "ua",
    status: "live",
    started_at: now - 10 * 60_000,
    routes: [],
    last_seq: 3,
    ...over,
  });
  // Three segments of forty words each: exactly the rolling floor.
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  const segments = (n = 3, per = 40) =>
    Array.from({ length: n }, (_, i) => ({
      _id: `s${i + 1}`, transcript_id: "t1", seq: i + 1, speaker_id: "ua", speaker_name: "Alice", text: words(per), t0: i * 1000, t1: i * 1000 + 900,
    }));
  const ctx = (rows: any[], segs: any[] = segments()) => {
    const scheduled: { name: string; args: any }[] = [];
    return {
      db: makeFakeDb({ transcripts: rows, transcript_segments: segs, users: [], push_outbox: [] }),
      auth: { async getUserIdentity() { return { subject: "ua|session" }; } },
      scheduler: {
        async runAfter(_d: number, reference: unknown, args: any) {
          scheduled.push({ name: getFunctionName(reference as any), args });
        },
      },
      _scheduled: scheduled,
    };
  };
  const call = (fn: any, c: any, args: any) => (fn as any)._handler(c, args);
  const summaries = (c: any) => c._scheduled.filter((s: any) => s.name === "transcripts:generateSummary");
  let clock: any;
  beforeEach(() => { clock = spyOn(Date, "now").mockReturnValue(now); });
  afterEach(() => { clock.mockRestore(); });

  test("a gap inside the window delivers the routes and claims no recap", async () => {
    const c = ctx([huddle({ summary_at: now - ROLLING_SUMMARY_GAP_MS + 1_000, summary_seq: 0 })]);
    await call(flush, c, { transcript_id: "t1" });
    expect(c._scheduled.map((s: any) => s.name)).toEqual(["transcripts:deliverRoutes"]);
    expect(c.db._patched).toHaveLength(0);
  });

  test("the first run waits the same window from the start of the call", async () => {
    const c = ctx([huddle({ started_at: now - 30_000 })]);
    await call(flush, c, { transcript_id: "t1" });
    expect(summaries(c)).toHaveLength(0);
  });

  test("too few new words since the last run is no run", async () => {
    const c = ctx([huddle({ summary_at: now - ROLLING_SUMMARY_GAP_MS, summary_seq: 2 })]);
    await call(flush, c, { transcript_id: "t1" });
    expect(summaries(c)).toHaveLength(0);
    expect(c.db._patched).toHaveLength(0);
  });

  test("past the window with enough said: the claim and the run land together, and only once", async () => {
    const c = ctx([huddle({ summary_at: now - ROLLING_SUMMARY_GAP_MS })]);
    await call(flush, c, { transcript_id: "t1" });
    expect(summaries(c)).toEqual([{ name: "transcripts:generateSummary", args: { transcript_id: "t1", rolling: true } }]);
    expect(c.db._patched).toEqual([{ _id: "t1", patch: { summary_at: now, summary_seq: 3 } }]);
    // A second gap right behind it reads the claim and schedules nothing.
    await call(flush, c, { transcript_id: "t1" });
    expect(summaries(c)).toHaveLength(1);
    expect(c.db._patched).toHaveLength(1);
  });

  test("the words are counted from the claimed seq, not from the start", async () => {
    // Forty new words past seq 2: under the floor even though the whole call is well over it.
    const c = ctx([huddle({ summary_at: now - ROLLING_SUMMARY_GAP_MS, summary_seq: 2, last_seq: 3 })], segments(3, 100));
    await call(flush, c, { transcript_id: "t1" });
    expect(summaries(c)).toHaveLength(0);
    const d = ctx([huddle({ summary_at: now - ROLLING_SUMMARY_GAP_MS, summary_seq: 1, last_seq: 3 })], segments(3, ROLLING_SUMMARY_MIN_WORDS / 2));
    await call(flush, d, { transcript_id: "t1" });
    expect(summaries(d)).toHaveLength(1);
  });

  test("a recording keeps its one summary at the end", async () => {
    const c = ctx([huddle({ room_key: "rec:9f8e7d6c-1234-4abc-9def-0123456789ab", summary_at: now - ROLLING_SUMMARY_GAP_MS })]);
    await call(flush, c, { transcript_id: "t1" });
    expect(summaries(c)).toHaveLength(0);
  });

  test("a rolling verdict refreshes the summary and action items and touches nothing else", async () => {
    const c = ctx([huddle({ summary_status: undefined, title: undefined })]);
    await call(setSummary, c, {
      transcript_id: "t1", summary_status: "done", rolling: true,
      title: "Not yet", summary: "So far Alice has covered the rollout.", action_items: ["Alice: write it up"],
    });
    expect(c.db._patched).toEqual([{ _id: "t1", patch: { summary: "So far Alice has covered the rollout.", action_items: ["Alice: write it up"] } }]);
    const row = await c.db.get("t1");
    expect(row.summary_status).toBeUndefined();
    expect(row.title).toBeUndefined();
    // No digest, no push: those belong to the end of the call.
    expect(c._scheduled).toHaveLength(0);
  });

  test("a rolling run that failed or skipped writes nothing", async () => {
    const c = ctx([huddle({ summary: "kept" })]);
    await call(setSummary, c, { transcript_id: "t1", summary_status: "failed", rolling: true });
    await call(setSummary, c, { transcript_id: "t1", summary_status: "skipped", rolling: true });
    expect(c.db._patched).toHaveLength(0);
    expect((await c.db.get("t1")).summary).toBe("kept");
  });

  test("a rolling write landing after the call ended is ignored, so the final summary stands", async () => {
    const ended = huddle({ status: "ended", ended_at: now, summary_status: "pending" });
    const c = ctx([ended]);
    await call(setSummary, c, { transcript_id: "t1", summary_status: "done", rolling: true, summary: "partial" });
    expect(c.db._patched).toHaveLength(0);
    expect(c._scheduled).toHaveLength(0);
    // The end of the call's own verdict still lands as before: status, title, digest.
    await call(setSummary, c, { transcript_id: "t1", summary_status: "done", title: "Rollout", summary: "final", action_items: [] });
    const row = await c.db.get("t1");
    expect(row).toMatchObject({ summary_status: "done", title: "Rollout", summary: "final" });
    expect(c._scheduled.map((s: any) => s.name)).toEqual(["chat:postCallDigest"]);
    // And a rolling straggler after that changes nothing either.
    await call(setSummary, c, { transcript_id: "t1", summary_status: "done", rolling: true, summary: "stale partial" });
    expect((await c.db.get("t1")).summary).toBe("final");
  });
});

// THE ROOM'S THREAD SEES TRANSCRIPTION GO ON. A person pressing Transcribe on
// a room with no run is news; a joining window's automatic start is every
// huddle's normal breath and says nothing. Switching off is written by the
// room switch (calls.setRoomTranscribeOff), not by the end of the run, which
// also fires when the room empties.
describe("the room's thread sees transcription go on", () => {
  const now = 1_800_000_000_000;
  const seated = () => ({
    call_members: [{ _id: "cm1", room_key: "session:conv1", user_id: "ua", team_id: "team1", last_seen: now, expires_at: now + 60_000 }],
    call_rooms: [],
    call_room_state: [],
    call_invites: [],
    users: [{ _id: "ua", name: "Ada", email: "ada@x.org" }],
    team_members: [{ team_id: "team1", user_id: "ua" }],
    teams: [{ _id: "team1", features: { calls: true } }],
    conversations: [{ _id: "conv1", short_id: "conv1", title: "Fix the auth race", agent_type: "claude_code", user_id: "ua", team_id: "team1" }],
    messages: [],
    call_agent_feeds: [],
    transcripts: [],
    transcript_segments: [],
    call_chat_messages: [],
  });
  const ctx = (tables: Record<string, any[]>) => {
    const scheduled: { name: string; args: any }[] = [];
    return {
      db: makeFakeDb(tables),
      auth: { async getUserIdentity() { return { subject: "ua|session" }; } },
      scheduler: {
        async runAfter(_d: number, reference: unknown, args: any) {
          scheduled.push({ name: getFunctionName(reference as any), args });
        },
      },
      _scheduled: scheduled,
    };
  };
  const call = (fn: any, c: any, args: any) => (fn as any)._handler(c, args);
  const events = (c: any) => c.db._tables.call_chat_messages.map((r: any) => [r.event, r.user_id, r.agent_conversation_id]);
  let clock: any;
  beforeEach(() => { clock = spyOn(Date, "now").mockReturnValue(now); });
  afterEach(() => { clock.mockRestore(); });

  test("a manual start on a session room says the switch went on and that the room's own agent is in", async () => {
    const c = ctx(seated());
    const res = await call(start, c, { room_key: "session:conv1" });
    expect(res.role).toBe("scribe");
    expect(events(c)).toEqual([
      ["transcribe_on", "ua", undefined],
      ["agent_joined", "ua", "conv1"],
    ]);
    // Resuming the same run says nothing more.
    await call(start, c, { room_key: "session:conv1" });
    expect(c.db._tables.call_chat_messages).toHaveLength(2);
  });

  test("an automatic start writes no switch line, and the end of the run writes nothing at all", async () => {
    const c = ctx(seated());
    const res = await call(start, c, { room_key: "session:conv1", auto: true });
    expect(res.role).toBe("scribe");
    expect(events(c)).toEqual([["agent_joined", "ua", "conv1"]]);
    // Switching the scribe off is a gap in the huddle, never its end.
    await call(stop, c, { transcript_id: res.transcript_id });
    expect(c.db._tables.transcripts[0].status).toBe("live");
    await endTranscript(c, c.db._tables.transcripts[0]);
    expect(c.db._tables.transcripts[0].status).toBe("ended");
    expect(c.db._tables.call_agent_feeds).toHaveLength(0);
    expect(c.db._tables.call_chat_messages).toHaveLength(1);
  });
});

// A call and the sessions it reached point at each other for good: the call
// page lists its agents and the session names its call, long after the feed
// that carried the words has gone.
describe("calls and the sessions they reach", () => {
  const now = 1_800_000_000_000;
  const tables = () => ({
    call_members: [{ _id: "cm1", room_key: "session:conv1", user_id: "ua", team_id: "team1", last_seen: now, expires_at: now + 60_000 }],
    call_rooms: [],
    call_room_state: [],
    call_invites: [],
    users: [{ _id: "ua", name: "Ada", email: "ada@x.org" }],
    team_members: [{ team_id: "team1", user_id: "ua" }],
    team_memberships: [{ team_id: "team1", user_id: "ua" }],
    teams: [{ _id: "team1", features: { calls: true } }],
    conversations: [
      { _id: "conv1", short_id: "conv1", title: "Fix the auth race", agent_type: "claude_code", user_id: "ua", team_id: "team1", is_private: true },
      { _id: "conv2", short_id: "conv2", title: "Write the notes", agent_type: "claude_code", user_id: "ua", team_id: "team1", is_private: true },
      { _id: "conv3", short_id: "conv3", title: "Someone else's", agent_type: "claude_code", user_id: "uz", team_id: "team1", is_private: true },
    ],
    messages: [],
    call_agent_feeds: [],
    call_session_links: [],
    transcripts: [],
    transcript_segments: [],
    call_chat_messages: [],
  });
  const ctx = (t: Record<string, any[]>) => ({
    db: makeFakeDb(t),
    auth: { async getUserIdentity() { return { subject: "ua|session" }; } },
    scheduler: { async runAfter() {} },
  });
  const call = (fn: any, c: any, args: any) => (fn as any)._handler(c, args);
  let clock: any;
  beforeEach(() => { clock = spyOn(Date, "now").mockReturnValue(now); });
  afterEach(() => { clock.mockRestore(); });

  test("a live feed links the session, and the link outlives the call", async () => {
    const c = ctx(tables());
    const res = await call(start, c, { room_key: "session:conv1", auto: true });
    await endTranscript(c, c.db._tables.transcripts[0]);
    expect(c.db._tables.call_agent_feeds).toHaveLength(0);
    expect(c.db._tables.call_session_links.map((l: any) => [l.conversation_id, l.live])).toEqual([["conv1", true]]);

    const detail = await call(webGetCall, c, { transcript_id: res.transcript_id });
    expect(detail.sessions.map((s: any) => [s.conversation_id, s.live])).toEqual([["conv1", true]]);
    const back = await call(webCallsForConversation, c, { conversation_id: "conv1" });
    expect(back.map((x: any) => String(x._id))).toEqual([String(res.transcript_id)]);
  });

  test("each excerpt sent to a session lands on one link with its turn range", async () => {
    const c = ctx(tables());
    const res = await call(start, c, { room_key: "session:conv1", auto: true });
    await call(linkExcerpt, c, { transcript_id: res.transcript_id, conversation: "conv2", from_seq: 4, to_seq: 2 });
    await call(linkExcerpt, c, { transcript_id: res.transcript_id, conversation: "conv2", from_seq: 7, to_seq: 9 });
    const link = c.db._tables.call_session_links.find((l: any) => l.conversation_id === "conv2");
    expect(link.live).toBeUndefined();
    expect(link.excerpts.map((e: any) => [e.from_seq, e.to_seq])).toEqual([[2, 4], [7, 9]]);
    expect(c.db._tables.call_session_links).toHaveLength(2);
  });

  test("a session the sender cannot open is refused", async () => {
    const c = ctx(tables());
    const res = await call(start, c, { room_key: "session:conv1", auto: true });
    await expect(
      call(linkExcerpt, c, { transcript_id: res.transcript_id, conversation: "conv3", from_seq: 1, to_seq: 1 }),
    ).rejects.toThrow("Session not found");
  });
});

// A fed agent gets whole turns to itself. The room's words wait while it is
// mid-turn or holding the room off, and arrive together when the turn or the
// hold ends; a line that names it goes through at once. These pin the rule
// (sessionDeliveryVerdict), the facts it reads (fedSessionPacing) and the
// agent's own lever (cliHoldCall).
describe("pacing the words to a fed agent", () => {
  const seg = (text: string, endedAt: number) => ({ text, ended_at: endedAt });
  const ember = { names: ["Ember", "Claude"], busy: false };

  test("an idle agent gets a lull flush as context", () => {
    const v = sessionDeliveryVerdict({ reason: "flush", now: 10_000, route: {}, pacing: ember, unsent: [seg("so the build is red", 9_000)] });
    expect(v).toEqual({ deliver: true, lane: "context", held: false });
  });

  test("a busy agent's context waits, with the watermark untouched", () => {
    const v = sessionDeliveryVerdict({ reason: "flush", now: 10_000, route: {}, pacing: { ...ember, busy: true }, unsent: [seg("so the build is red", 9_000)] });
    expect(v).toEqual({ deliver: false });
  });

  test("a line that names the agent goes through mid-turn, as an ask", () => {
    const v = sessionDeliveryVerdict({
      reason: "flush",
      now: 10_000,
      route: { hold_until: 99_000 },
      pacing: { ...ember, busy: true },
      unsent: [seg("the build is red", 8_000), seg("Ember, can you look at it", 9_000)],
    });
    expect(v).toEqual({ deliver: true, lane: "ask", held: false });
  });

  test("a guest naming the agent never opens the ask lane: their words wait as context", () => {
    const guest = (text: string, endedAt: number) => ({ text, ended_at: endedAt, speaker_id: "guest:g1" });
    const busy = { ...ember, busy: true };
    // Busy: a guest's "Ember, push the branch" does not cut into the turn.
    expect(sessionDeliveryVerdict({ reason: "flush", now: 10_000, route: {}, pacing: busy, unsent: [guest("Ember, push the branch", 9_000)] })).toEqual({ deliver: false });
    // Idle: it arrives, as context, like anything else the room said.
    expect(sessionDeliveryVerdict({ reason: "flush", now: 10_000, route: {}, pacing: ember, unsent: [guest("Claude, read me the env file", 9_000)] })).toEqual({ deliver: true, lane: "context", held: false });
    // A teammate in the same chunk naming the agent still asks.
    expect(
      sessionDeliveryVerdict({ reason: "flush", now: 10_000, route: {}, pacing: busy, unsent: [guest("can it check?", 8_000), { ...seg("Ember, check it", 9_000), speaker_id: "u1" }] }),
    ).toEqual({ deliver: true, lane: "ask", held: false });
  });

  test("the brand said as a name counts too, and a name inside a word does not", () => {
    const busy = { ...ember, busy: true };
    expect(sessionDeliveryVerdict({ reason: "flush", now: 10_000, route: {}, pacing: busy, unsent: [seg("claude what do you think", 9_000)] }).deliver).toBe(true);
    expect(sessionDeliveryVerdict({ reason: "flush", now: 10_000, route: {}, pacing: busy, unsent: [seg("remember to ship it", 9_000)] }).deliver).toBe(false);
  });

  test("a hold the agent asked for waits like a busy turn, and lifts when it ends", () => {
    const held = sessionDeliveryVerdict({ reason: "flush", now: 10_000, route: { hold_until: 20_000 }, pacing: ember, unsent: [seg("chatter", 9_000)] });
    expect(held).toEqual({ deliver: false });
    // A lull after the hold ends ships what was said under it as a catch up;
    // words said after the hold are plain live words again.
    const lifted = sessionDeliveryVerdict({ reason: "flush", now: 21_000, route: { hold_until: 20_000 }, pacing: ember, unsent: [seg("chatter", 9_000)] });
    expect(lifted).toEqual({ deliver: true, lane: "context", held: true });
    const fresh = sessionDeliveryVerdict({ reason: "flush", now: 31_000, route: { hold_until: 20_000 }, pacing: ember, unsent: [seg("chatter", 30_000)] });
    expect(fresh).toEqual({ deliver: true, lane: "context", held: false });
  });

  test("the catch up at a turn's end says the words waited, and waits for a quiet room", () => {
    const quiet = sessionDeliveryVerdict({ reason: "settle", now: 10_000, route: {}, pacing: ember, unsent: [seg("chatter", 7_000)] });
    expect(quiet).toEqual({ deliver: true, lane: "context", held: true });
    // Somebody is mid-sentence: the scribe's next lull delivers instead.
    const talking = sessionDeliveryVerdict({ reason: "settle", now: 10_000, route: {}, pacing: ember, unsent: [seg("and then we", 9_000)] });
    expect(talking).toEqual({ deliver: false, wait: "quiet" });
    const expired = sessionDeliveryVerdict({ reason: "hold_expired", now: 10_000, route: {}, pacing: ember, unsent: [seg("chatter", 7_000)] });
    expect(expired).toEqual({ deliver: true, lane: "context", held: true });
  });

  test("a route whose session cannot be resolved is delivered as before", () => {
    const v = sessionDeliveryVerdict({ reason: "flush", now: 10_000, route: {}, pacing: null, unsent: [seg("hello", 9_000)] });
    expect(v).toEqual({ deliver: true, lane: "context", held: false });
  });

  const convo = (over: Record<string, unknown> = {}) => ({
    _id: "conv1",
    short_id: "conv1",
    title: "Fix the auth race",
    agent_type: "claude_code",
    user_id: "ua",
    ...over,
  });
  const pacingCtx = (managed: Record<string, unknown> | null, conv = convo()) => ({
    db: makeFakeDb({ conversations: [conv], managed_sessions: managed ? [{ _id: "ms1", conversation_id: "conv1", ...managed }] : [] }),
  });

  test("the names a room may use: the character (chosen or default) and the brand", async () => {
    const now = 100_000;
    const dflt = await fedSessionPacing(pacingCtx(null), "conv1", now);
    expect(dflt?.names).toEqual([characterOf({ _id: "conv1" }).name, "Claude"]);
    const chosen = await fedSessionPacing(pacingCtx(null, convo({ character_name: "Sage", agent_type: "codex" })), "conv1", now);
    expect(chosen?.names).toEqual(["Sage", "Codex"]);
    expect(await fedSessionPacing(pacingCtx(null), "nope", now)).toBeNull();
  });

  test("busy is a fresh heartbeat and a turn in progress; a dead or idle daemon never holds the words", async () => {
    const now = 100_000;
    const fresh = { last_heartbeat: now - 1_000, agent_status_updated_at: now - 5_000 };
    expect((await fedSessionPacing(pacingCtx({ ...fresh, agent_status: "working" }), "conv1", now))?.busy).toBe(true);
    expect((await fedSessionPacing(pacingCtx({ ...fresh, agent_status: "thinking" }), "conv1", now))?.busy).toBe(true);
    expect((await fedSessionPacing(pacingCtx({ ...fresh, agent_status: "idle" }), "conv1", now))?.busy).toBe(false);
    // "working" from a daemon that stopped beating is a stale claim.
    expect((await fedSessionPacing(pacingCtx({ last_heartbeat: now - 10 * 60_000, agent_status: "working", agent_status_updated_at: now - 10 * 60_000 }), "conv1", now))?.busy).toBe(false);
    expect((await fedSessionPacing(pacingCtx(null), "conv1", now))?.busy).toBe(false);
  });

  const holdCtx = async (rows: Record<string, any[]>) => {
    const scheduled: { delay: number; name: string; args: any }[] = [];
    return {
      db: makeFakeDb({
        api_tokens: [{ _id: "tok1", token_hash: await hashToken("tok"), user_id: "ua" }],
        users: [{ _id: "ua", name: "Ada" }],
        conversations: [convo()],
        ...rows,
      }),
      scheduler: {
        async runAfter(delay: number, reference: unknown, args: any) {
          scheduled.push({ delay, name: getFunctionName(reference as any), args });
        },
      },
      _scheduled: scheduled,
    };
  };
  const liveHuddle = () => ({
    _id: "t1",
    room_key: "channel:chan1",
    team_id: "team1",
    started_by: "ub",
    status: "live",
    started_at: 1_000,
    routes: [
      { kind: "session", target: "conv1", mode: "live", sent_seq: 2, added_by: "ub" },
      { kind: "doc", target: "d1", mode: "live", sent_seq: 2, added_by: "ub" },
    ],
    last_seq: 4,
  });

  test("cast call hold stamps the agent's own route and schedules the catch up at the hold's end", async () => {
    const c = await holdCtx({
      transcripts: [liveHuddle()],
      call_agent_feeds: [{ _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "channel:chan1", added_by: "ub" }],
    });
    const before = Date.now();
    const out = await (cliHoldCall as any)._handler(c, { api_token: "tok", session: "conv1", duration_ms: 3 * 60_000 });
    expect(out.held).toBe(true);
    expect(out.room_key).toBe("channel:chan1");
    expect(out.held_until).toBeGreaterThanOrEqual(before + 3 * 60_000);
    const t = await c.db.get("t1" as any);
    expect(t.routes[0].hold_until).toBe(out.held_until);
    expect(t.routes[1].hold_until).toBeUndefined();
    expect(t.routes[0].sent_seq).toBe(2);
    expect(c._scheduled).toHaveLength(1);
    expect(c._scheduled[0].name).toBe("transcripts:deliverRoutes");
    expect(c._scheduled[0].args.reason).toBe("hold_expired");
    expect(c._scheduled[0].delay).toBeGreaterThan(3 * 60_000 - 1_000);
  });

  test("hold off lifts the hold and delivers what waited now; the ask is capped", async () => {
    const c = await holdCtx({
      transcripts: [liveHuddle()],
      call_agent_feeds: [{ _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "channel:chan1", added_by: "ub" }],
    });
    const long = await (cliHoldCall as any)._handler(c, { api_token: "tok", session: "conv1", duration_ms: 24 * 60 * 60_000 });
    expect(long.held_until - Date.now()).toBeLessThanOrEqual(HOLD_MAX_MS);
    const off = await (cliHoldCall as any)._handler(c, { api_token: "tok", session: "conv1", duration_ms: 0 });
    expect(off.held).toBe(false);
    expect((await c.db.get("t1" as any)).routes[0].hold_until).toBeUndefined();
    expect(c._scheduled[1]).toMatchObject({ delay: 0, name: "transcripts:deliverRoutes" });
  });

  test("a session in no huddle has nothing to hold", async () => {
    const c = await holdCtx({ transcripts: [], call_agent_feeds: [] });
    const out = await (cliHoldCall as any)._handler(c, { api_token: "tok", session: "conv1", duration_ms: 60_000 });
    expect(out).toEqual({ held: false, reason: "not_in_huddle", short_id: "conv1" });
    expect(c._scheduled).toHaveLength(0);
  });

  test("one agent's hold or release leaves every other agent's hold alone", async () => {
    const other = { kind: "session", target: "conv2", mode: "live", sent_seq: 2, added_by: "ub", hold_until: 9_999_999_999_999 };
    const c = await holdCtx({
      conversations: [convo(), convo({ _id: "conv2", short_id: "conv2" })],
      transcripts: [{ ...liveHuddle(), routes: [...liveHuddle().routes, other] }],
      call_agent_feeds: [{ _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "channel:chan1", added_by: "ub" }],
    });
    const held = await (cliHoldCall as any)._handler(c, { api_token: "tok", session: "conv1", duration_ms: 60_000 });
    let t = await c.db.get("t1" as any);
    expect(t.routes[0].hold_until).toBe(held.held_until);
    expect(t.routes[2]).toEqual(other);
    await (cliHoldCall as any)._handler(c, { api_token: "tok", session: "conv1", duration_ms: 0 });
    t = await c.db.get("t1" as any);
    expect(t.routes[0].hold_until).toBeUndefined();
    expect(t.routes[2]).toEqual(other);
  });
});

// deliverRoutes end to end over the fake db: the action's query and
// mutations run for real, only the send into the session is recorded.
describe("delivering the words to the routes", () => {
  const segRows = () => [
    { _id: "s3", transcript_id: "t1", seq: 3, speaker_id: "u1", speaker_name: "Ada", text: "the build is red", t0: 1_000, t1: 2_000 },
    { _id: "s4", transcript_id: "t1", seq: 4, speaker_id: "u1", speaker_name: "Ada", text: "and the deploy waits", t0: 3_000, t1: 4_000 },
  ];
  const huddle = (routes: any[], over: Record<string, unknown> = {}) => ({
    _id: "t1",
    room_key: "channel:chan1",
    team_id: "team1",
    started_by: "ub",
    status: "live",
    // Long ago: the room is quiet by any clock.
    started_at: 1_000,
    routes,
    last_seq: 4,
    ...over,
  });
  const route = (over: Record<string, unknown> = {}) => ({ kind: "session", target: "conv1", mode: "live", sent_seq: 2, added_by: "ub", ...over });
  const actionCtx = (rows: Record<string, any[]>, opts: { sendFails?: number } = {}) => {
    const db = makeFakeDb({
      users: [{ _id: "ua", name: "Ada" }, { _id: "ub", name: "Bo" }],
      conversations: [{ _id: "conv1", short_id: "conv1", title: "Fix the auth race", agent_type: "claude_code", user_id: "ua" }],
      transcript_segments: segRows(),
      call_agent_feeds: [],
      managed_sessions: [],
      ...rows,
    });
    const sends: any[] = [];
    const scheduled: { delay: number; name: string; args: any }[] = [];
    let failuresLeft = opts.sendFails ?? 0;
    const scheduler = { async runAfter(delay: number, ref: unknown, args: any) { scheduled.push({ delay, name: getFunctionName(ref as any), args }); } };
    const inner = { db, scheduler };
    const handlers: Record<string, (args: any) => Promise<any>> = {
      "transcripts:readUnsent": (args) => (readUnsent as any)._handler(inner, args),
      "transcripts:markRouteSent": (args) => (markRouteSent as any)._handler(inner, args),
      "transcripts:dropDeadRoute": (args) => (dropDeadRoute as any)._handler(inner, args),
      "transcripts:deliverToSession": async (args) => {
        if (failuresLeft-- > 0) throw new Error("session send failed");
        sends.push(args);
      },
    };
    const run = (ref: any, args: any) => handlers[getFunctionName(ref)]!(args);
    return { db, scheduler, runQuery: run, runMutation: run, sends, scheduled };
  };

  test("a chunk to a session carries a deterministic client_id, so a repeat delivery dedupes at the insert", async () => {
    const c = actionCtx({ transcripts: [huddle([route()])] });
    await (deliverRoutes as any)._handler(c, { transcript_id: "t1", include_after_routes: false, reason: "flush" });
    expect(c.sends).toHaveLength(1);
    expect(c.sends[0].client_id).toBe(deliveryClientId("t1", "conv1", 4));
    expect(c.sends[0].client_id).toBe("t1:conv1:4");
    expect((await c.db.get("t1" as any)).routes[0].sent_seq).toBe(4);
    // The second run of the same words (a crash before markRouteSent, two
    // overlapping triggers) names the same row; the pending insert returns it.
    const again = actionCtx({ transcripts: [huddle([route()])] });
    await (deliverRoutes as any)._handler(again, { transcript_id: "t1", include_after_routes: false, reason: "flush" });
    expect(again.sends[0].client_id).toBe(c.sends[0].client_id);
    expect(c.scheduled).toHaveLength(0);
  });

  test("the call's final delivery retries with backoff, a bounded number of times", async () => {
    const c = actionCtx({ transcripts: [huddle([route()], { status: "ended" })] }, { sendFails: 1 });
    await (deliverRoutes as any)._handler(c, { transcript_id: "t1", include_after_routes: true });
    expect(c.sends).toHaveLength(0);
    expect((await c.db.get("t1" as any)).routes[0].sent_seq).toBe(2);
    expect(c.scheduled).toEqual([
      { delay: DELIVER_RETRY_MS, name: "transcripts:deliverRoutes", args: { transcript_id: "t1", include_after_routes: true, reason: undefined, attempt: 1 } },
    ]);
    // The retry delivers and schedules nothing more.
    await (deliverRoutes as any)._handler(c, c.scheduled[0].args);
    expect(c.sends).toHaveLength(1);
    expect(c.scheduled).toHaveLength(1);
    // Past the bound a failure is logged and left.
    const spent = actionCtx({ transcripts: [huddle([route()], { status: "ended" })] }, { sendFails: 9 });
    await (deliverRoutes as any)._handler(spent, { transcript_id: "t1", include_after_routes: true, attempt: DELIVER_RETRY_MAX });
    expect(spent.scheduled).toHaveLength(0);
    // A live flush that fails waits for the next flush instead.
    const live = actionCtx({ transcripts: [huddle([route()])] }, { sendFails: 1 });
    await (deliverRoutes as any)._handler(live, { transcript_id: "t1", include_after_routes: false, reason: "flush" });
    expect(live.scheduled).toHaveLength(0);
  });

  test("a catch up that finds the room talking comes back after the quiet window", async () => {
    const spoken = Date.now() - 500;
    const c = actionCtx({ transcripts: [huddle([route()], { started_at: spoken - 4_000 })] });
    await (deliverRoutes as any)._handler(c, { transcript_id: "t1", include_after_routes: false, reason: "settle" });
    expect(c.sends).toHaveLength(0);
    expect(c.scheduled).toEqual([
      { delay: CATCH_UP_QUIET_MS, name: "transcripts:deliverRoutes", args: { transcript_id: "t1", include_after_routes: false, reason: "settle", attempt: 1 } },
    ]);
    // Bounded: the last allowed attempt schedules no further run.
    const last = actionCtx({ transcripts: [huddle([route()], { started_at: spoken - 4_000 })] });
    await (deliverRoutes as any)._handler(last, { transcript_id: "t1", include_after_routes: false, reason: "settle", attempt: DELIVER_RETRY_MAX });
    expect(last.scheduled).toHaveLength(0);
    // A lull flush that declines (busy agent) is the scribe's to retry.
    const busy = actionCtx({
      transcripts: [huddle([route()])],
      managed_sessions: [{ _id: "ms1", conversation_id: "conv1", last_heartbeat: Date.now(), agent_status: "working", agent_status_updated_at: Date.now() }],
    });
    await (deliverRoutes as any)._handler(busy, { transcript_id: "t1", include_after_routes: false, reason: "settle" });
    expect(busy.scheduled).toHaveLength(0);
  });

  test("a killed or gone session loses its route instead of failing on every flush", async () => {
    const c = actionCtx({
      conversations: [
        { _id: "conv1", short_id: "conv1", agent_type: "claude_code", user_id: "ua", inbox_killed_at: 5 },
        { _id: "conv3", short_id: "conv3", agent_type: "claude_code", user_id: "ua" },
      ],
      transcripts: [huddle([route(), route({ target: "conv-gone" }), route({ target: "conv3" })])],
    });
    await (deliverRoutes as any)._handler(c, { transcript_id: "t1", include_after_routes: false, reason: "flush" });
    expect(c.sends.map((s: any) => s.to)).toEqual(["conv3"]);
    expect((await c.db.get("t1" as any)).routes.map((r: any) => r.target)).toEqual(["conv3"]);
  });
});

// The call summary request as prod posts it, for synthetic calls run end to
// end: getForSummary over a fake db, then generateSummary with fetch stubbed.
describe("call summary request goldens", () => {
  const T0 = Date.UTC(2026, 0, 15, 0, 5, 0);
  type CallFixture = {
    case: string;
    rolling?: boolean;
    transcript: Record<string, unknown>;
    lines: Array<{ speaker: string; text: string }>;
  };
  const FIXTURES: CallFixture[] = [
    {
      case: "huddle-ended",
      transcript: { room_key: "channel:ch1", status: "ended", started_at: T0, ended_at: T0 + 23 * 60_000 },
      lines: [
        { speaker: "Ana", text: "Let's decide whether the release goes out Thursday or waits for the migration." },
        { speaker: "Ben", text: "The migration is done on staging, I'd ship Thursday behind a flag." },
        { speaker: "Ana", text: "Fine. Ben, you own the flag. I'll write the rollback note." },
        { speaker: "Cy", text: "I'll watch the error rate for the first hour after it ships." },
      ],
    },
    {
      // Over 60,000 characters, so the model reads only the tail; one
      // microphone, so no speaker names reach the prompt.
      case: "recording-long-tail",
      transcript: { room_key: "rec:0a1b2c3d-0000-4000-8000-000000000001", status: "ended", started_at: T0, ended_at: T0 + 95 * 60_000 },
      lines: Array.from({ length: 1300 }, (_, i) => ({
        speaker: "Speaker",
        text: `point ${String(i + 1).padStart(4, "0")} about the rollout plan, who owns it and what ships next`,
      })),
    },
    {
      case: "huddle-rolling-live",
      rolling: true,
      transcript: { room_key: "dm:u1:u2", status: "live", started_at: T0 },
      lines: [
        { speaker: "Ana", text: "Quick sync on the onboarding emails before the design review this afternoon." },
        { speaker: "Ben", text: "The second email still links the old docs page, I will fix that today and send the copy for review." },
        { speaker: "Ana", text: "Good, and I want the third email cut entirely." },
      ],
    },
  ];
  const SKIPPED: CallFixture = {
    case: "under-forty-words",
    transcript: { room_key: "channel:ch1", status: "ended", started_at: T0, ended_at: T0 + 60_000 },
    lines: [{ speaker: "Ana", text: "Can you hear me? Okay, let's talk later." }],
  };

  const capture = captureFetch('{"title":"t","summary":"s","action_items":[]}');
  beforeEach(() => capture.install());
  afterEach(() => capture.restore());

  /** Run the query and the action; the bodies posted and the verdicts written. */
  async function runSummary(fixture: CallFixture) {
    const db = makeFakeDb({
      transcripts: [{ _id: "t1", title: "Call", participants: [], ...fixture.transcript }],
      transcript_segments: fixture.lines.map((l, i) => ({ _id: `s${i}`, transcript_id: "t1", seq: i + 1, speaker_name: l.speaker, text: l.text })),
    });
    const verdicts: any[] = [];
    const ctx = {
      runQuery: async (ref: any, args: any) => {
        expect(getFunctionName(ref)).toBe("transcripts:getForSummary");
        return (getForSummary as any)._handler({ db }, args);
      },
      runMutation: async (_ref: any, args: any) => { verdicts.push(args); },
    };
    const before = capture.bodies.length;
    await (generateSummary as any)._handler(ctx, { transcript_id: "t1", ...(fixture.rolling ? { rolling: true } : {}) });
    return { bodies: capture.bodies.slice(before), verdicts };
  }

  test("the action posts the recorded body for every fixture", async () => {
    const actual: GoldenCase[] = [];
    for (const fixture of FIXTURES) {
      const { bodies, verdicts } = await runSummary(fixture);
      expect(bodies).toHaveLength(1);
      expect(verdicts.map((v) => v.summary_status)).toEqual(["done"]);
      actual.push({ case: fixture.case, body: bodies[0]! });
    }
    expect(actual).toEqual(recordGolden("call-summary", actual));
  });

  test("a call under forty words is skipped without a model call", async () => {
    const { bodies, verdicts } = await runSummary(SKIPPED);
    expect(bodies).toEqual([]);
    expect(verdicts.map((v) => v.summary_status)).toEqual(["skipped"]);
    expect(callSummarySource(SKIPPED.lines, "huddle")).toBeNull();
  });

  test("the shared builders render the same body from the same facts", () => {
    const actual: GoldenCase[] = [];
    for (const fixture of FIXTURES) {
      const t = fixture.transcript as { room_key: string; started_at: number; ended_at?: number };
      const kind = callSummaryKind(t.room_key);
      const source = callSummarySource(fixture.lines, kind);
      expect(source).not.toBeNull();
      const req = callSummaryRequest(source!, { kind, started_at: t.started_at, ended_at: t.ended_at, rolling: fixture.rolling });
      expect(req.temperature).toBeUndefined();
      actual.push({ case: fixture.case, body: goldenBody(req) });
    }
    expect(actual).toEqual(recordGolden("call-summary", actual));
  });

  test("a long call keeps the tail, and a recording names no speaker", () => {
    const long = FIXTURES.find((f) => f.case === "recording-long-tail")!;
    const source = callSummarySource(long.lines, "recording")!;
    expect(source.length).toBe(60_000);
    expect(source.endsWith("point 1300 about the rollout plan, who owns it and what ships next")).toBe(true);
    expect(source).not.toContain("Speaker:");
    expect(callSummarySource(FIXTURES[0]!.lines, "huddle")!.startsWith("Ana: ")).toBe(true);
  });
});

// A live feed sends a chunk at every pause, so the full framing rides only the
// first chunk on a route and every Nth after it; the route counts the chunks
// since the last full one.
describe("markRouteSent briefing count", () => {
  test("a full brief resets the count, a short header adds one, other routes are untouched", async () => {
    const db = makeFakeDb({
      transcripts: [{
        _id: "t1",
        routes: [
          { kind: "session", target: "conv1", mode: "live", sent_seq: 0 },
          { kind: "doc", target: "d1", mode: "live", sent_seq: 0 },
        ],
      }],
    });
    const send = (sent_seq: number, full_brief?: boolean) =>
      (markRouteSent as any)._handler({ db }, { transcript_id: "t1", kind: "session", target: "conv1", sent_seq, full_brief });
    await send(2, true);
    await send(4, false);
    await send(6, false);
    let t = await db.get("t1" as any);
    expect(t.routes[0]).toMatchObject({ sent_seq: 6, briefed_chunks: 3 });
    expect(t.routes[1].briefed_chunks).toBeUndefined();
    await send(8, true);
    t = await db.get("t1" as any);
    expect(t.routes[0].briefed_chunks).toBe(1);
  });
});

// A call named in prose (`cl-7`, `cl-7:2-3`) resolves through the same door
// as the call page: canReadCall. The pill and the embedded excerpt read it.
describe("call references (cl-N)", () => {
  const REC = "rec:1f8e7d6c-1234-4abc-9def-0123456789ab";
  const row = (over: Record<string, unknown> = {}) => ({
    _id: "tr_rec",
    short_id: "cl-7",
    room_key: REC,
    team_id: "teamA",
    started_by: "ua",
    status: "ended",
    started_at: 2_000,
    ended_at: 3_000,
    title: "Pricing sync",
    routes: [],
    last_seq: 3,
    ...over,
  });
  const segs = [1, 2, 3].map((seq) => ({
    _id: `s${seq}`,
    _creationTime: seq,
    transcript_id: "tr_rec",
    seq,
    speaker_id: "ua",
    speaker_name: "Ada",
    text: `line ${seq}`,
    t0: seq * 1000,
    t1: seq * 1000 + 900,
  }));
  const ctxFor = (user: string, rows: any[]) => ({
    db: makeFakeDb({
      transcripts: rows,
      team_memberships: [{ user_id: "ua", team_id: "teamA" }, { user_id: "ub", team_id: "teamA" }],
      teams: [{ _id: "teamA", features: { calls: true } }],
      transcript_segments: segs,
    }),
    auth: {
      async getUserIdentity() {
        return { subject: `${user}|session` };
      },
    },
  });
  const call = (fn: any, c: any, args: any = {}) => (fn as any)._handler(c, args);

  test("the short id names the call; no lines asked, none sent", async () => {
    const out = await call(webGetCallRef, ctxFor("ua", [row()]), { ref: "CL-7" });
    expect(out?._id).toBe("tr_rec");
    expect(out?.title).toBe("Pricing sync");
    expect(out?.turns).toBeNull();
  });

  test("a line range carries the attributed words", async () => {
    const out = await call(webGetCallRef, ctxFor("ua", [row()]), { ref: "cl-7", from_seq: 3, to_seq: 2 });
    expect(out?.turns?.from_seq).toBe(2);
    expect(out?.turns?.to_seq).toBe(3);
    expect(out?.turns?.segments[0]).toMatchObject({ speaker_name: "Ada", text: expect.stringMatching(/^line/), t1: expect.any(Number) });
  });

  // A moment's card is captioned with the line said then, by the rule `cast
  // call snap` names a frame's line by (lineSaidAt over the whole list), found
  // by a search over seq rather than a read of every line.
  test("a moment carries the line the CLI would name, on a long call", async () => {
    // 41 lines, 3s apart, each 2s long; line 20 overlaps 21 (talked over).
    const many = Array.from({ length: 41 }, (_, i) => {
      const seq = i + 1;
      return { _id: `m${seq}`, _creationTime: seq, transcript_id: "tr_rec", seq, speaker_id: "ua", speaker_name: "Ada", text: `line ${seq}`, t0: seq * 3000, t1: seq * 3000 + (seq === 20 ? 4500 : 2000) };
    });
    const c = {
      ...ctxFor("ua", [row({ last_seq: 41 })]),
      db: makeFakeDb({
        transcripts: [row({ last_seq: 41 })],
        team_memberships: [{ user_id: "ua", team_id: "teamA" }],
        teams: [{ _id: "teamA", features: { calls: true } }],
        transcript_segments: many,
      }),
    };
    for (const at of [0, 2_999, 3_000, 4_999, 5_500, 61_000, 63_100, 64_000, 64_600, 70_000, 125_000, 143_000, 200_000]) {
      const out = await call(webGetCallRef, c, { ref: "cl-7", at_ms: at });
      const want = lineSaidAt(many, at);
      expect(out?.line ? { seq: out.line.seq, during: out.line.during } : null).toEqual(want ? { seq: many[want.index].seq, during: want.during } : null);
    }
    // Spot checks of what that rule says, so the loop above is not vacuous.
    // Talked over: the line begun first is still the one being said.
    expect((await call(webGetCallRef, c, { ref: "cl-7", at_ms: 64_000 }))?.line).toMatchObject({ seq: 20, during: true, text: "line 20" });
    expect((await call(webGetCallRef, c, { ref: "cl-7", at_ms: 64_600 }))?.line).toMatchObject({ seq: 21, during: true });
    expect((await call(webGetCallRef, c, { ref: "cl-7", at_ms: 125_000 }))?.line).toMatchObject({ seq: 41, during: false });
    expect((await call(webGetCallRef, c, { ref: "cl-7", at_ms: 200_000 }))?.line).toBeNull();
    expect((await call(webGetCallRef, c, { ref: "cl-7", at_ms: 1_000 }))?.line).toBeNull();
  });

  // Every open pill, excerpt and frame card of a live call re-runs on each
  // batch of lines (the query reads the call's row, which writeSegments
  // patches). The answer must not change unless something it shows did, or
  // each re-run is a push and every reference re-renders for the whole call.
  test("a new line on a live call leaves a frame's answer unchanged", async () => {
    const c = ctxFor("ua", [row({ status: "live", ended_at: undefined })]);
    const before = await call(webGetCallRef, c, { ref: "cl-7", at_ms: 5_000 });
    const live = await c.db.get("tr_rec");
    await writeSegments(c, live, [{ speaker_id: "ua", speaker_name: "Ada", text: "line 4", t0: 9_000, t1: 9_500 }]);
    expect((await c.db.get("tr_rec"))?.last_seq).toBe(4);
    expect(await call(webGetCallRef, c, { ref: "cl-7", at_ms: 5_000 })).toEqual(before);
  });

  test("a reader the call page refuses gets nothing from a mention either", async () => {
    expect(await call(webGetCallRef, ctxFor("ub", [row()]), { ref: "cl-7", from_seq: 1, to_seq: 3 })).toBeNull();
    expect(await call(webGetCallRef, ctxFor("ua", [row()]), { ref: "cl-8" })).toBeNull();
  });

  test("the backfill numbers older calls in the order they happened", async () => {
    const c = ctxFor("ua", [
      row({ _id: "b", started_at: 5_000, short_id: undefined }),
      row({ _id: "a", started_at: 4_000, short_id: undefined }),
    ]);
    expect(await call(backfillCallShortIds, c, {})).toEqual({ assigned: 2 });
    expect((await c.db.get("a" as any)).short_id).toBe("cl-1");
    expect((await c.db.get("b" as any)).short_id).toBe("cl-2");
  });
});

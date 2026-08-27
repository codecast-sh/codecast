import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import {
  appendRecordingSegments,
  attachRecording,
  beat,
  finishRecordingTranscript,
  huddleDigestTarget,
  needsServerTranscription,
  parseTranscriptionSegments,
  recLeaseExpired,
  setSummary,
} from "./transcripts";
import { makeFakeDb } from "./testDb";
import {
  CALL_MEMBER_STALE_MS,
  MAX_RECORDING_MS,
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
    expect(recLeaseExpired({ started_at: now - CALL_MEMBER_STALE_MS - 1 }, now)).toBe(true);
  });

  test("the window is a seat's, so a missed beat reads exactly like a missed lease", () => {
    expect(recLeaseExpired({ started_at: 0, last_beat: now - CALL_MEMBER_STALE_MS + 1 }, now)).toBe(false);
    expect(recLeaseExpired({ started_at: 0, last_beat: now - CALL_MEMBER_STALE_MS }, now)).toBe(true);
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
      db: makeFakeDb({ transcripts: rows }),
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
  const ctx = (rows: any[], segments: any[] = []) => {
    const scheduled: { name: string; args: any }[] = [];
    return {
      db: makeFakeDb({ transcripts: rows, transcript_segments: segments, users: [], push_outbox: [] }),
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

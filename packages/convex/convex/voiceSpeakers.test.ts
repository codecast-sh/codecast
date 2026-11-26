// Engine C end to end with fake vendors: a voice note on a team with the
// voice_speakers feature is read again by Scribe (words on their speakers),
// its voices are named by our CAM++ worker against opted-in teammates, and
// every failure falls back to what the note would have had without it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { parseScribeReply, SCRIBE_INLINE_MAX_BYTES, scribeLanguageCode } from "./lib/scribe";
import { campplusEngine, runSpeechPipeline, scribeWordsSource } from "./lib/speechPipeline";

const realFetch = globalThis.fetch;
const ENV = ["ELEVENLABS_API_KEY", "SPEECH_WORKER_URL", "SPEECH_WORKER_SECRET", "OPENAI_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

// Two people: Ann (spk:0, 0-4 s) then Bob (spk:1, 4.6-9 s).
const scribeWords = () => {
  const words: any[] = [];
  for (let t = 0; t < 4; t += 0.4) words.push({ text: "ann", start: t, end: t + 0.3, type: "word", speaker_id: "speaker_7" });
  words.push({ text: " ", start: 4.3, end: 4.6, type: "spacing", speaker_id: "speaker_7" });
  for (let t = 4.6; t < 9; t += 0.4) words.push({ text: "bob", start: t, end: t + 0.3, type: "word", speaker_id: "speaker_2" });
  return words;
};
// CAM++ vectors are 512-d (the deployed worker, and the lab fixtures).
const BOB = Array.from({ length: 512 }, (_, i) => Math.sin(i + 1));
const OTHER = Array.from({ length: 512 }, (_, i) => Math.cos(3 * i));

type Mode = { scribe: "ok" | "fail" | "empty"; worker: "ok" | "down" };
let mode: Mode;
let calls: Array<{ url: string; body: any }>;

beforeEach(() => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  process.env.ELEVENLABS_API_KEY = "test-11";
  process.env.SPEECH_WORKER_URL = "https://worker.test";
  process.env.SPEECH_WORKER_SECRET = "s3";
  process.env.OPENAI_API_KEY = "test-oa";
  mode = { scribe: "ok", worker: "ok" };
  calls = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const body = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"])) : init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.startsWith("https://api.elevenlabs.io/v1/speech-to-text")) {
      if (mode.scribe === "fail") return new Response("upstream down", { status: 503 });
      return Response.json({ language_code: "eng", words: mode.scribe === "empty" ? [] : scribeWords() });
    }
    if (url === "https://worker.test/embed") {
      if (mode.worker === "down") throw new TypeError("fetch failed");
      const vectors: Record<string, Array<number[] | null>> = {};
      for (const span of body.spans) vectors[span.key] = span.windows.map(() => (span.key === "spk:1" ? BOB : OTHER));
      return Response.json({ model: "campplus-v1", vectors });
    }
    if (url.startsWith("https://api.openai.com/")) {
      return Response.json({ text: "whisper words", segments: [{ start: 0, end: 1, text: "whisper words" }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
});

// Every test's world. A test that only asks what got scheduled leaves the
// scheduled action to run on convex-test's real timer, where it would call this
// file's fakes during a later test; each test's leftovers are settled here.
const worlds: any[] = [];
const pendingJobs = (t: any) =>
  t.run(async (ctx: any) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.state.kind === "pending"));

afterEach(async () => {
  for (const t of worlds.splice(0)) {
    for (let jobs = await pendingJobs(t); ; jobs = await pendingJobs(t)) {
      await t.run(async (ctx: any) => { for (const f of jobs) await ctx.scheduler.cancel(f._id); });
      await t.finishInProgressScheduledFunctions();
      if (!(await pendingJobs(t)).length) break;
    }
  }
  globalThis.fetch = realFetch;
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function world(opts: { feature?: boolean; liveLines?: boolean; bobPrint?: number[]; audioBytes?: number } = {}) {
  const t = convexTest(schema, allModules);
  worlds.push(t);
  const audio = new Blob([new Uint8Array(opts.audioBytes ?? 4)], { type: "audio/mp4" });
  const ids = await t.run(async (ctx) => {
    const ann = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
    const bob = await ctx.db.insert("users", { name: "Bob", email: "bob@x.dev", voice_id_enabled: true } as any);
    const team = await ctx.db.insert("teams", {
      name: "T", invite_code: "TEAM1234", created_at: 1, features: { calls: true, ...(opts.feature === false ? {} : { voice_speakers: true }) },
    } as any);
    await ctx.db.insert("team_memberships", { user_id: ann, team_id: team, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: bob, team_id: team, role: "member", joined_at: 1 } as any);
    const storage = await ctx.storage.store(audio);
    const rec = await ctx.db.insert("transcripts", {
      room_key: `rec:${crypto.randomUUID()}`, team_id: team, started_by: ann, status: "ended",
      started_at: Date.now() - 60_000, ended_at: Date.now() - 50_000, routes: [], last_seq: opts.liveLines === false ? 0 : 2, short_id: "cl-5",
      recording_storage_id: storage,
    } as any);
    if (opts.liveLines !== false) {
      for (const seq of [1, 2]) {
        await ctx.db.insert("transcript_segments", { transcript_id: rec, seq, speaker_id: "mic", speaker_name: "Ann", text: `live ${seq}`, t0: seq, t1: seq + 1 });
      }
    }
    await ctx.db.insert("voiceprints", {
      user_id: bob, engine: "campplus-v1", vector: opts.bobPrint ?? BOB, seconds: 6,
      source: { transcript_id: rec, key: "spk:9", kind: "self" }, created_at: 1,
    });
    return { ann, bob, team, rec, storage };
  });
  return { t, ids, as: t.withIdentity({ subject: `${ids.ann}|session` }) };
}

const read = (t: any, rec: Id<"transcripts">) =>
  t.run(async (ctx: any) => ({
    row: await ctx.db.get(rec),
    segs: await ctx.db.query("transcript_segments").withIndex("by_transcript_seq", (q: any) => q.eq("transcript_id", rec)).collect(),
  }));
const scheduled = (t: any, name: string) =>
  t.run(async (ctx: any) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes(name)).length);
// A job a test only counts must not run after it: convex-test fires it on a
// real timer, so it would call whatever fetch a later test has stubbed.
const cancelScheduled = async (t: any) => {
  await t.run(async (ctx: any) => {
    for (const f of await ctx.db.system.query("_scheduled_functions").collect()) if (f.state.kind === "pending") await ctx.scheduler.cancel(f._id);
  });
  await t.finishInProgressScheduledFunctions();
};

describe("Scribe reply parsing", () => {
  test("words only, speakers as spk keys in order of first appearance, junk skipped", () => {
    const r = parseScribeReply({
      language_code: "eng",
      words: [
        { text: "hi", start: 0, end: 0.2, type: "word", speaker_id: "speaker_3" },
        { text: " ", start: 0.2, end: 0.3, type: "spacing" },
        { text: "(laughs)", start: 0.3, end: 0.5, type: "audio_event" },
        { text: "there", start: 0.4, end: 0.6, type: "word" },
        { text: "yo", start: 2, end: 2.2, type: "word", speaker_id: "speaker_0" },
        { text: "x", type: "word" },
        null,
      ],
    });
    expect(r.words).toEqual([
      { text: "hi", start: 0, end: 0.2, key: "spk:0" },
      { text: "there", start: 0.4, end: 0.6, key: "spk:0" },
      { text: "yo", start: 2, end: 2.2, key: "spk:1" },
    ]);
    expect(r.turns).toEqual([{ key: "spk:0", start: 0, end: 0.6 }, { key: "spk:1", start: 2, end: 2.2 }]);
    expect(r.language).toBe("eng");
    expect(parseScribeReply("nonsense")).toEqual({ words: [], turns: [], language: null });
  });

  test("a language is pinned only when the room has exactly one", () => {
    expect(scribeLanguageCode(["en"])).toBe("en");
    expect(scribeLanguageCode(["en", "en"])).toBe("en");
    expect(scribeLanguageCode(["en", "es"])).toBeNull();
    expect(scribeLanguageCode([])).toBeNull();
  });
});

describe("voice_speakers flag", () => {
  test("on: attaching audio schedules the engine C pass even for a note with live words", async () => {
    const { t, ids, as } = await world();
    await t.run((ctx) => ctx.db.patch(ids.rec, { recording_storage_id: undefined }));
    await as.mutation(api.transcripts.attachRecording, { transcript_id: ids.rec, storage_id: ids.storage });
    expect(await scheduled(t, "transcribeVoiceNote")).toBe(1);
    expect(await scheduled(t, "transcribeRecording")).toBe(0);
    expect((await read(t, ids.rec)).row.transcribe_status).toBe("pending");
    await cancelScheduled(t);
  });

  test("off: today's path unchanged (a note with live words is left alone)", async () => {
    const { t, ids, as } = await world({ feature: false });
    await t.run((ctx) => ctx.db.patch(ids.rec, { recording_storage_id: undefined }));
    await as.mutation(api.transcripts.attachRecording, { transcript_id: ids.rec, storage_id: ids.storage });
    expect(await scheduled(t, "transcribeVoiceNote")).toBe(0);
    expect(await scheduled(t, "transcribeRecording")).toBe(0);
  });
});

describe("transcribeVoiceNote", () => {
  test("Scribe's words on their speakers replace the live lines; the worker names Bob", async () => {
    const { t, ids } = await world();
    await t.action(internal.transcripts.transcribeVoiceNote, { transcript_id: ids.rec });
    const { row, segs } = await read(t, ids.rec);
    expect(segs.map((s: any) => [s.seq, s.speaker_id, s.speaker_name])).toEqual([[3, "spk:0", "Speaker 1"], [4, "spk:1", "Speaker 2"]]);
    expect(segs[0].text.startsWith("ann ann")).toBe(true);
    expect(row.speakers).toEqual([
      { key: "spk:0", source: "voice" },
      { key: "spk:1", user_id: ids.bob, source: "voice", score: expect.any(Number) },
    ]);
    expect(row.speakers[1].score).toBeGreaterThan(0.99);
    expect(row.transcribe_status).toBe("done");
    // Scribe asked as specified; the worker got each voice's clean windows.
    const scribe = calls.find((c) => c.url.includes("speech-to-text"))!;
    expect(scribe.body).toMatchObject({ model_id: "scribe_v3", diarize: "true", timestamps_granularity: "word", tag_audio_events: "false", file: "<file>" });
    expect(scribe.body.language_code).toBeUndefined();
    const embed = calls.find((c) => c.url === "https://worker.test/embed")!;
    expect(embed.body.spans.map((s: any) => s.key)).toEqual(["spk:0", "spk:1"]);
    expect(embed.body.spans[0].windows[0][0]).toBeCloseTo(0.1, 6);
  });

  test("a voice nobody resembles enough stays unnamed", async () => {
    const { t, ids } = await world({ bobPrint: OTHER.map((x) => -x) });
    await t.action(internal.transcripts.transcribeVoiceNote, { transcript_id: ids.rec });
    const { row } = await read(t, ids.rec);
    expect(row.speakers).toEqual([{ key: "spk:0", source: "voice" }, { key: "spk:1", source: "voice" }]);
  });

  test("worker unreachable: the lines still go on their speakers, nobody named", async () => {
    const { t, ids } = await world();
    mode.worker = "down";
    await t.action(internal.transcripts.transcribeVoiceNote, { transcript_id: ids.rec });
    const { row, segs } = await read(t, ids.rec);
    expect(segs.map((s: any) => s.speaker_id)).toEqual(["spk:0", "spk:1"]);
    expect(row.speakers).toEqual([{ key: "spk:0", source: "voice" }, { key: "spk:1", source: "voice" }]);
    expect(row.transcribe_status).toBe("done");
  });

  test("Scribe fails on a note with live words: the live lines stand", async () => {
    const { t, ids } = await world();
    mode.scribe = "fail";
    await t.action(internal.transcripts.transcribeVoiceNote, { transcript_id: ids.rec });
    const { row, segs } = await read(t, ids.rec);
    expect(segs.map((s: any) => s.text)).toEqual(["live 1", "live 2"]);
    expect(row.speakers).toBeUndefined();
    expect(row.transcribe_status).toBe("done");
  });

  test("Scribe fails on a note with no words: whisper reads it, as without the feature", async () => {
    const { t, ids } = await world({ liveLines: false });
    mode.scribe = "fail";
    await t.action(internal.transcripts.transcribeVoiceNote, { transcript_id: ids.rec });
    const { row, segs } = await read(t, ids.rec);
    expect(segs.map((s: any) => s.text)).toEqual(["whisper words"]);
    expect(row.transcribe_status).toBe("done");
    expect(calls.some((c) => c.url.startsWith("https://api.openai.com/"))).toBe(true);
  });

  test("a regulated team without a BAA never reaches ElevenLabs", async () => {
    const { t, ids } = await world();
    await t.run((ctx) => ctx.db.patch(ids.team, { policy: { regulated_data: true } } as any));
    await t.action(internal.transcripts.transcribeVoiceNote, { transcript_id: ids.rec });
    expect(calls.some((c) => c.url.includes("elevenlabs"))).toBe(false);
    expect((await read(t, ids.rec)).segs.map((s: any) => s.text)).toEqual(["live 1", "live 2"]);
  });
});

describe("limits and idempotency", () => {
  const pipelineCtx = (t: any) => ({
    runQuery: (ref: any, args: any) => t.query(ref, args),
    runMutation: (ref: any, args: any) => t.mutation(ref, args),
    storage: {
      get: async () => {
        throw new Error("the audio must not be read into the action");
      },
      getUrl: async () => "https://storage.test/audio",
    },
  });

  test("a note above the inline cap goes to Scribe by URL and is never read into the action", async () => {
    const { t, ids } = await world({ audioBytes: SCRIBE_INLINE_MAX_BYTES + 1 });
    const gate = { ctx: { runQuery: (ref: any, args: any) => t.query(ref, args) }, scope: { row: { table: "transcripts", id: ids.rec } } };
    expect(await runSpeechPipeline(pipelineCtx(t) as any, { _id: ids.rec }, { words: scribeWordsSource(gate), speakers: campplusEngine(), deadline: Date.now() + 540_000 })).toBe(true);
    const scribe = calls.find((c) => c.url.includes("speech-to-text"))!;
    expect(scribe.body.cloud_storage_url).toBe("https://storage.test/audio");
    expect(scribe.body.file).toBeUndefined();
  });

  test("under a minute left, naming is skipped and the lines are written unnamed", async () => {
    const { t, ids } = await world({ audioBytes: SCRIBE_INLINE_MAX_BYTES + 1 });
    const gate = { ctx: { runQuery: (ref: any, args: any) => t.query(ref, args) }, scope: { row: { table: "transcripts", id: ids.rec } } };
    await runSpeechPipeline(pipelineCtx(t) as any, { _id: ids.rec }, { words: scribeWordsSource(gate), speakers: campplusEngine(), deadline: Date.now() + 30_000 });
    expect(calls.some((c) => c.url === "https://worker.test/embed")).toBe(false);
    const { row, segs } = await read(t, ids.rec);
    expect(segs.map((s: any) => s.speaker_id)).toEqual(["spk:0", "spk:1"]);
    expect(row.speakers).toEqual([{ key: "spk:0", source: "voice" }, { key: "spk:1", source: "voice" }]);
  });

  test("attaching the same audio twice, or to a diarized note, schedules nothing more", async () => {
    const { t, ids, as } = await world();
    await t.run((ctx) => ctx.db.patch(ids.rec, { recording_storage_id: undefined }));
    await as.mutation(api.transcripts.attachRecording, { transcript_id: ids.rec, storage_id: ids.storage });
    await as.mutation(api.transcripts.attachRecording, { transcript_id: ids.rec, storage_id: ids.storage });
    expect(await scheduled(t, "transcribeVoiceNote")).toBe(1);
    const other = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(4)], { type: "audio/mp4" })));
    await t.run((ctx) => ctx.db.patch(ids.rec, { speakers: [{ key: "spk:0", source: "voice" as const }] }));
    await as.mutation(api.transcripts.attachRecording, { transcript_id: ids.rec, storage_id: other });
    expect(await scheduled(t, "transcribeVoiceNote")).toBe(1);
    await cancelScheduled(t);
  });

  test("candidates come as one centroid per person", async () => {
    const { t, ids } = await world();
    await t.run((ctx) =>
      ctx.db.insert("voiceprints", { user_id: ids.bob, engine: "campplus-v1", vector: OTHER, seconds: 4, source: { transcript_id: ids.rec, key: "spk:9", kind: "self" }, created_at: 2 }),
    );
    const [bob] = await t.query(internal.voiceprints.candidatesForTeam, { team_id: ids.team, engine: "campplus-v1" });
    expect(bob!.samples).toBe(2);
    expect(bob!.centroid).toHaveLength(512);
    expect(bob!.centroid[3]).toBeCloseTo((BOB[3]! + OTHER[3]!) / 2, 9);
  });
});

describe("enrollFromSpeaker", () => {
  const enroll = (t: any, ids: any, key: string, match_required: boolean) =>
    t.action(internal.voiceprints.enrollFromSpeaker, { transcript_id: ids.rec, key, user_id: ids.bob, kind: "assigned", match_required });
  const bobRows = (t: any, ids: any) =>
    t.run(async (ctx: any) => (await ctx.db.query("voiceprints").withIndex("by_user", (q: any) => q.eq("user_id", ids.bob)).collect()).length);

  test("a voice's clean windows become samples; a confirmation needs a match against the existing voice", async () => {
    const { t, ids } = await world();
    await t.action(internal.transcripts.transcribeVoiceNote, { transcript_id: ids.rec });
    expect(await bobRows(t, ids)).toBe(1);
    // spk:0 sounds like OTHER, not Bob's print: a confirmation is refused.
    await enroll(t, ids, "spk:0", true);
    expect(await bobRows(t, ids)).toBe(1);
    // spk:1 matches Bob: the confirmation adds its windows.
    await enroll(t, ids, "spk:1", true);
    const added = await bobRows(t, ids);
    expect(added).toBeGreaterThan(1);
    const embed = calls.filter((c) => c.url === "https://worker.test/embed").at(-1)!;
    expect(embed.body.spans).toHaveLength(1);
    expect(embed.body.spans[0].key).toBe("spk:1");
  });

  test("nothing is stored when the worker is down or the person turned recognition off", async () => {
    const { t, ids } = await world();
    await t.action(internal.transcripts.transcribeVoiceNote, { transcript_id: ids.rec });
    mode.worker = "down";
    await enroll(t, ids, "spk:1", false);
    expect(await bobRows(t, ids)).toBe(1);
    mode.worker = "ok";
    await t.run((ctx) => ctx.db.patch(ids.bob, { voice_id_enabled: false }));
    await enroll(t, ids, "spk:1", false);
    expect(await bobRows(t, ids)).toBe(1);
  });
});

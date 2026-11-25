// Speaker attribution for voice notes (docs/architecture/speaker-attribution.md):
// a person's corrections (assign, confirm, move a line), who may make them,
// voiceprint consent, and the batch pass skeleton run with fake engines.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { runSpeechPipeline, type SpeakerEngine, type WordsSource } from "./lib/speechPipeline";

async function world(extra: Record<string, unknown> = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
    const mate = await ctx.db.insert("users", { name: "Bob", email: "bob@x.dev", voice_id_enabled: true } as any);
    const stranger = await ctx.db.insert("users", { name: "Eve", email: "eve@x.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "T", invite_code: "TEAM1234", created_at: 1, features: { calls: true } } as any);
    const other = await ctx.db.insert("teams", { name: "O", invite_code: "TEAM5678", created_at: 1, features: { calls: true } } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: mate, team_id: team, role: "member", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: stranger, team_id: other, role: "member", joined_at: 1 } as any);
    const rec = await ctx.db.insert("transcripts", {
      room_key: `rec:${crypto.randomUUID()}`, team_id: team, started_by: owner, status: "ended",
      started_at: Date.now() - 60_000, ended_at: Date.now() - 50_000, routes: [], last_seq: 3, short_id: "cl-77",
      speakers: [
        { key: "spk:0", source: "voice" },
        { key: "spk:1", user_id: mate, source: "voice", score: 0.8 },
      ],
      ...extra,
    } as any);
    const seg = (seq: number, speaker_id: string, text: string) =>
      ctx.db.insert("transcript_segments", {
        transcript_id: rec, seq, speaker_id, speaker_name: speaker_id === "spk:0" ? "Speaker 1" : "Speaker 2", text, t0: seq * 1000, t1: seq * 1000 + 900,
      });
    await seg(1, "spk:0", "we should ship friday");
    await seg(2, "spk:1", "I will write the notes");
    await seg(3, "spk:0", "great");
    return { owner, mate, stranger, team, rec };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|session` });
  return { t, ids, as };
}

describe("assignSpeaker", () => {
  test("the creator names a voice and every read path follows", async () => {
    const { t, ids, as } = await world({ routes: [{ kind: "doc", target: "d1", mode: "after", sent_seq: 0 }] });
    await as(ids.owner).mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:0", user_id: ids.owner });
    const call: any = await as(ids.owner).query(api.transcripts.webGetCall, { transcript_id: ids.rec });
    expect(call.speakers).toEqual([
      { key: "spk:0", user_id: ids.owner, source: "person" },
      { key: "spk:1", user_id: ids.mate, source: "voice", score: 0.8 },
    ]);
    // The names of every teammate the speakers name, for callSpeakerRoster.
    expect(call.speaker_names).toEqual({ [ids.owner]: "Ann", [ids.mate]: "Bob" });
    // The web reads segments as written and names them itself.
    expect(call.segments[0].speaker_name).toBe("Speaker 1");
    const ref: any = await as(ids.owner).query(api.transcripts.webGetCallRef, { ref: "cl-77", from_seq: 1, to_seq: 3 });
    expect(ref.turns.segments.map((s: any) => s.speaker_name)).toEqual(["Ann", "Bob", "Ann"]);
    const forSummary: any = await t.query(internal.transcripts.getForSummary, { transcript_id: ids.rec });
    expect(forSummary.kind).toBe("diarized");
    expect(forSummary.lines.map((l: any) => l.speaker)).toEqual(["Ann", "Bob", "Ann"]);
    const unsent: any = await t.query(internal.transcripts.readUnsent, { transcript_id: ids.rec });
    expect(unsent.segments.map((s: any) => s.speaker_name)).toEqual(["Ann", "Bob", "Ann"]);
  });

  test("a typed name, a clear, and exactly one of the three", async () => {
    const { ids, as } = await world();
    const me = as(ids.owner);
    await me.mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:1", name: "  Visitor  " });
    let call: any = await me.query(api.transcripts.webGetCall, { transcript_id: ids.rec });
    expect(call.speakers[1]).toEqual({ key: "spk:1", name: "Visitor", source: "person" });
    await me.mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:1", clear: true });
    call = await me.query(api.transcripts.webGetCall, { transcript_id: ids.rec });
    expect(call.speakers[1]).toEqual({ key: "spk:1", source: "person" });
    await expect(me.mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:1" })).rejects.toThrow(/exactly one/);
    await expect(me.mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:1", name: "x", clear: true })).rejects.toThrow(/exactly one/);
    await expect(me.mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:9", clear: true })).rejects.toThrow(/No such speaker/);
  });

  test("only a member of the recording's team may be named", async () => {
    const { ids, as } = await world();
    await expect(
      as(ids.owner).mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:0", user_id: ids.stranger }),
    ).rejects.toThrow(/not on this call's team/);
  });

  test("a teammate may correct only once the recording is shared with the team", async () => {
    const { t, ids, as } = await world();
    const args = { transcript_id: ids.rec, key: "spk:0", user_id: ids.mate };
    await expect(as(ids.mate).mutation(api.transcripts.assignSpeaker, args)).rejects.toThrow(/Call not found/);
    await t.run((ctx) => ctx.db.patch(ids.rec, { rec_shared: true }));
    await as(ids.mate).mutation(api.transcripts.assignSpeaker, args);
    await expect(as(ids.stranger).mutation(api.transcripts.assignSpeaker, args)).rejects.toThrow(/Call not found/);
  });

  test("a huddle's speakers cannot be relabeled", async () => {
    const { t, ids, as } = await world();
    await t.run((ctx) => ctx.db.patch(ids.rec, { room_key: `team:${ids.team}` }));
    await expect(
      as(ids.owner).mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:0", clear: true }),
    ).rejects.toThrow();
  });
});

describe("confirmSpeaker", () => {
  test("a suggestion becomes a person's word; nothing else confirms", async () => {
    const { ids, as } = await world();
    const me = as(ids.owner);
    await me.mutation(api.transcripts.confirmSpeaker, { transcript_id: ids.rec, key: "spk:1" });
    const call: any = await me.query(api.transcripts.webGetCall, { transcript_id: ids.rec });
    expect(call.speakers[1]).toEqual({ key: "spk:1", user_id: ids.mate, source: "person" });
    await expect(me.mutation(api.transcripts.confirmSpeaker, { transcript_id: ids.rec, key: "spk:1" })).rejects.toThrow(/Nothing to confirm/);
    await expect(me.mutation(api.transcripts.confirmSpeaker, { transcript_id: ids.rec, key: "spk:0" })).rejects.toThrow(/Nothing to confirm/);
  });
});

describe("moveLineSpeaker", () => {
  test("a line moves to an existing voice or the next new one", async () => {
    const { ids, as } = await world();
    const me = as(ids.owner);
    await me.mutation(api.transcripts.moveLineSpeaker, { transcript_id: ids.rec, seq: 3, key: "spk:1" });
    await me.mutation(api.transcripts.moveLineSpeaker, { transcript_id: ids.rec, seq: 1, key: "spk:2" });
    const call: any = await me.query(api.transcripts.webGetCall, { transcript_id: ids.rec });
    expect(call.segments.map((s: any) => [s.speaker_id, s.speaker_name])).toEqual([
      ["spk:2", "Speaker 3"], ["spk:1", "Speaker 2"], ["spk:1", "Speaker 2"],
    ]);
    expect(call.speakers[2]).toEqual({ key: "spk:2", source: "person" });
    await expect(me.mutation(api.transcripts.moveLineSpeaker, { transcript_id: ids.rec, seq: 1, key: "spk:7" })).rejects.toThrow(/No such speaker/);
    await expect(me.mutation(api.transcripts.moveLineSpeaker, { transcript_id: ids.rec, seq: 99, key: "spk:0" })).rejects.toThrow(/No such line/);
  });

  test("a legacy recording's lines cannot be moved: its voices were never separated", async () => {
    const { t, ids, as } = await world({ speakers: undefined });
    await expect(
      as(ids.owner).mutation(api.transcripts.moveLineSpeaker, { transcript_id: ids.rec, seq: 1, key: "spk:0" }),
    ).rejects.toThrow(/not separated/);
    expect((await t.run((ctx) => ctx.db.get(ids.rec)))!.speakers).toBeUndefined();
  });
});

describe("voiceprints", () => {
  const sample = (transcript_id: Id<"transcripts">) => ({ vector: [0.1, 0.2], seconds: 4, source: { transcript_id, key: "spk:1", kind: "assigned" as const } });

  test("consent gates storage; off and delete remove every sample; only counts are readable", async () => {
    const { t, ids, as } = await world();
    // Ann has recognition off: a sample for her is dropped.
    expect(await t.mutation(internal.voiceprints.addSamples, { user_id: ids.owner, engine: "fake", samples: [sample(ids.rec)] })).toEqual({ added: 0 });
    expect(await t.mutation(internal.voiceprints.addSamples, { user_id: ids.mate, engine: "fake", samples: [sample(ids.rec), sample(ids.rec)] })).toEqual({ added: 2 });
    const mine: any = await as(ids.mate).query(api.voiceprints.myVoiceprint, {});
    expect(mine).toMatchObject({ count: 2, seconds: 8 });
    expect(JSON.stringify(mine)).not.toContain("vector");
    const candidates: any[] = await t.query(internal.voiceprints.candidatesForTeam, { team_id: ids.team, engine: "fake" });
    expect(candidates.map((c) => c.user_id)).toEqual([ids.mate]);
    expect(await t.query(internal.voiceprints.candidatesForTeam, { team_id: ids.team, engine: "other" })).toEqual([]);
    expect(await as(ids.mate).mutation(api.voiceprints.deleteMyVoiceprints, {})).toEqual({ deleted: 2 });
    await t.mutation(internal.voiceprints.addSamples, { user_id: ids.mate, engine: "fake", samples: [sample(ids.rec)] });
    await as(ids.mate).mutation(api.voiceprints.setVoiceIdEnabled, { enabled: false });
    expect(await as(ids.mate).query(api.voiceprints.myVoiceprint, {})).toMatchObject({ count: 0 });
    expect(await t.query(internal.voiceprints.candidatesForTeam, { team_id: ids.team, engine: "fake" })).toEqual([]);
  });

  test("enrollment consent: a person naming their own voice gives a first sample; anyone else's assignment only confirms", async () => {
    const { t, ids, as } = await world({ rec_shared: true });
    const enrolls = () =>
      t.run(async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect())
          .filter((f: any) => f.name.includes("enrollFromSpeaker"))
          .map((f: any) => ({ user: f.args[0].user_id, match_required: f.args[0].match_required })),
      );
    // Ann has recognition off: nothing.
    await as(ids.owner).mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:0", user_id: ids.owner });
    // Ann confirms Bob, who is opted in but has no samples: not a first sample.
    await as(ids.owner).mutation(api.transcripts.confirmSpeaker, { transcript_id: ids.rec, key: "spk:1" });
    expect(await enrolls()).toEqual([]);
    // Bob names his own voice: a first sample may come of it.
    await as(ids.mate).mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:1", user_id: ids.mate });
    expect(await enrolls()).toEqual([{ user: ids.mate, match_required: false }]);
    // Once Bob has samples, Ann's assignment of him is a confirmation.
    await t.mutation(internal.voiceprints.addSamples, { user_id: ids.mate, engine: "fake", samples: [sample(ids.rec)] });
    await as(ids.owner).mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:0", user_id: ids.mate });
    expect((await enrolls())[1]).toEqual({ user: ids.mate, match_required: true });
  });

  test("a confirmation sample is never a first sample", async () => {
    const { t, ids } = await world();
    const add = (engine: string) =>
      t.mutation(internal.voiceprints.addSamples, { user_id: ids.mate, engine, match_required: true, samples: [sample(ids.rec)] });
    expect(await add("fake")).toEqual({ added: 0 });
    await t.mutation(internal.voiceprints.addSamples, { user_id: ids.mate, engine: "fake", samples: [sample(ids.rec)] });
    expect(await add("fake")).toEqual({ added: 1 });
    expect(await add("other")).toEqual({ added: 0 });
  });
});

describe("forgetting a voice", () => {
  const scheduledNamed = (t: any, name: string) =>
    t.run(async (ctx: any) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes(name)).map((f: any) => f.args[0]));

  test("turning recognition off scrubs suggestions naming the person; a person's word stays", async () => {
    const { t, ids, as } = await world();
    // A second voice note where a person named Bob, beside the voice match on the first.
    const other = await t.run((ctx) =>
      ctx.db.insert("transcripts", {
        room_key: `rec:${crypto.randomUUID()}`, team_id: ids.team, started_by: ids.owner, status: "ended", started_at: 1, routes: [], last_seq: 0,
        speakers: [{ key: "spk:0", user_id: ids.mate, source: "person", by: ids.owner, at: 1 }, { key: "spk:1", user_id: ids.mate, source: "voice", score: 0.7 }],
      } as any),
    );
    await t.run((ctx) =>
      ctx.db.insert("voiceprints", { user_id: ids.mate, engine: "vendor", ref: "vp_123", seconds: 3, source: { transcript_id: ids.rec, key: "spk:1", kind: "self" }, created_at: 1 }),
    );
    await as(ids.mate).mutation(api.voiceprints.setVoiceIdEnabled, { enabled: false });
    // The engine is asked to drop its copy; the scrub covers Bob's team.
    expect(await scheduledNamed(t, "forgetEngineRefs")).toEqual([{ engine: "vendor", refs: ["vp_123"] }]);
    const [scrub] = await scheduledNamed(t, "scrubVoiceSuggestions");
    expect(scrub).toEqual({ user_id: ids.mate, team_ids: [ids.team], cursor: null });
    await t.mutation(internal.voiceprints.scrubVoiceSuggestions, scrub);
    const rows = await t.run(async (ctx) => [(await ctx.db.get(ids.rec))!.speakers, (await ctx.db.get(other))!.speakers]);
    expect(rows[0]![1]).toEqual({ key: "spk:1", source: "voice" });
    expect(rows[1]).toEqual([
      { key: "spk:0", user_id: ids.mate, source: "person", by: ids.owner, at: 1 },
      { key: "spk:1", source: "voice" },
    ]);
    // Everywhere a line is named, the voice is unknown again.
    const forSummary: any = await t.query(internal.transcripts.getForSummary, { transcript_id: ids.rec });
    expect(forSummary.lines[1].speaker).toBe("Speaker 2");
  });

  test("the scrub pages through a team's recordings and moves on to the next team", async () => {
    const { t, ids } = await world();
    await t.run(async (ctx) => {
      for (let i = 0; i < 105; i++) {
        await ctx.db.insert("transcripts", {
          room_key: `rec:${i}`, team_id: ids.team, started_by: ids.owner, status: "ended", started_at: 1000 + i, routes: [], last_seq: 0,
          speakers: [{ key: "spk:0", user_id: ids.mate, source: "voice", score: 0.8 }],
        } as any);
      }
    });
    await t.mutation(internal.voiceprints.scrubVoiceSuggestions, { user_id: ids.mate, team_ids: [ids.team], cursor: null });
    const [next] = await scheduledNamed(t, "scrubVoiceSuggestions");
    expect(next.team_ids).toEqual([ids.team]);
    expect(typeof next.cursor).toBe("string");
    await t.mutation(internal.voiceprints.scrubVoiceSuggestions, next);
    const left = await t.run(async (ctx) =>
      (await ctx.db.query("transcripts").collect()).filter((r) => r.speakers?.some((s) => s.source === "voice" && s.user_id === ids.mate)).length,
    );
    expect(left).toBe(0);
  });

  test("deleting the account forgets the voice before the memberships go", async () => {
    const { t, ids, as } = await world();
    await as(ids.mate).mutation(api.users.deleteAccount, {});
    expect(await scheduledNamed(t, "scrubVoiceSuggestions")).toEqual([{ user_id: ids.mate, team_ids: [ids.team], cursor: null }]);
  });
});

describe("writeSpeechPass", () => {
  test("once a person has named a voice, a rerun does not replace the lines", async () => {
    const { t, ids, as } = await world();
    await as(ids.owner).mutation(api.transcripts.assignSpeaker, { transcript_id: ids.rec, key: "spk:0", name: "Visitor" });
    const before = await t.run(async (ctx) => (await ctx.db.query("transcript_segments").collect()).map((x) => x.text));
    const seg = (speaker_id: string) => ({ speaker_id, speaker_name: speaker_id, text: "x", t0: 0, t1: 1 });
    expect(
      await t.mutation(internal.transcripts.writeSpeechPass, {
        transcript_id: ids.rec,
        segments: [seg("spk:0"), seg("spk:1")],
        speakers: [{ key: "spk:0", source: "voice" }, { key: "spk:1", source: "voice" }],
      }),
    ).toEqual({ written: false });
    const after = await t.run(async (ctx) => ({ row: (await ctx.db.get(ids.rec))!, texts: (await ctx.db.query("transcript_segments").collect()).map((x) => x.text) }));
    expect(after.texts).toEqual(before);
    expect(after.row.speakers![0]).toMatchObject({ key: "spk:0", name: "Visitor", source: "person" });
  });

  test("an empty draft (a phone's note) leaves every route owing the note", async () => {
    const { t, ids } = await world({ last_seq: 0, routes: [{ kind: "doc", target: "d1", mode: "after", sent_seq: 0 }, { kind: "doc", target: "d2", mode: "live", sent_seq: 0 }] });
    await t.run(async (ctx) => {
      for (const s of await ctx.db.query("transcript_segments").collect()) await ctx.db.delete(s._id);
    });
    const seg = (speaker_id: string) => ({ speaker_id, speaker_name: speaker_id, text: "x", t0: 0, t1: 1 });
    await t.mutation(internal.transcripts.writeSpeechPass, { transcript_id: ids.rec, segments: [seg("spk:0")], speakers: [{ key: "spk:0", source: "voice" }] });
    expect((await t.run((ctx) => ctx.db.get(ids.rec)))!.routes.map((r) => r.sent_seq)).toEqual([0, 0]);
  });

  test("a suggestion stands only for a person who still consents and is still on the team", async () => {
    const { t, ids } = await world();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.rec, { speakers: undefined });
      await ctx.db.patch(ids.owner, { voice_id_enabled: true });
    });
    const seg = (speaker_id: string) => ({ speaker_id, speaker_name: speaker_id, text: "x", t0: 0, t1: 1 });
    await t.mutation(internal.transcripts.writeSpeechPass, {
      transcript_id: ids.rec,
      segments: [seg("spk:0"), seg("spk:1"), seg("spk:2")],
      speakers: [
        // Ann: on, a member. Bob turned recognition off. Eve is on another team.
        { key: "spk:0", user_id: ids.owner, source: "voice", score: 0.9 },
        { key: "spk:1", user_id: ids.mate, source: "voice", score: 0.9 },
        { key: "spk:2", user_id: ids.stranger, source: "voice", score: 0.9 },
      ],
    });
    const row = (await t.run((ctx) => ctx.db.get(ids.rec)))!;
    expect(row.speakers).toEqual([
      { key: "spk:0", user_id: ids.owner, source: "voice", score: 0.9 },
      { key: "spk:1", user_id: ids.mate, source: "voice", score: 0.9 },
      { key: "spk:2", source: "voice" },
    ]);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.rec, { speakers: undefined });
      await ctx.db.patch(ids.mate, { voice_id_enabled: false });
    });
    await t.mutation(internal.transcripts.writeSpeechPass, {
      transcript_id: ids.rec,
      segments: [seg("spk:1")],
      speakers: [{ key: "spk:1", user_id: ids.mate, source: "voice", score: 0.9 }],
    });
    expect((await t.run((ctx) => ctx.db.get(ids.rec)))!.speakers).toEqual([{ key: "spk:1", source: "voice" }]);
  });
});

describe("runSpeechPipeline", () => {
  test("words and turns become diarized segments after the draft, with suggestions for real candidates", async () => {
    const { t, ids } = await world({ routes: [{ kind: "doc", target: "d1", mode: "after", sent_seq: 0 }, { kind: "doc", target: "d2", mode: "live", sent_seq: 3 }] });
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });
    const storageId = await t.run((ctx) => ctx.storage.store(audio));
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.rec, { recording_storage_id: storageId, speakers: undefined });
      await ctx.db.insert("voiceprints", {
        user_id: ids.mate, engine: "fake", vector: [1, 0], seconds: 5,
        source: { transcript_id: ids.rec, key: "spk:1", kind: "assigned" }, created_at: 1,
      });
    });
    let sawCandidates: string[] = [];
    const words: WordsSource = {
      name: "fake-words",
      words: async () => ({
        words: [
          { text: "hello", start: 0, end: 0.4 }, { text: "there", start: 0.5, end: 0.9 },
          { text: "hi", start: 1.2, end: 1.4 }, { text: "Bob", start: 1.5, end: 1.8 },
          { text: "again", start: 5, end: 5.3 },
        ],
      }),
    };
    const speakers: SpeakerEngine = {
      name: "fake",
      speakers: async ({ candidates }) => {
        sawCandidates = candidates.map((c) => String(c.user_id));
        return {
          turns: [{ key: "spk:0", start: 0, end: 1 }, { key: "spk:1", start: 1.1, end: 2 }, { key: "spk:0", start: 4.9, end: 6 }],
          // A suggestion for someone who is not a candidate is dropped.
          suggestions: { "spk:1": { user_id: ids.mate, score: 0.91 }, "spk:0": { user_id: ids.stranger, score: 0.99 } },
        };
      },
    };
    const ctx = {
      runQuery: (ref: any, args: any) => t.query(ref, args),
      runMutation: (ref: any, args: any) => t.mutation(ref, args),
      // A convex-test run cannot return a Blob; the stored audio stands in.
      storage: { get: async (id: Id<"_storage">) => (id === storageId ? audio : null), getUrl: async () => "https://storage.test/audio" },
    };
    expect(await runSpeechPipeline(ctx, { _id: ids.rec }, { words, speakers, deadline: Date.now() + 600_000 })).toBe(true);
    expect(sawCandidates).toEqual([String(ids.mate)]);
    const row = await t.run(async (c) => ({
      t: (await c.db.get(ids.rec))!,
      segs: await c.db.query("transcript_segments").withIndex("by_transcript_seq", (q) => q.eq("transcript_id", ids.rec)).collect(),
    }));
    expect(row.segs.map((s) => [s.seq, s.speaker_id, s.speaker_name, s.text, s.t0, s.t1])).toEqual([
      [4, "spk:0", "Speaker 1", "hello there", 0, 900],
      [5, "spk:1", "Speaker 2", "hi Bob", 1200, 1800],
      [6, "spk:0", "Speaker 1", "again", 5000, 5300],
    ]);
    expect(row.t.last_seq).toBe(6);
    expect(row.t.speakers).toEqual([
      { key: "spk:0", source: "voice" },
      { key: "spk:1", user_id: ids.mate, source: "voice", score: 0.91 },
    ]);
    // The live route had the whole draft: it has the replacement too. The after route gets it.
    expect(row.t.routes.map((r) => r.sent_seq)).toEqual([0, 6]);
    expect(row.t.transcribe_status).toBe("done");
  });
  test("a solo dictation enrolls its recorder only once they turned recognition on; never set is off", async () => {
    const { t, ids } = await world();
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });
    const storageId = await t.run((ctx) => ctx.storage.store(audio));
    const words: WordsSource = { name: "fake-words", words: async () => ({ words: [{ text: "note", start: 0, end: 0.5 }, { text: "to self", start: 0.6, end: 1.2 }] }) };
    const speakers: SpeakerEngine = { name: "fake", speakers: async () => ({ turns: [{ key: "spk:0", start: 0, end: 2 }], suggestions: {} }) };
    const ctx = {
      runQuery: (ref: any, args: any) => t.query(ref, args),
      runMutation: (ref: any, args: any) => t.mutation(ref, args),
      storage: { get: async (id: Id<"_storage">) => (id === storageId ? audio : null), getUrl: async () => "https://storage.test/audio" },
    };
    const selfEnrolls = () =>
      t.run(async (c) => (await c.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("enrollFromSpeaker")).length);
    // Ann never touched the switch (no voice_id_enabled field at all).
    await t.run((c) => c.db.patch(ids.rec, { recording_storage_id: storageId, speakers: undefined }));
    expect(await runSpeechPipeline(ctx, { _id: ids.rec }, { words, speakers, deadline: Date.now() + 600_000 })).toBe(true);
    expect(await selfEnrolls()).toBe(0);
    // The same dictation recorded by Bob, who turned it on, gives him a first sample.
    await t.run((c) => c.db.patch(ids.rec, { started_by: ids.mate, speakers: undefined }));
    expect(await runSpeechPipeline(ctx, { _id: ids.rec }, { words, speakers, deadline: Date.now() + 600_000 })).toBe(true);
    expect(await selfEnrolls()).toBe(1);
  });
});

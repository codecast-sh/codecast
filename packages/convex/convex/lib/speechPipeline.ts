// The batch pass over a finished voice note (docs/architecture/speaker-attribution.md,
// "The batch pass"): words -> speakers -> lines -> write. Engine-agnostic:
// where the words come from (WordsSource) and who spoke when (SpeakerEngine)
// are passed in, and the steps between them are pure.
//
// The engine is C (Ashot, pl-1081): Scribe v3 for the words and who spoke
// them, our CAM++ worker for naming the voices (`scribeWordsSource`,
// `campplusEngine`). It runs only for a team with the `voice_speakers`
// feature (transcripts.transcribeVoiceNote); every other voice note keeps the
// whisper-1 path.
import { internal } from "../_generated/api";
import { SCRIBE_INLINE_MAX_BYTES, SCRIBE_MAX_MS, scribeTranscribe } from "./scribe";
import { embedWindows, vectorsOf, WORKER_MAX_MS } from "./speechWorker";
import { budgetWindows, cleanWindows, CLUSTER_SECONDS, matchVoices, VOICE_ENGINE } from "./voiceMatch";
import type { VendorGate } from "./vendorGuard";
import type { Id } from "../_generated/dataModel";
import {
  speakerIndex,
  speakerKey,
  speakerLabel,
  wordsToLines,
  type SpeakerActivity,
  type SpeakerLine,
  type SpeakerTurn,
  type TimedWord,
} from "@codecast/shared/contracts";

/** What the words step reads: the recording's audio when it is small enough
 *  to hold in the action (else only a URL to it), how long it ran, the room's
 *  languages, and how long it may take. */
export type WordsInput = {
  audio: Blob | null;
  audioUrl: string | null;
  contentType: string | null;
  durationMs: number;
  team_id: Id<"teams">;
  languages: string[];
  timeoutMs: number;
};

/** A recognizer that returns word timestamps (seconds from the start of the
 *  audio), language pinned to the room's languages; how it does that is its
 *  own business. One that labels its words by speaker (Scribe) puts the key
 *  on each word and returns the turns they make. */
export type WordsSource = {
  name: string;
  words(input: WordsInput): Promise<{ words: TimedWord[]; turns?: SpeakerTurn[]; language?: string | null }>;
};

/** A teammate who may be suggested for a voice: recognition on, with samples
 *  of this engine, as the centroid of their vectors (voiceprints.candidatesForTeam). */
export type SpeakerCandidate = {
  user_id: Id<"users">;
  name: string | null;
  centroid: number[];
  samples: number;
};

/** Who spoke when, and per voice the person it most likely is. An engine
 *  suggests a person only above its own threshold and clear of the
 *  runner-up; otherwise it leaves the voice unnamed (a confident wrong name
 *  costs more than an honest unknown). */
export type SpeakerEngine = {
  /** The voiceprints `engine` value its embeddings belong to. */
  name: string;
  speakers(input: {
    audioUrl: string | null;
    words: TimedWord[];
    /** The words source's own turns, when it labels speakers. */
    turns?: SpeakerTurn[];
    candidates: SpeakerCandidate[];
    /** How long naming may take; under a minute it should not start. */
    timeoutMs: number;
  }): Promise<{
    turns: SpeakerTurn[];
    /** Per-voice frame activity (0..1, 50 ms hops in the lab). When given,
     *  words go to voices by activity, which put more words on the right
     *  person on room-mic audio than turn overlap (AMI: 88.6% to 94.0%). */
    activity?: SpeakerActivity;
    suggestions: Record<string, { user_id: Id<"users">; score: number }>;
  }>;
};

/** The two engines, and the moment the whole pass must be done by (epoch
 *  ms): each step's timeout is cut to fit what is left. */
export type SpeechPipelineDeps = { words: WordsSource; speakers: SpeakerEngine; deadline: number };

/** Naming starts only with at least this much time left. */
export const NAMING_MIN_MS = 60_000;

/** The ctx the pass needs: an action's, narrowed so a test can supply one. */
export type SpeechPipelineCtx = {
  runQuery: (ref: any, args: any) => Promise<any>;
  runMutation: (ref: any, args: any) => Promise<any>;
  storage: { get: (id: Id<"_storage">) => Promise<Blob | null>; getUrl: (id: Id<"_storage">) => Promise<string | null> };
};

export type PassSegment = { speaker_id: string; speaker_name: string; text: string; t0: number; t1: number };

/**
 * Lines as stored segments: times in ms, each line on its voice key. A line
 * no turn covered (key null) joins the voice of the line before it, or the
 * one after for the first; with no turns at all every line is spk:0.
 */
export function linesToSegments(lines: SpeakerLine[]): PassSegment[] {
  const keys = lines.map((l) => l.key);
  for (let i = 1; i < keys.length; i++) keys[i] ??= keys[i - 1]!;
  for (let i = keys.length - 2; i >= 0; i--) keys[i] ??= keys[i + 1]!;
  return lines.map((l, i) => {
    const key = keys[i] ?? speakerKey(0);
    return { speaker_id: key, speaker_name: speakerLabel(key), text: l.text, t0: Math.round(l.start * 1000), t1: Math.round(l.end * 1000) };
  });
}

/** One `speakers` entry per voice the segments use, a suggestion where the
 *  engine made one for a real candidate. */
export function passSpeakers(
  segments: PassSegment[],
  suggestions: Record<string, { user_id: Id<"users">; score: number }>,
  candidates: SpeakerCandidate[],
): Array<{ key: string; user_id?: Id<"users">; source: "voice"; score?: number }> {
  const allowed = new Set(candidates.map((c) => String(c.user_id)));
  const keys = [...new Set(segments.map((s) => s.speaker_id))].sort(
    (a, b) => (speakerIndex(a) ?? 0) - (speakerIndex(b) ?? 0),
  );
  return keys.map((key) => {
    const s = suggestions[key];
    return s && allowed.has(String(s.user_id)) ? { key, user_id: s.user_id, source: "voice" as const, score: s.score } : { key, source: "voice" as const };
  });
}

/**
 * Run the pass over one voice note and write its result: diarized segments
 * replace the draft (taking seq numbers after it) and `speakers` holds a
 * suggestion or an unknown for every voice. Then the transcript is closed out
 * like any recording's (summary and routes). Returns false when Scribe heard
 * nothing, so the caller falls back; throws when the words step fails.
 *
 * The audio is read into the action only when it is small enough to upload
 * inline (SCRIBE_INLINE_MAX_BYTES, judged from storage metadata); a longer
 * note goes to the words source by URL. Naming is skipped when under a
 * minute of the deadline is left, and the lines are written unnamed.
 */
export async function runSpeechPipeline(
  ctx: SpeechPipelineCtx,
  transcript: { _id: Id<"transcripts"> },
  deps: SpeechPipelineDeps,
): Promise<boolean> {
  const left = () => deps.deadline - Date.now();
  const row = await ctx.runQuery(internal.transcripts.getForTranscription, { transcript_id: transcript._id });
  if (!row?.storage_id) throw new Error("no audio attached");
  const audioUrl = await ctx.storage.getUrl(row.storage_id);
  const inline = typeof row.size === "number" && row.size <= SCRIBE_INLINE_MAX_BYTES;
  const audio = inline ? await ctx.storage.get(row.storage_id) : null;
  if (inline && !audio) throw new Error("audio missing from storage");
  const durationMs = Math.max(0, (row.ended_at ?? row.started_at) - row.started_at);
  const heard = await deps.words.words({
    audio,
    audioUrl,
    contentType: row.content_type ?? null,
    durationMs,
    team_id: row.team_id,
    languages: row.languages ?? [],
    timeoutMs: Math.min(SCRIBE_MAX_MS, left()),
  });
  const words = heard.words;
  if (!words.length) return false;
  const candidates: SpeakerCandidate[] = await ctx.runQuery(internal.voiceprints.candidatesForTeam, {
    team_id: row.team_id,
    engine: deps.speakers.name,
  });
  const named =
    left() >= NAMING_MIN_MS
      ? await deps.speakers.speakers({ audioUrl, words, turns: heard.turns, candidates, timeoutMs: Math.min(WORKER_MAX_MS, left()) })
      : { turns: heard.turns ?? [], suggestions: {} };
  const segments = linesToSegments(wordsToLines(words, named.turns, { activity: named.activity }));
  await ctx.runMutation(internal.transcripts.writeSpeechPass, {
    transcript_id: transcript._id,
    segments,
    speakers: passSpeakers(segments, named.suggestions, candidates),
  });
  await ctx.runMutation(internal.transcripts.finishRecordingTranscript, { transcript_id: transcript._id, ok: true });
  return true;
}

// ── Engine C ───────────────────────────────────────────────────────────────

/** Scribe v3 as a words source: words labeled by speaker, and their turns. */
export function scribeWordsSource(gate: VendorGate): WordsSource {
  return {
    name: "scribe_v3",
    words: (input) => scribeTranscribe(gate, input),
  };
}

/**
 * Naming the words source's voices with our CAM++ worker: each voice's clean
 * windows (90 s at most, longest first) are embedded, and voices are paired
 * one to one with the candidates' centroids (lib/voiceMatch). The turns are
 * the words source's own. A worker that does not answer, or answers in
 * another embedding space, leaves every voice unnamed: the lines still go on
 * their speakers, and a person can name them.
 */
export function campplusEngine(): SpeakerEngine {
  return {
    name: VOICE_ENGINE,
    async speakers({ audioUrl, turns = [], candidates, timeoutMs }) {
      const suggestions: Record<string, { user_id: Id<"users">; score: number }> = {};
      const people = candidates.filter((c) => c.centroid.length);
      if (!audioUrl || !people.length || !turns.length || timeoutMs < NAMING_MIN_MS) return { turns, suggestions };
      const spans = [...cleanWindows(turns)].map(([key, ws]) => ({ key, windows: budgetWindows(ws, CLUSTER_SECONDS) })).filter((s) => s.windows.length);
      const embedded = await embedWindows(audioUrl, spans, timeoutMs);
      if (!embedded || embedded.model !== VOICE_ENGINE) return { turns, suggestions };
      const clusters = new Map(spans.map((s) => [s.key, vectorsOf(embedded, s.key)]));
      // A person's print is the centroid of their samples, which is what the matcher compares.
      const prints = new Map(people.map((c) => [String(c.user_id), [c.centroid]]));
      const { names, scores } = matchVoices(clusters, prints);
      for (const [key, person] of names) {
        if (person) suggestions[key] = { user_id: person as Id<"users">, score: scores.get(key)!.get(person)! };
      }
      return { turns, suggestions };
    },
  };
}

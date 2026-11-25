// Who said each line of a voice note (docs/architecture/speaker-attribution.md).
//
// A diarized line carries a voice cluster key (`spk:<n>`) in
// `transcript_segments.speaker_id`; who that voice is lives once, in
// `transcripts.speakers[]`. Every surface (the call page, the phone, the
// summary prompt, route delivery, `cast calls`) names a line through
// resolveLineSpeaker, so assigning a speaker is one write and every line
// follows. Lines that are not diarized (a huddle's user ids, a legacy
// recording's `mic`) resolve to the name they were written with.

/** One voice cluster of a recording and who it is. An entry with neither
 *  `user_id` nor `name` is an unknown voice, shown as `Speaker <n+1>`. */
export type CallSpeaker = {
  key: string;
  /** A teammate (a member of the recording's team). */
  user_id?: string;
  /** Someone outside the team, typed by a person. */
  name?: string;
  /** "voice": a voice match suggested it; "person": a person said so. */
  source: "voice" | "person";
  /** The voice match score, for "voice". */
  score?: number;
  /** Who made a "person" entry, and when (server-written, never on the wire). */
  by?: string;
  at?: number;
};

/** The fields of a CallSpeaker a client reads and writes, in one key order.
 *  The server sends `speakers` in this shape and the store's optimistic
 *  writes build it the same way, so a field lock on `speakers` matches the
 *  server's echo by value. */
export type WireCallSpeaker = Pick<CallSpeaker, "key" | "user_id" | "name" | "source" | "score">;

/** user id -> display name, for the teammates a recording's speakers name. */
export type SpeakerRoster = Readonly<Record<string, string | undefined>>;

export type ResolvedSpeaker = {
  /** `spk:<n>` for a diarized line, else the segment's own speaker id. */
  key: string;
  name: string;
  user_id?: string;
  source?: CallSpeaker["source"];
  /** A voice match named this speaker and no person has confirmed it yet:
   *  render the name quieter, with a confirm. */
  suggested: boolean;
};

const SPK = /^spk:(\d+)$/;

export function speakerKey(n: number): string {
  return `spk:${n}`;
}

/** The cluster index of a `spk:<n>` key, or null for any other speaker id. */
export function speakerIndex(key: string): number | null {
  const m = SPK.exec(key);
  return m ? Number(m[1]) : null;
}

export function isSpeakerKey(key: string): boolean {
  return SPK.test(key);
}

/** "Speaker 1" for spk:0. A key that is not a voice cluster is returned as is. */
export function speakerLabel(key: string): string {
  const n = speakerIndex(key);
  return n === null ? key : `Speaker ${n + 1}`;
}

/** The key a line moved to a new voice gets: one past the highest cluster
 *  `speakers` holds (the batch pass writes an entry for every cluster). */
export function nextSpeakerKey(speakers: ReadonlyArray<Pick<CallSpeaker, "key">> | undefined): string {
  let max = -1;
  for (const s of speakers ?? []) max = Math.max(max, speakerIndex(s.key) ?? -1);
  return speakerKey(max + 1);
}

export function wireSpeaker(s: WireCallSpeaker): WireCallSpeaker {
  return {
    key: s.key,
    ...(s.user_id !== undefined ? { user_id: s.user_id } : {}),
    ...(s.name !== undefined ? { name: s.name } : {}),
    source: s.source,
    ...(s.score !== undefined ? { score: s.score } : {}),
  };
}

export function wireSpeakers(speakers: ReadonlyArray<WireCallSpeaker> | undefined): WireCallSpeaker[] {
  return (speakers ?? []).map(wireSpeaker);
}

/** What a speaker entry becomes when a person assigns it. Exactly one of
 *  user_id, name or clear; `clear` leaves the voice unknown on purpose. */
export type SpeakerAssignment = { user_id: string } | { name: string } | { clear: true };

/** The entry after an assignment: `source: "person"`, no score. */
export function assignedSpeaker(key: string, a: SpeakerAssignment): WireCallSpeaker {
  if ("user_id" in a) return wireSpeaker({ key, user_id: a.user_id, source: "person" });
  if ("name" in a) return wireSpeaker({ key, name: a.name, source: "person" });
  return wireSpeaker({ key, source: "person" });
}

/** The entry after a person confirms a voice suggestion, or null when there
 *  is nothing to confirm (no entry, already a person's, or unnamed). */
export function confirmedSpeaker(entry: WireCallSpeaker | undefined): WireCallSpeaker | null {
  if (!entry || entry.source !== "voice" || (!entry.user_id && !entry.name)) return null;
  return wireSpeaker({ key: entry.key, user_id: entry.user_id, name: entry.name, source: "person" });
}

/** `speakers` with `entry` in place of the one with its key (appended when new). */
export function withSpeaker<T extends Pick<CallSpeaker, "key">>(speakers: ReadonlyArray<T> | undefined, entry: T): T[] {
  const list = [...(speakers ?? [])];
  const i = list.findIndex((s) => s.key === entry.key);
  if (i === -1) list.push(entry);
  else list[i] = entry;
  return list;
}

/**
 * The roster a client names a call's speakers with: the names the server
 * sent with the call (`speaker_names`, every teammate its speakers name,
 * whichever workspace the viewer is in) over the viewer's team members for
 * anyone the server has not named yet (a teammate just assigned on this
 * device). Names only, never an email; server names win.
 */
export function callSpeakerRoster(
  call: { speaker_names?: Readonly<Record<string, string>> | null } | null | undefined,
  teamMembers?: ReadonlyArray<{ _id?: string; user_id?: string; name?: string | null } | null | undefined> | null,
): SpeakerRoster {
  const roster: Record<string, string> = {};
  for (const m of teamMembers ?? []) {
    const id = m?.user_id ?? m?._id;
    if (id && m?.name) roster[String(id)] = m.name;
  }
  return { ...roster, ...(call?.speaker_names ?? {}) };
}

/** Who said a line. A diarized line names its cluster's teammate (from the
 *  roster), else the typed name, else `Speaker <n+1>`. Any other line keeps
 *  the name it was written with. */
export function resolveLineSpeaker(
  segment: { speaker_id: string; speaker_name: string },
  speakers: ReadonlyArray<WireCallSpeaker> | undefined,
  roster: SpeakerRoster | undefined,
): ResolvedSpeaker {
  const key = segment.speaker_id;
  if (!isSpeakerKey(key)) return { key, name: segment.speaker_name, suggested: false };
  const entry = speakers?.find((s) => s.key === key);
  if (!entry) return { key, name: speakerLabel(key), suggested: false };
  // Named only when a name resolves: a teammate the roster cannot name reads
  // as the unknown voice it shows as, and never offers a confirm.
  const resolved = (entry.user_id ? roster?.[entry.user_id] : undefined) ?? entry.name;
  return {
    key,
    name: resolved ?? speakerLabel(key),
    ...(entry.user_id ? { user_id: entry.user_id } : {}),
    source: entry.source,
    suggested: entry.source === "voice" && !!resolved,
  };
}

// ── Words to lines ──────────────────────────────────────────────────────────

/** A recognized word, times in seconds from the start of the audio. `key`
 *  is the voice a recognizer that labels its own words put it on (Scribe). */
export type TimedWord = { text: string; start: number; end: number; key?: string };
/** A speaker engine's turn: one voice cluster speaking over [start, end] s. */
export type SpeakerTurn = { key: string; start: number; end: number };
/** A speaker engine's frame activity: per voice key, how active it is (0..1)
 *  in each frame of `hop_s` seconds from the start of the audio. */
export type SpeakerActivity = { hop_s: number; labels: Record<string, number[]> };
/** Consecutive words of one speaker. `key` is null for words no speaker claims. */
export type SpeakerLine = { key: string | null; start: number; end: number; text: string; words: TimedWord[] };

/** A word no turn overlaps goes to the nearest turn when within this many s. */
const NEAR_TURN_S = 0.5;
/** Turns considered "near" a word at all: midpoints within this many s. */
const NEAR_WINDOW_S = 30;
/** The activity rule reads a word's span widened by this many s each side. */
const ACTIVITY_PAD_S = 0.05;

/** The turn rule: most overlap, else the nearest turn edge within 0.5 s. */
function turnKeyOf(ts: ReadonlyArray<SpeakerTurn>, s: number, e: number): string | null {
  let best: string | null = null;
  let bo = 0;
  for (const t of ts) {
    if (t.start > e + NEAR_TURN_S) break;
    const o = Math.min(e, t.end) - Math.max(s, t.start);
    if (o > bo) {
      best = t.key;
      bo = o;
    }
  }
  if (best !== null) return best;
  const mid = (s + e) / 2;
  const edge = (t: SpeakerTurn) => Math.min(Math.abs(t.start - mid), Math.abs(t.end - mid));
  let near: SpeakerTurn | null = null;
  for (const t of ts) {
    if (Math.abs((t.start + t.end) / 2 - mid) >= NEAR_WINDOW_S) continue;
    if (!near || edge(t) < edge(near)) near = t;
  }
  return near && edge(near) < NEAR_TURN_S ? near.key : null;
}

/** The activity rule: the key with the highest mean activity over the word's
 *  padded span, if above `floor`; otherwise the previous word's key. */
function activityKeyOf(activity: SpeakerActivity, s: number, e: number, prev: string | null, floor: number): string | null {
  const keys = Object.keys(activity.labels);
  const n = keys.length ? activity.labels[keys[0]!]!.length : 0;
  const a = Math.max(0, Math.trunc((s - ACTIVITY_PAD_S) / activity.hop_s));
  const b = Math.min(n, Math.trunc((e + ACTIVITY_PAD_S) / activity.hop_s) + 1);
  let best = prev;
  let bv = floor;
  if (b <= a) return best;
  for (const key of keys) {
    const arr = activity.labels[key]!;
    let sum = 0;
    for (let i = a; i < b; i++) sum += arr[i]!;
    const v = sum / (b - a);
    if (v > bv) {
      best = key;
      bv = v;
    }
  }
  return best;
}

/**
 * Words to lines. A word that carries its own `key` (a recognizer that
 * labels each word with its speaker) keeps it. With frame `activity` from the speaker engine, each word
 * goes to the key with the highest mean activity over [start - 0.05,
 * end + 0.05] (at least `floor`, 0.15; below it, the previous word's key).
 * Without it, each word goes to the turn that overlaps it most, else to the
 * nearest turn edge within 0.5 s, else to no speaker. Consecutive words of
 * one key become a line, split when the key changes or the silence between
 * words is over `gap` seconds (1.2). Ports of the speech lab's
 * `words_to_lines_activity` and `words_to_lines`
 * (packages/evals/speech/lab/lab.py), kept identical by a parity fixture.
 */
export function wordsToLines(
  words: ReadonlyArray<TimedWord>,
  turns: ReadonlyArray<SpeakerTurn>,
  opts: { gap?: number; activity?: SpeakerActivity; floor?: number } = {},
): SpeakerLine[] {
  const gap = opts.gap ?? 1.2;
  const floor = opts.floor ?? 0.15;
  const ts = [...turns].sort((a, b) => a.start - b.start);
  const lines: SpeakerLine[] = [];
  let cur: SpeakerLine | null = null;
  let prev: string | null = null;
  for (const w of words) {
    const { start: s, end: e } = w;
    const best: string | null =
      w.key !== undefined ? w.key : opts.activity ? activityKeyOf(opts.activity, s, e, prev, floor) : turnKeyOf(ts, s, e);
    prev = best;
    const word = { text: w.text, start: s, end: e };
    if (cur && cur.key === best && s - cur.end <= gap) {
      cur.words.push(word);
      cur.end = e;
    } else {
      if (cur) lines.push(cur);
      cur = { key: best, start: s, end: e, text: "", words: [word] };
    }
  }
  if (cur) lines.push(cur);
  for (const l of lines) l.text = l.words.map((w) => w.text).join(" ");
  return lines;
}

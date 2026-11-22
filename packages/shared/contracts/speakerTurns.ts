// What a voice note's speaker controls draw, the same on the web and the
// phone (docs/architecture/speaker-attribution.md): the speaker row's chips,
// the lines grouped into turns, each voice's color, and where a line goes
// when a person says who said it. Pure, so both apps import one rule.
import {
  isSpeakerKey,
  nextSpeakerKey,
  resolveLineSpeaker,
  speakerIndex,
  type ResolvedSpeaker,
  type SpeakerAssignment,
  type SpeakerRoster,
  type WireCallSpeaker,
} from "./speakers";

type Line = { seq: number; speaker_id: string; speaker_name: string; t0: number; t1: number };

/** One chip of the speaker row: who the voice is and how much of the talking it did. */
export type SpeakerChip = ResolvedSpeaker & {
  /** Milliseconds of the recording's lines this voice said. */
  ms: number;
  /** `ms` over all diarized lines' time, 0..1. */
  share: number;
  lines: number;
};

/** True when any line carries a voice cluster key: only then is there a speaker row. */
export function hasVoiceSpeakers(segments: ReadonlyArray<{ speaker_id: string }> | undefined): boolean {
  return !!segments?.some((s) => isSpeakerKey(s.speaker_id));
}

/** The recording's voices in the order they first speak, with talk share.
 *  A voice no line says any more (every line moved away) has no chip. */
export function recordingSpeakers(
  segments: ReadonlyArray<Line> | undefined,
  speakers: ReadonlyArray<WireCallSpeaker> | undefined,
  roster: SpeakerRoster | undefined,
): SpeakerChip[] {
  const byKey = new Map<string, SpeakerChip>();
  let total = 0;
  for (const s of segments ?? []) {
    if (!isSpeakerKey(s.speaker_id)) continue;
    const ms = Math.max(0, s.t1 - s.t0);
    total += ms;
    const chip = byKey.get(s.speaker_id);
    if (chip) {
      chip.ms += ms;
      chip.lines += 1;
    } else {
      byKey.set(s.speaker_id, { ...resolveLineSpeaker(s, speakers, roster), ms, share: 0, lines: 1 });
    }
  }
  const chips = [...byKey.values()];
  for (const c of chips) c.share = total > 0 ? c.ms / total : 1 / chips.length;
  return chips;
}

/** Talk share as a whole percent for a chip ("42%"), never "0%" for a voice that spoke. */
export function shareLabel(share: number): string {
  const pct = Math.round(share * 100);
  return `${share > 0 && pct === 0 ? "<1" : pct}%`;
}

/** Consecutive lines of one speaker, so a name is drawn once per turn. */
export type SpeakerTurn<T> = { key: string; lines: T[] };

export function speakerTurns<T extends { speaker_id: string }>(segments: ReadonlyArray<T>): SpeakerTurn<T>[] {
  const turns: SpeakerTurn<T>[] = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    if (last && last.key === s.speaker_id) last.lines.push(s);
    else turns.push({ key: s.speaker_id, lines: [s] });
  }
  return turns;
}

/** Which of the caller's `paletteLength` colors a voice wears: spk:0 the
 *  first, spk:1 the second, and so on, so a voice keeps its color on every
 *  surface; any other speaker id hashes (the web's speakerColor rule). */
export function speakerColorIndex(key: string, paletteLength: number): number {
  const n = speakerIndex(key);
  if (n !== null) return n % paletteLength;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % paletteLength;
}

/** A person's pick in the "who said this" sheet. */
export type SpeakerChoice = SpeakerAssignment | { key: string };

/** True when `q` (any case, any part of a word) finds `name`. Empty finds everything. */
export function speakerNameMatches(name: string | undefined, q: string): boolean {
  const needle = q.trim().toLowerCase();
  return !needle || (name ?? "").toLowerCase().includes(needle);
}

/**
 * Where one line goes when a person says who said it ("Said by…"). A voice of
 * this recording: that key. A teammate or a typed name some voice already
 * has: that voice's key, so their lines stay one speaker. Anyone else, or
 * Unknown: a new voice (nextSpeakerKey), named by `assign` when there is a name.
 */
export function moveLineTarget(
  speakers: ReadonlyArray<WireCallSpeaker> | undefined,
  choice: SpeakerChoice,
): { key: string; assign?: SpeakerAssignment } {
  if ("key" in choice) return { key: choice.key };
  if ("user_id" in choice) {
    const has = speakers?.find((s) => s.user_id === choice.user_id);
    if (has) return { key: has.key };
  } else if ("name" in choice) {
    const name = choice.name.trim().toLowerCase();
    const has = speakers?.find((s) => !s.user_id && s.name?.trim().toLowerCase() === name);
    if (has) return { key: has.key };
  }
  const key = nextSpeakerKey(speakers);
  return "clear" in choice ? { key } : { key, assign: choice };
}

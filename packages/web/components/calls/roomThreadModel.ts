// The room thread's reading model: what people SAID folded into passages,
// interleaved by wall clock with what people TYPED, what an agent answered,
// and who came and went. Pure data, plain .ts on purpose (component modules
// export only components), so the stage rail and the call page render one
// model and the unit test beside it pins the folding rules.
//
// Turn indices are GLOBAL across passages: the call page selects turns by
// index and slices a flat list, so the flat list must be exactly the
// passages' turns laid end to end (see flatTurns).

import {
  groupTurns,
  oneSegmentTurns,
  type TranscriptSegment as TurnSegment,
  type Turn,
} from "./transcriptTurnModel";
import { firstName } from "./speakers";

/** A silence at least this long between two segments starts a new passage. */
export const PASSAGE_SILENCE_MS = 20_000;
/** A passage never runs longer than this from its first segment's t0. */
export const PASSAGE_MAX_MS = 120_000;
/** The preview keeps about this many characters of "Name: words · Name: words". */
export const PASSAGE_PREVIEW_CHARS = 160;

/**
 * A transcript segment as the call queries return it: the turn model's
 * segment plus `at`, the row's creation time on the server clock. Chat rows
 * sort by that same clock, so passages and typed lines interleave without
 * mixing the scribe's clock (t0/t1) into the order.
 */
export type TranscriptSegment = TurnSegment & { at: number };

export type Speaker = { id: string; name: string };

export type Passage = {
  kind: "passage";
  index: number;
  /** Transcript clock (ms from the start) of the first and last segment. */
  t0: number;
  t1: number;
  /** Wall clock of the first segment: what the timeline sorts by. */
  at: number;
  /** Unique, in order of first appearance. */
  speakers: Speaker[];
  /** Global indices: passage n's first turn follows passage n-1's last. */
  turns: Turn[];
  segments: TranscriptSegment[];
  wordCount: number;
  /** "Name: words · Name: words", clamped to PASSAGE_PREVIEW_CHARS. */
  preview: string;
};

export type RoomEventKind = "agent_joined" | "agent_left" | "transcribe_on" | "transcribe_off";

export type AgentRef = {
  conversation_id: string;
  short_id: string | null;
  title: string;
  agent_type: string;
};

/** A row of callChat.list. An event row has `event` set and an empty text. */
export type ThreadRow = {
  _id: string;
  user_id: string;
  user_name: string;
  user_image?: string;
  text: string;
  attachments?: { storage_id: string; [k: string]: unknown }[] | null;
  at: number;
  mine: boolean;
  agent: AgentRef | null;
  event?: string | null;
};

export type ChatRow = ThreadRow & { event?: null | undefined };
export type EventRow = ThreadRow & { event: RoomEventKind };

export type TimelineItem =
  | Passage
  | { kind: "chat"; at: number; row: ChatRow }
  | { kind: "event"; at: number; row: EventRow };

export type BuildPassagesOptions = {
  /**
   * A recording has one microphone and no room chat: split by time only
   * (breakpoints are ignored) and keep one segment per turn, so the page's
   * audio seek still lands on a single line.
   */
  recording?: boolean;
};

export function isEventRow(row: ThreadRow): row is EventRow {
  return typeof row.event === "string" && row.event.length > 0;
}

/** Cut to `max` characters with an ellipsis; shorter text is returned as is. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Fold segments into passages. A new passage starts when the silence before
 * a segment is at least PASSAGE_SILENCE_MS, when adding it would carry the
 * passage past PASSAGE_MAX_MS from its first t0, or when a breakpoint (the
 * `at` of a typed, agent or event row) falls between the previous segment
 * and this one on the wall clock.
 */
export function buildPassages(
  segments: TranscriptSegment[],
  breakAts: number[] = [],
  opts: BuildPassagesOptions = {},
): Passage[] {
  const ordered = [...segments].sort((a, b) => a.seq - b.seq);
  const breaks = opts.recording ? [] : [...breakAts].sort((a, b) => a - b);
  const runs: TranscriptSegment[][] = [];
  let bi = 0;
  for (const s of ordered) {
    const run = runs[runs.length - 1];
    if (!run) {
      runs.push([s]);
      continue;
    }
    const prev = run[run.length - 1];
    const first = run[0];
    const silence = s.t0 - (prev.t1 ?? prev.t0) >= PASSAGE_SILENCE_MS;
    const tooLong = (s.t1 ?? s.t0) - first.t0 > PASSAGE_MAX_MS;
    // Breakpoints are sorted, so skip the ones already behind the previous
    // segment; the first remaining one splits if it lands at or before this
    // segment's wall clock.
    while (bi < breaks.length && breaks[bi] <= prev.at) bi++;
    const typedBetween = bi < breaks.length && breaks[bi] <= s.at;
    if (silence || tooLong || typedBetween) runs.push([s]);
    else run.push(s);
  }
  const toTurns = opts.recording ? oneSegmentTurns : groupTurns;
  let offset = 0;
  return runs.map((run, index) => {
    const turns = toTurns(run).map((t) => ({ ...t, index: offset + t.index }));
    offset += turns.length;
    const speakers: Speaker[] = [];
    const seen = new Set<string>();
    for (const s of run) {
      if (seen.has(s.speaker_id)) continue;
      seen.add(s.speaker_id);
      speakers.push({ id: s.speaker_id, name: s.speaker_name });
    }
    return {
      kind: "passage",
      index,
      t0: run[0].t0,
      t1: run.reduce((m, s) => Math.max(m, s.t1 ?? s.t0), run[0].t0),
      at: run[0].at,
      speakers,
      turns,
      segments: run,
      wordCount: run.reduce((n, s) => n + countWords(s.text), 0),
      preview: previewOf(turns),
    };
  });
}

/** The passages' turns laid end to end: the list the call page selects in. */
export function flatTurns(passages: Passage[]): Turn[] {
  return passages.flatMap((p) => p.turns);
}

/**
 * The room in time order. Ties on `at` put rows before passages: a passage
 * that starts at the same instant a line was typed was split by that line,
 * so the line reads first. Equal kinds keep their input order.
 */
export function mergeTimeline(passages: Passage[], rows: ThreadRow[]): TimelineItem[] {
  const items: TimelineItem[] = [...passages];
  for (const row of rows) {
    items.push(isEventRow(row) ? { kind: "event", at: row.at, row } : { kind: "chat", at: row.at, row: row as ChatRow });
  }
  return items.sort((a, b) => a.at - b.at || rank(a) - rank(b));
}

function rank(item: TimelineItem): number {
  return item.kind === "passage" ? 1 : 0;
}

function previewOf(turns: Turn[]): string {
  let out = "";
  for (const t of turns) {
    const words = t.segments.map((s) => s.text.trim()).filter(Boolean).join(" ");
    if (!words) continue;
    const piece = `${firstName(t.speaker_name)}: ${words}`;
    out = out ? `${out} · ${piece}` : piece;
    if (out.length > PASSAGE_PREVIEW_CHARS) break;
  }
  return clip(out, PASSAGE_PREVIEW_CHARS);
}

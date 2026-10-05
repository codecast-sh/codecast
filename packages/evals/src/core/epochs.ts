import type { Epoch, FootingMarker, PromptFilePair, RunRow } from '@codecast/shared/contracts/evalsApi';

import { askedSet, batchStarts, BISECT_CADENCE, footingWith, type RulerOf, type VerdictRun } from './verdict';

// Prompt epochs: the stretches of a surface's history over which every
// freeze's rendered prompt held still. An epoch begins at the first batch
// where any freeze renders differently from its previous appearance. Read
// from the records alone (run.json promptSha, and the prompt files a rep
// wrote), so the legacy history needs no backfill, and a dirty rep counts by
// what it sent, not by the commit it sat on. Dry reps count: they render the
// real prompt. Bisect probes do not: they render old commits on purpose.

/** The fields the epoch walk reads from a rep. */
export type EpochRow = Pick<RunRow, 'id' | 'freezeId' | 'batch' | 'cadence' | 'promptSha'> & Partial<Pick<RunRow, 'surface' | 'batchAt' | 'stamp' | 'gitHead'>> & { createdAt?: string };

/** The prompt files a rep wrote. */
export interface PromptReader {
  /** Relative to the rep: callN/system.md, callN/prompt.md, agentN/prompt.md, agentN/thenK.md. */
  files(runId: string): string[];
  text(runId: string, file: string): string | null;
  /** The file's size in bytes, or null when it is missing: two sizes that differ settle that two files do, without reading either. */
  size(runId: string, file: string): number | null;
  /**
   * A short identity for a text, equal exactly when the texts are (a sha256),
   * so what is kept per rep stays small. Without it the text is its own
   * identity, which compares alike.
   */
  hash?(text: string): string;
}

const UNIT = /^(call|agent)(\d+)$/;

/** Sorts prompt files the way the model saw them: call units, then agent units, each in order, system before prompt before each then. */
const fileOrder = (f: string): string => {
  const [unit = '', file = ''] = f.split('/');
  const u = UNIT.exec(unit);
  const rank = file === 'system.md' ? 0 : file === 'prompt.md' ? 1 : 2 + Number(/\d+/.exec(file)?.[0] ?? 0);
  return `${u?.[1] === 'call' ? 0 : 1}${String(u?.[2] ?? 0).padStart(4, '0')}${String(rank).padStart(4, '0')}`;
};

export const sortPromptFiles = (files: Iterable<string>): string[] => [...files].sort((a, b) => fileOrder(a).localeCompare(fileOrder(b)));

const kept = new WeakMap<PromptReader, Map<string, unknown>>();

/** A rep's prompts never change, so what is learned about them is kept per reader. */
function remember<T>(reader: PromptReader, k: string, make: () => T): T {
  const m = kept.get(reader) ?? new Map<string, unknown>();
  kept.set(reader, m);
  if (!m.has(k)) m.set(k, make());
  return m.get(k) as T;
}

const identity = (reader: PromptReader, text: string): string => (reader.hash ? reader.hash(text) : text);
const filesOf = (reader: PromptReader, runId: string): string[] => remember(reader, `files\x1f${runId}`, () => reader.files(runId));
const sizeOf = (reader: PromptReader, runId: string, file: string): number | null => remember(reader, `size\x1f${runId}\x1f${file}`, () => reader.size(runId, file));
const hashOf = (reader: PromptReader, runId: string, file: string): string => remember(reader, `hash\x1f${runId}\x1f${file}`, () => identity(reader, reader.text(runId, file) ?? ''));

const when = (r: EpochRow): string => r.batchAt ?? r.stamp ?? r.createdAt ?? '';
const byTime = (a: EpochRow, b: EpochRow) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0);
const key = (batch: string, freezeId: string) => `${batch}\x1f${freezeId}`;

/** A surface's batches oldest first, by when each began (batch names do not all sort by time), bisect probes left out. */
export function timeline<R extends EpochRow>(rows: R[]): Array<{ batch: string; at: string; reps: R[] }> {
  const kept = rows.filter((r) => r.batch && r.cadence !== BISECT_CADENCE);
  const starts = batchStarts(kept);
  const by = new Map<string, R[]>();
  for (const r of kept) {
    if (!by.has(r.batch!)) by.set(r.batch!, []);
    by.get(r.batch!)!.push(r);
  }
  return [...by]
    .map(([batch, reps]) => ({ batch, at: starts.get(batch) ?? batch, reps }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.batch < b.batch ? -1 : 1));
}

/** The promptSha most of a batch's reps on a freeze carry (the first such on a tie). */
const modalSha = (reps: EpochRow[]): string => {
  const n = new Map<string, number>();
  for (const r of reps) n.set(r.promptSha!, (n.get(r.promptSha!) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]![0];
};

/** Surfaces whose promptSha covers one prompt only, not what the rep's files hold: org-review hashes its analyzer prompt. */
const ANALYZER_ONLY = new Set(['org-review']);

/**
 * What each freeze rendered in each batch, as one key. Mostly the reps'
 * promptSha. A surface whose later call quotes an earlier reply (ask's
 * second call quotes the first's excerpts) renders differently on every rep,
 * so for a freeze whose reps ever disagree within a batch the key is the
 * prompt files that held still across reps: every file seen to vary within a
 * batch of that freeze is left out, everywhere. Where no file holds still, or
 * the surface's promptSha covers one prompt only (ANALYZER_ONLY), the key is
 * the batch's most common promptSha.
 */
export function renderKeys(rows: EpochRow[], reader: PromptReader, surface?: string): Map<string, string> {
  const shas = new Map<string, Map<string, EpochRow[]>>();
  for (const r of rows) {
    if (!r.batch || !r.promptSha || r.cadence === BISECT_CADENCE) continue;
    if (!shas.has(r.freezeId)) shas.set(r.freezeId, new Map());
    const f = shas.get(r.freezeId)!;
    if (!f.has(r.batch)) f.set(r.batch, []);
    f.get(r.batch)!.push(r);
  }
  const out = new Map<string, string>();
  for (const [freezeId, batches] of shas) {
    const unstable = [...batches.values()].some((reps) => new Set(reps.map((r) => r.promptSha)).size > 1);
    if (!unstable || ANALYZER_ONLY.has(surface ?? rows[0]?.surface ?? '')) {
      for (const [batch, reps] of batches) out.set(key(batch, freezeId), modalSha(reps));
      continue;
    }
    const varying = new Set<string>();
    for (const all of batches.values()) {
      // Reps with one promptSha sent the same prompt files, so one rep stands for each sha.
      const reps = all.filter((r, i) => all.findIndex((x) => x.promptSha === r.promptSha) === i);
      if (reps.length < 2) continue;
      for (const f of new Set(reps.flatMap((r) => filesOf(reader, r.id)))) {
        if (varying.has(f)) continue;
        const differ = (v: (id: string) => unknown) => new Set(reps.map((r) => v(r.id))).size > 1;
        if (reps.some((r) => !filesOf(reader, r.id).includes(f)) || differ((id) => sizeOf(reader, id, f)) || differ((id) => hashOf(reader, id, f))) varying.add(f);
      }
    }
    for (const [batch, reps] of batches) {
      const first = reps[0]!.id;
      const held = filesOf(reader, first).filter((f) => !varying.has(f));
      out.set(key(batch, freezeId), held.length ? identity(reader, held.map((f) => `${f} ${hashOf(reader, first, f)}`).join('\n')) : modalSha(reps));
    }
  }
  return out;
}

/** The newest commit most of a batch's reps sat on. */
const commonHead = (reps: EpochRow[]): string | null => {
  const n = new Map<string, number>();
  for (const r of reps) if (r.gitHead) n.set(r.gitHead, (n.get(r.gitHead) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/** The epoch walk, with where each changed freeze last appeared before its boundary. */
function walk(rows: EpochRow[], surface: string, reader: PromptReader): Array<Epoch & { previous: Map<string, string> }> {
  const keys = renderKeys(rows, reader, surface);
  const last = new Map<string, { key: string; batch: string }>();
  const epochs: Array<Epoch & { previous: Map<string, string> }> = [];
  for (const { batch, at, reps } of timeline(rows)) {
    const here = [...new Set(reps.map((r) => r.freezeId))].filter((f) => keys.has(key(batch, f)));
    const changed = here.filter((f) => last.has(f) && last.get(f)!.key !== keys.get(key(batch, f)));
    const current = epochs.at(-1);
    if (here.length && (!current || changed.length)) {
      epochs.push({
        n: epochs.length + 1,
        surface,
        firstBatch: batch,
        firstBatchAt: at,
        lastBatch: batch,
        gitHead: commonHead(reps),
        changedFreezes: current ? changed : here,
        scope: ANALYZER_ONLY.has(surface) ? 'analyzer-only' : 'rendered',
        previous: new Map(changed.map((f) => [f, last.get(f)!.batch])),
      });
    } else if (current) current.lastBatch = batch;
    for (const f of here) last.set(f, { key: keys.get(key(batch, f))!, batch });
  }
  return epochs;
}

/** A surface's prompt epochs, oldest first. org-review's are scoped to its analyzer prompt, the only one its promptSha covers. */
export function epochsOf(rows: EpochRow[], surface: string, reader: PromptReader): Epoch[] {
  return walk(rows.filter((r) => !r.surface || r.surface === surface), surface, reader).map(({ previous: _, ...e }) => e);
}

/**
 * Two reps' prompt files side by side: every file either wrote, in the order
 * the model saw them, and with `changedOnly` just the files whose text differs.
 */
export function promptPairs(reader: PromptReader, freezeId: string, a: string, b: string, changedOnly = true): PromptFilePair[] {
  const files = sortPromptFiles(new Set([...reader.files(a), ...reader.files(b)]));
  return files
    .map((file) => ({ freezeId, file, a: { runId: a, text: reader.text(a, file) }, b: { runId: b, text: reader.text(b, file) } }))
    .filter((p) => !changedOnly || p.a.text !== p.b.text);
}

/**
 * Epoch n against n-1, per changed freeze: the prompt files that differ
 * between the last rep before the boundary and the first rep after it. Both
 * answered the same moment, so this is exactly what the model saw change,
 * dirty or not. Empty for the first epoch.
 */
export function epochPromptDiffs(rows: EpochRow[], surface: string, n: number, reader: PromptReader): PromptFilePair[] {
  const scoped = rows.filter((r) => !r.surface || r.surface === surface);
  const e = walk(scoped, surface, reader)[n - 1];
  if (!e || n < 2) return [];
  return e.changedFreezes.flatMap((freezeId) => {
    const of = (batch: string | undefined) => scoped.filter((r) => r.batch === batch && r.freezeId === freezeId && r.promptSha).sort(byTime);
    const before = of(e.previous.get(freezeId)).at(-1);
    const after = of(e.firstBatch)[0];
    return before && after ? promptPairs(reader, freezeId, before.id, after.id) : [];
  });
}

/** Where a surface's footing moved from one batch to the next: the model its reps answered on, or the judge's ruler. Dry and bisect batches are left out. */
export function footingMarkers<R extends VerdictRun & EpochRow>(rows: R[], ruler: RulerOf<R>): FootingMarker[] {
  const out: FootingMarker[] = [];
  let prev: { model: string | null; ruler: string | null } | null = null;
  for (const { batch, at } of timeline(rows)) {
    const graded = askedSet(rows, batch);
    if (!graded.length) continue;
    const f = footingWith(graded[0]!, ruler);
    if (prev && prev.model !== f.model) out.push({ batch, batchAt: at, kind: 'model', from: prev.model, to: f.model });
    if (prev && prev.ruler !== f.ruler) out.push({ batch, batchAt: at, kind: 'judge', from: prev.ruler, to: f.ruler });
    prev = f;
  }
  return out;
}

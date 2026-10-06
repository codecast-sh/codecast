import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Epoch, FootingMarker, PromptFilePair } from '@codecast/shared/contracts/evalsApi';
import { epochPromptDiffs as diffsWith, epochsOf as epochsWith, footingMarkers as markersWith, sortPromptFiles, type EpochRow, type PromptReader } from '@platform/evals/analysis';

import { defaultRuler, type RulerOf, type VerdictRun } from '../commands/verdict';
import { homePaths } from '../paths';

// Prompt epochs over codecast's run folders: the walk is
// @platform/evals/analysis epochs.ts; here are the reader that reads (and
// hashes) the prompt files a rep wrote under EVALS_HOME/runs, and the walk
// bound to that reader and codecast's ruler.

export { promptPairs, sortPromptFiles, timeline } from '@platform/evals/analysis';
export type { EpochRow, PromptReader } from '@platform/evals/analysis';

const PROMPT_FILE = /^(?:system|prompt|then\d+)\.md$/;
const UNIT = /^(call|agent)(\d+)$/;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const readers = new Map<string, PromptReader>();

/** Reads prompt files from run folders under EVALS_HOME/runs, one reader per folder root. Texts are known by their sha256. */
export function folderPromptReader(runsDir = homePaths().runs): PromptReader {
  const hit = readers.get(runsDir);
  if (hit) return hit;
  const reader: PromptReader = {
    files(runId) {
      const dir = join(runsDir, runId);
      if (!existsSync(dir)) return [];
      const out: string[] = [];
      for (const unit of readdirSync(dir)) {
        if (!UNIT.test(unit)) continue;
        for (const f of readdirSync(join(dir, unit))) if (PROMPT_FILE.test(f)) out.push(`${unit}/${f}`);
      }
      return sortPromptFiles(out);
    },
    text(runId, file) {
      const path = join(runsDir, runId, file);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    },
    size(runId, file) {
      const path = join(runsDir, runId, file);
      return existsSync(path) ? statSync(path).size : null;
    },
    hash: sha,
  };
  readers.set(runsDir, reader);
  return reader;
}

/** A surface's prompt epochs, oldest first. org-review's are scoped to its analyzer prompt, the only one its promptSha covers. */
export const epochsOf = (rows: EpochRow[], surface: string, reader: PromptReader = folderPromptReader()): Epoch[] => epochsWith(rows, surface, reader);

/** Epoch n against n-1, per changed freeze: the prompt files that differ across the boundary (@platform/evals/analysis epochs.ts). */
export const epochPromptDiffs = (rows: EpochRow[], surface: string, n: number, reader: PromptReader = folderPromptReader()): PromptFilePair[] => diffsWith(rows, surface, n, reader);

/** Where a surface's footing moved from one batch to the next, on codecast's ruler by default. */
export const footingMarkers = <R extends VerdictRun & EpochRow>(rows: R[], ruler: RulerOf<R> = defaultRuler): FootingMarker[] => markersWith(rows, ruler);

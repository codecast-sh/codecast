import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Merges a run's proposals/op-*.json (the conversation harness, round 20 on)
// into <dir>/proposal.json so the grader reads the changes as one list (the
// port of ~/.cache/org-eval/bin/assemble-proposals.py). summary_md joins each
// proposal's, prefixed by its op number; asks are dropped (their seqs are per
// file).

export interface AssembledProposal {
  title: string;
  summary_md: string;
  mode: unknown;
  changes: any[];
  proposals: number;
}

const opNumber = (file: string): number => Number(/op-(\d+)/.exec(file)![1]);

/** The op files in the order the agent wrote them, by number. */
export function proposalFiles(dir: string): string[] {
  const d = join(dir, 'proposals');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => /^op-.*\.json$/.test(f) && /op-\d+/.test(f))
    .sort((a, b) => opNumber(a) - opNumber(b))
    .map((f) => join(d, f));
}

/** Python's d.get(k, default): a key that is present keeps its value, null included. */
const get = (d: Record<string, unknown>, k: string, fallback: unknown): unknown => (k in d ? d[k] : fallback);
/** Python's f-string of a value: None prints as "None". */
const str = (v: unknown): string => (v === null ? 'None' : String(v));

export function assembleProposals(dir: string): AssembledProposal {
  const changes: any[] = [];
  const summaries: string[] = [];
  let title: unknown = null;
  let mode: unknown = 'review';
  const files = proposalFiles(dir);
  for (const f of files) {
    const d = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
    title = title || get(d, 'title', null);
    mode = get(d, 'mode', mode);
    summaries.push(`[op-${/op-(\d+)/.exec(f)![1]}] ${str(get(d, 'summary_md', ''))}`);
    changes.push(...((get(d, 'changes', []) as any[]) ?? []));
  }
  const out: AssembledProposal = { title: (title as string) || 'Company review', summary_md: summaries.join('\n\n'), mode, changes, proposals: files.length };
  writeFileSync(join(dir, 'proposal.json'), JSON.stringify(out, null, 1));
  return out;
}

import { readFileSync } from 'node:fs';

import { parseOrgProposalSpec } from '@codecast/shared/contracts/orgProposal';

// The checker an org-review agent runs on each proposal file it writes (the
// port of ~/.cache/org-eval/bin/check.ts): the prod contract's parse, and the
// counts the harness note's loop reads. `bun checkProposal.ts <file>` prints
// it; the `spec-parses` gate calls checkProposal() on the same files.

export interface ProposalCheck {
  errors: unknown[];
  written?: number;
  rows?: number;
  notes?: unknown;
  askWords: number;
  asks?: Array<{ title: string; titleWords: number; changes: number }>;
  covered?: number;
}

export function checkProposal(raw: any): ProposalCheck {
  const r: any = parseOrgProposalSpec(raw);
  const ask = String(raw?.summary_md ?? '').split(/\n\*\*/)[0]!;
  return {
    errors: r.errors,
    written: raw?.changes?.length,
    rows: r.spec?.changes.length,
    notes: r.notes,
    askWords: ask.split(/\s+/).filter(Boolean).length,
    asks: r.spec?.asks?.map((a: any) => ({ title: a.title, titleWords: a.title.split(/\s+/).length, changes: a.seqs.length })),
    covered: r.spec?.asks?.reduce((n: number, a: any) => n + a.seqs.length, 0),
  };
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: bun checkProposal.ts <proposal spec .json>');
    process.exit(2);
  }
  console.log(JSON.stringify(checkProposal(JSON.parse(readFileSync(file, 'utf8'))), null, 1));
}

import * as fs from 'node:fs';

import { evalsSnippet, EVALS_SNIPPET_END } from '@platform/evals/snippet';
import { installSectionToFile, nodeFs, removeSectionFromTargets, snippetContentHash, type SnippetDefinition } from '@platform/snippets';

import { AGENTS_MD } from './paths';

// The reference agents read, stamped into AGENTS.md (CLAUDE.md is a symlink to
// it) so every session in the tree gets it. The body is the platform's; these
// notes are what is specific to codecast.

export const REPO_NOTES = `
In this repo: a ref names its surface, \`<surface>@<ref>\`: \`title@jx7c6zk:142\`
(a session and line), \`call-summary@<callId>\`, \`role-wake@tr-42\`,
\`org-review@union-base8\` (a snapshot name), or \`<surface>@fixture:<case>\` for
a committed synthetic case. \`./evals\` with no arguments lists every surface
with its route, model, freezes, last runs and whether it is stale.

Two data homes. Synthetic fixtures and their freeze pointers are committed
under \`packages/evals\`. Everything real (private freezes, snapshots, runs,
labels, pages) lives in \`EVALS_HOME\` (\`~/.local/share/codecast/evals\`,
or \`CODECAST_EVALS_HOME\`), and its \`labels/\` is a git repo pushed to the
private \`ashot/codecast-eval-labels\`. The repo is public: real content,
transcripts, names, ids or labels never enter git.

\`./evals check [surface…] [--reps n] [--model id] [--budget usd] [--dry]\`
replays every freeze of a surface through \`prompt-dry-run.ts\` on its pinned
model and prints a verdict against the previous run set. Never claim a win
without \`separated: better\` (an exact one-sided Mann-Whitney at p <= 0.05
with 5+ reps a side), and a single gate failure in any sample fails the
variant. Agent surfaces (org-review, role-wake, anchor-brief) are run by hand
only: the cadence triggers flag them and never run them. \`./evals stale\` is
the precheck, \`./evals doctor\` says what is missing here.
`;

export const EVALS_SNIPPET = evalsSnippet({ name: 'evals', repoNotes: REPO_NOTES });

export const EVALS_SNIPPET_DEF: SnippetDefinition = {
  slug: 'platform-evals',
  name: 'evals: conversations, freezes, replays and evals',
  desc: 'the reference for freezing codecast moments, replaying prompts against them and reading the score',
  detail: 'Stamped into the repo AGENTS.md so every session in the tree gets it.',
  writesTo: 'AGENTS.md, a ## Conversations, freezes, simulations and evals section with the command reference',
  shipped: '2026-10-01',
  enabledKey: 'snippet.evals',
  versionKey: 'snippet.evals.hash',
  section: {
    spec: { headings: ['## Conversations, freezes, simulations and evals (`evals`)'], endMarker: EVALS_SNIPPET_END },
    body: EVALS_SNIPPET,
  },
};

export function installSnippet(filePath = AGENTS_MD) {
  const section = EVALS_SNIPPET_DEF.section!;
  return installSectionToFile(nodeFs, { filePath }, section.spec, section.body, true);
}

export function removeSnippet(filePath = AGENTS_MD): boolean {
  return removeSectionFromTargets(nodeFs, [{ filePath }], EVALS_SNIPPET_DEF.section!.spec);
}

export function snippetInstalled(filePath = AGENTS_MD): 'current' | 'stale' | 'missing' {
  if (!fs.existsSync(filePath)) return 'missing';
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.includes(EVALS_SNIPPET_END)) return 'missing';
  return text.includes(snippetContentHash(EVALS_SNIPPET_DEF.section!.body)) || text.includes(EVALS_SNIPPET.trim()) ? 'current' : 'stale';
}

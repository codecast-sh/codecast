import * as fs from 'node:fs';

import { EVALS_SNIPPET_END } from '@platform/evals/snippet';
import { installSectionToFile, nodeFs, removeSectionFromTargets, snippetContentHash, type SnippetDefinition } from '@platform/snippets';

import { AGENTS_MD } from './paths';

// The reference agents read, stamped into AGENTS.md (CLAUDE.md is a symlink to
// it) so every session in the tree gets it. Only what applies in codecast: the
// platform's generic reference also covers channels, phones and simulations,
// which this tree does not have, so it is not stamped here.

const HEADING = '## Prompt evals (`evals`)';

export const REPO_NOTES = `
\`./evals\` replays the prod prompts in this tree against frozen codecast
moments and grades the replies. Reads never change anything, and every read
takes \`--json\`. The design is \`docs/architecture/evals.md\`.

A surface is one prod prompt (title, settle, insight, call-summary, ask,
handoff, suggest, org-review, role-wake, anchor-brief). A conversation is a
codecast session: \`convo inbox\` lists your sessions and \`convo show
<session>\` reads one. A ref names its surface, \`<surface>@<ref>\`:
\`title@jx7c6zk:142\` (a session and line), \`call-summary@<callId>\`,
\`role-wake@tr-42\`, \`org-review@union-base8\` (a snapshot name), or
\`<surface>@fixture:<case>\` for a committed synthetic case.

The loop: \`./evals freeze create title@jx7c6zk:142\` → \`./evals check title
--reps 5\` (the baseline) → edit the prompt → \`./evals check title\` →
\`./evals freeze results <id>\`.

\`\`\`bash
./evals                                   # every surface: route, model, freezes, last runs, stale
./evals convo inbox | show <session> | find "<text>"
./evals freeze create <surface>@<ref> [--judge "the reply must …"]
./evals freeze list | show <id> | results <id> | diff <id> --run A --run B
./evals freeze replay <id> --reps 3       # one freeze; check replays them all
./evals freeze judge <id> "the reply must …" [--rejudge]
./evals freeze label <id> '<json>'|-       # a private freeze's label: written, committed, pushed
./evals check [surface…] [--reps n] [--model id] [--budget usd] [--dry]
./evals stale [surface…]                  # the precheck: exit 0 when a surface changed
./evals runs [show|score|diff] …          # every eval run, from the evidence folders
./evals doctor                            # what is missing here
\`\`\`

\`check\` replays every freeze of a surface through \`prompt-dry-run.ts\` on
its pinned model and prints a verdict against the previous run set. Never
claim a win without \`separated: better\` (an exact one-sided Mann-Whitney at
p <= 0.05 with 5+ reps a side). Gates are decided in code, and a single gate
failure in any sample fails the variant. Agent surfaces (org-review,
role-wake, anchor-brief) are run by hand only: the cadence triggers flag them
and never run them.

Two data homes. Synthetic fixtures and their freeze pointers are committed
under \`packages/evals\`. Everything real (private freezes, snapshots, runs,
labels, pages) lives in \`EVALS_HOME\` (\`~/.local/share/codecast/evals\`,
or \`CODECAST_EVALS_HOME\`), and its \`labels/\` is a git repo pushed to the
private \`ashot/codecast-eval-labels\`. The repo is public: real content,
transcripts, names, ids or labels never enter git.
`;

export const EVALS_SNIPPET = `
${HEADING}

${REPO_NOTES.trim()}

${EVALS_SNIPPET_END}
`;

export const EVALS_SNIPPET_DEF: SnippetDefinition = {
  slug: 'platform-evals',
  name: 'evals: freezes, replays and evals of the prod prompts',
  desc: 'the reference for freezing codecast moments, replaying prompts against them and reading the score',
  detail: 'Stamped into the repo AGENTS.md so every session in the tree gets it.',
  writesTo: 'AGENTS.md, a ## Prompt evals section with the command reference',
  shipped: '2026-10-01',
  enabledKey: 'snippet.evals',
  versionKey: 'snippet.evals.hash',
  section: {
    // The second heading is the one the platform's generic reference used, so
    // a re-stamp replaces that section in place.
    spec: { headings: [HEADING, '## Conversations, freezes, simulations and evals (`evals`)'], endMarker: EVALS_SNIPPET_END },
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

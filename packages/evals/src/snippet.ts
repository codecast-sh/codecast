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
moments and grades the replies. The loop: freeze a moment, run \`check\` for a
baseline, edit the prompt, \`check\` again. \`./evals --help\` and each
command's \`--help\` carry the details; \`./evals doctor\` says what is missing.

- Claim a prompt win only when \`check\` prints \`separated: better\`.
- Real data (freezes, runs, labels) lives in \`EVALS_HOME\`, never in git: this
  repo is public. Only synthetic fixtures are committed.
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

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { buildOrgAnalyzerPrompt, summarizeInputs } from '../../../../cli/src/orgInitRun';
import { REPO_ROOT } from '../../paths';
import { recordSentence } from '../../served';

// One org-review sample's briefing (the port of ~/.cache/org-eval/bin/mkrun.ts):
// the analyzer prompt built from the working tree (the prompt under test) over
// a snapshot's saved inputs, plus the harness note that turns "post a
// proposal" into "write its spec to a file and check it". The hashes mkrun
// wrote to hashes.json are kept, and the prompt's full sha256 becomes
// run.json.promptSha (its first 12 characters are the old `prompt` hash).

export type OrgMode = 'init' | 'review';

/** The checker the harness note sends the agent to; run from the agent's own cwd, so absolute. */
export const CHECK_SCRIPT = join(REPO_ROOT, 'packages', 'evals', 'src', 'surfaces', 'orgReview', 'checkProposal.ts');

/** What to write instead of posting. The text is mkrun's, with its two paths pointed here; `frozen` is what the served dir freezes. */
export function harnessNote(proposalsDir: string, frozen: string[]): string {
  return `
## Dry run (harness note)

This run grades the briefing, so nothing is posted. ${recordSentence(frozen)} Do everything else the briefing asks, the records included. Where you would post a proposal, write its spec to \`${proposalsDir}/op-<n>.json\` (n counting from 1, across every turn) instead of running \`cast org propose\`, check it with \`bun ${CHECK_SCRIPT} <that file>\` until it prints \`"errors": []\`, and write \`op-<n>\` where its short id would go. Run every command in the foreground and wait for it; never start a command in the background, because a turn that ends waiting on one ends this run with no message. Each of your turns ends with the message you would send the person, verbatim and nothing else, with any card lines where they would go; the person's reply, when one comes, arrives as the next message.
`;
}

export interface OrgHashes {
  inputs: string;
  prompt: string;
  served: string;
  mode: OrgMode;
  built_at: string;
  workspace: string;
  /** sha256 of the analyzer prompt alone: what run.json.promptSha records. */
  promptSha: string;
}

export interface OrgBriefing {
  /** The analyzer prompt as prod builds it. */
  prompt: string;
  /** What the agent reads: the prompt plus the harness note. */
  briefing: string;
  hashes: OrgHashes;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function buildBriefing(o: { inputsText: string; workspace: string; served: string; proposalsDir: string; frozen: string[]; mode?: OrgMode; now?: Date }): OrgBriefing {
  const inputs = JSON.parse(o.inputsText) as { workspace?: { name?: string } };
  const mode = o.mode ?? 'review';
  const name = inputs.workspace?.name ?? o.workspace;
  const prompt = buildOrgAnalyzerPrompt({ mode, workspace: name, teamFlag: name, summary: summarizeInputs(inputs) });
  const promptSha = sha(prompt);
  return {
    prompt,
    briefing: prompt + harnessNote(o.proposalsDir, o.frozen),
    hashes: { inputs: sha(o.inputsText).slice(0, 12), prompt: promptSha.slice(0, 12), served: o.served, mode, built_at: (o.now ?? new Date()).toISOString(), workspace: o.workspace, promptSha },
  };
}

import { readFileSync } from 'node:fs';

import type { Command } from 'commander';
import type { EvalSources } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { freezeMeta, hasSnapshot, loadLabel, loadSnapshot } from '../adapters/resolver';
import { writeLabel } from '../labels';
import { freezeContext, GRADE_SETS, moveInGradeSets, SURFACE as ORG_REVIEW } from '../surfaces/orgReview/grade';

export interface LabelFlags {
  move?: string;
  to?: string;
  why?: string;
}

// `./evals freeze label <freeze> [json]`: a freeze's label, read or set. A
// private freeze's label is written to EVALS_HOME/labels and committed and
// pushed to the private labels repo in the same step (sd-319), so a hand
// label never sits only on one machine. A fixture carries its label inline,
// in git, so it is edited there. An org-review freeze grades on its
// workspace's grade sets: `--move <record> --to <set> --why <text>` moves one
// record there and records why in the workspace's private ground truth, the
// same commit and push (moveInGradeSets).

export async function runLabel(id: string, json: string | undefined, sources: EvalSources, flags: LabelFlags = {}): Promise<number> {
  const f = await sources.freezes!.get(id);
  if (!f) throw new UsageError(`no freeze ${id}`);
  const m = freezeMeta(f);
  if (flags.move !== undefined) {
    if (m.surface !== ORG_REVIEW) throw new UsageError(`--move edits an org-review workspace's grade sets; freeze ${f.id.slice(0, 8)} is ${m.surface || 'no surface'}'s`);
    const to = flags.to as (typeof GRADE_SETS)[number] | 'none' | undefined;
    if (!to || !(to === 'none' || (GRADE_SETS as readonly string[]).includes(to))) throw new UsageError(`--to takes one of ${GRADE_SETS.join(', ')} or none`);
    if (!flags.why?.trim()) throw new UsageError('--why is required: the reason is the label as much as the move is');
    const { workspace } = freezeContext(f);
    const from = moveInGradeSets(workspace, flags.move, to, flags.why);
    console.log(`moved ${flags.move} from ${from.join(', ') || 'no set'} to ${to} in ${workspace}'s grade sets, with why in its ground truth; committed and pushed. Every org-review freeze on ${workspace} grades on these sets`);
    return 0;
  }
  if (json === undefined) {
    const label = loadLabel(f, m.visibility === 'public' && hasSnapshot(f) ? loadSnapshot(f) : undefined);
    console.log(label === undefined ? `freeze ${f.id.slice(0, 8)} has no label` : JSON.stringify(label, null, 2));
    return 0;
  }
  if (m.visibility === 'public') throw new UsageError(`freeze ${f.id.slice(0, 8)} is a fixture: its label lives inline in ${m.snapshot}, which is edited in git`);
  if (!m.surface) throw new UsageError(`freeze ${f.id.slice(0, 8)} names no surface`);
  let label: unknown;
  try {
    label = JSON.parse(json === '-' ? readFileSync(0, 'utf8') : json);
  } catch (e) {
    throw new UsageError(`the label is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(`wrote, committed and pushed ${writeLabel(m.surface, f.id, label)}`);
  return 0;
}

export function registerLabel(program: Command, sources: EvalSources): void {
  const freeze = program.commands.find((c) => c.name() === 'freeze');
  if (!freeze) throw new Error('registerLabel runs after the freeze commands are registered');
  freeze
    .command('label <id> [json]')
    .description("print a freeze's label, or set a private freeze's label: written to EVALS_HOME/labels, committed and pushed to the private labels repo ('-' reads stdin)")
    .option('--move <record>', "org-review: move this record within the freeze's workspace grade sets")
    .option('--to <set>', `with --move: the set it moves to (${GRADE_SETS.join(', ')}, or none)`)
    .option('--why <text>', 'with --move: why, written to the workspace ground truth beside it')
    .action(async (id: string, json: string | undefined, flags: LabelFlags) => {
      process.exitCode = await runLabel(id, json, sources, flags);
    });
}

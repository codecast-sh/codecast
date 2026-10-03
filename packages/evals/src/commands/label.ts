import { readFileSync } from 'node:fs';

import type { Command } from 'commander';
import type { EvalSources } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { freezeMeta, hasSnapshot, loadLabel, loadSnapshot } from '../adapters/resolver';
import { writeLabel } from '../labels';

// `./evals freeze label <freeze> [json]`: a freeze's label, read or set. A
// private freeze's label is written to EVALS_HOME/labels and committed and
// pushed to the private labels repo in the same step (sd-319), so a hand
// label never sits only on one machine. A fixture carries its label inline,
// in git, so it is edited there.

export async function runLabel(id: string, json: string | undefined, sources: EvalSources): Promise<number> {
  const f = await sources.freezes!.get(id);
  if (!f) throw new UsageError(`no freeze ${id}`);
  const m = freezeMeta(f);
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
    .action(async (id: string, json: string | undefined) => {
      process.exitCode = await runLabel(id, json, sources);
    });
}

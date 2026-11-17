import type { Command } from 'commander';
import { fmt } from '@platform/cli-kit/colors';
import type { EvalSources } from '@platform/evals';
import { parseSince } from '@platform/cli-kit/text';
import { UsageError } from '@platform/evals/cli';

import { draft, findCorrections } from '../corrections/find';
import { loadCorrection, loadCorrections, saveCorrection, shortRef, splitFor, type Correction, type CorrectionStatus } from '../corrections/store';
import { surfaceRuns, type SurfaceRun } from '../adapters/runs';
import { writeLabel } from '../labels';

// `./evals corrections`: the lines people typed to correct how an agent
// works, found across a window of sessions and drafted into guidance cases;
// `freeze` makes each accepted draft a private freeze whose label and criteria
// are the check, so `check guidance` and `climb guidance` hold the prompt to it.

const json = (v: unknown): void => console.log(JSON.stringify(v, null, 2));

const SHOWN: CorrectionStatus[] = ['drafted', 'frozen', 'candidate'];
const one = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A frozen correction's newest batch: how many of its reps passed, the replay a reader checks first. */
function lastResult(freezeId: string | undefined, runs: SurfaceRun[]): string {
  const mine = runs.filter((r) => r.freezeId === freezeId && (r.status === 'pass' || r.status === 'fail'));
  if (!mine.length) return fmt.muted('not replayed');
  const batch = mine[0]!.batch;
  const set = mine.filter((r) => r.batch === batch);
  const passed = set.filter((r) => r.status === 'pass').length;
  const text = `${passed}/${set.length} pass`;
  return passed === set.length ? fmt.success(text) : passed === 0 ? fmt.error(text) : fmt.warning(text);
}

function table(rows: Correction[], runs: SurfaceRun[] = []): string {
  if (!rows.length) return fmt.muted('no corrections here: ./evals corrections find --since 14d looks for them');
  return rows
    .map((c) => {
      const head = `${fmt.bold(shortRef(c).padEnd(13))} ${c.at.slice(0, 10)}  ${c.status.padEnd(9)} ${c.freezeId ? `${fmt.muted(`freeze ${c.freezeId.slice(0, 8)}${c.split ? ` ${c.split}` : ''}`)}  ${lastResult(c.freezeId, runs)}` : ''}`;
      const lines = [head, `  said   ${one(c.said, 150)}`];
      if (c.draft) {
        lines.push(`  rule   ${one(c.draft.rule, 150)}`, `  ask    ${one(c.draft.request, 150)}`);
        if (c.draft.want.length || c.draft.avoid.length) lines.push(`  check  first action ${c.draft.want.length ? `~ ${c.draft.want.join(' | ')}` : ''}${c.draft.avoid.length ? `  not ${c.draft.avoid.join(' | ')}` : ''}`);
        lines.push(`  judge  ${one(c.draft.criteria, 150)}`);
      } else if (c.why) lines.push(fmt.muted(`  ${one(c.why, 150)}`));
      return lines.join('\n');
    })
    .join('\n\n');
}

function summary(all: Correction[]): string {
  const n = (s: CorrectionStatus) => all.filter((c) => c.status === s).length;
  return `${all.length} typed lines read: ${n('withheld') ? `${n('withheld')} withheld by the vendor guard, ` : ''}${n('not-behavior')} about the work, ${n('not-guidance')} about how an agent works but not the guidance's to fix, ${n('drafted')} drafted, ${n('frozen')} frozen, ${n('dismissed')} dismissed`;
}

/** Makes one drafted correction a private guidance freeze: criteria on the freeze, want/avoid as its label, tagged `correction`. */
export async function freezeCorrection(c: Correction, sources: EvalSources): Promise<string> {
  if (!c.draft) throw new UsageError(`${shortRef(c)} has no draft (${c.status})`);
  if (c.freezeId) return c.freezeId;
  const store = sources.freezes!;
  const resolver = sources.freezeResolver!;
  const moment = await resolver.resolve({ messageRef: `guidance@${c.conversation}:${c.line}` });
  const f = await store.create({ ...moment, judge: c.draft.criteria || null, notes: `Correction: "${one(c.said, 240)}"`, tags: ['correction'] });
  if (c.draft.want.length || c.draft.avoid.length) writeLabel('guidance', f.id, { want: c.draft.want, avoid: c.draft.avoid });
  c.status = 'frozen';
  c.freezeId = f.id;
  c.split ??= splitFor(c.id);
  saveCorrection(c);
  return f.id;
}

export function registerCorrections(program: Command, sources: EvalSources): void {
  const cmd = program
    .command('corrections')
    .description('the lines people typed to correct how an agent works, drafted into guidance cases; freeze them, then check or climb guidance')
    .option('--all', 'every line read, including the ones triage set aside')
    .option('--json', 'machine readable output')
    .action(async (flags) => {
      const all = loadCorrections();
      const rows = flags.all ? all : all.filter((c) => SHOWN.includes(c.status));
      if (flags.json) return json(rows);
      console.log(table(rows, rows.some((c) => c.freezeId) ? await surfaceRuns('guidance') : []));
      if (all.length) console.log(`\n${fmt.muted(summary(all))}`);
      const drafted = all.filter((c) => c.status === 'drafted');
      if (drafted.length) console.log(`\nNext: ./evals corrections freeze (all ${drafted.length} drafts), or dismiss <id> first`);
      else if (all.some((c) => c.status === 'frozen')) console.log(`\nNext: ./evals climb guidance`);
    });

  cmd
    .command('find')
    .description('read a window of sessions for typed corrections, triage them, and draft a guidance case for each that belongs there')
    .option('--since <t>', 'window: 7d, 2w', '14d')
    .option('--team', "the team's sessions too, not only your own")
    .option('--limit <n>', 'read at most this many new lines', (v) => Number(v))
    .option('--json', 'machine readable output')
    .action(async (flags) => {
      const from = parseSince(flags.since);
      if (!from) throw new UsageError('--since takes 7d, 2w or a date');
      const all = await findCorrections({ since: from, team: flags.team, limit: flags.limit, onLine: (l) => console.error(fmt.muted(l)) });
      if (flags.json) return json(all);
      console.log(table(all.filter((c) => SHOWN.includes(c.status))));
      console.log(`\n${fmt.muted(summary(all))}`);
    });

  cmd
    .command('draft [ids...]')
    .description('draft again (every draft when no id is named), after the drafter changed; --replace also redrafts frozen ones, removing their freezes')
    .option('--replace', 'remove the freeze of a frozen correction and draft it again')
    .action(async (ids: string[], flags) => {
      const picked = ids.length ? ids.map((id) => loadCorrection(id) ?? (() => { throw new UsageError(`no correction ${id}`); })()) : loadCorrections().filter((c) => c.status === 'drafted' || (flags.replace && c.status === 'frozen'));
      for (const c of picked) {
        if (c.freezeId) {
          if (!flags.replace) throw new UsageError(`${shortRef(c)} is freeze ${c.freezeId.slice(0, 8)}: --replace removes it and drafts again`);
          await sources.freezes!.remove(c.freezeId);
          // The freeze is gone: record that before drafting, so a failed draft never leaves the record pointing at it.
          c.freezeId = undefined;
          c.status = 'candidate';
          saveCorrection(c);
        }
        await draft(c, c.habit ?? c.draft?.rule ?? c.why ?? '');
        console.log(`${shortRef(c)}: ${c.status}${c.draft ? `  ${one(c.draft.request, 110)}` : `  ${c.why ?? ''}`}`);
      }
    });

  cmd
    .command('freeze [ids...]')
    .description('make drafted corrections private guidance freezes (every draft when no id is named)')
    .action(async (ids: string[]) => {
      const picked = ids.length ? ids.map((id) => loadCorrection(id) ?? (() => { throw new UsageError(`no correction ${id}`); })()) : loadCorrections().filter((c) => c.status === 'drafted');
      if (!picked.length) return console.log('nothing drafted to freeze');
      for (const c of picked) console.log(`${shortRef(c)} → freeze ${(await freezeCorrection(c, sources)).slice(0, 8)}`);
      console.log(`\nNext: ./evals check guidance --freeze <id> for a baseline, or ./evals climb guidance`);
    });

  cmd
    .command('dismiss <ids...>')
    .description('set drafts aside: not a case the guidance should be held to')
    .option('--why <text>', 'the reason, kept with it')
    .action((ids: string[], flags) => {
      for (const id of ids) {
        const c = loadCorrection(id);
        if (!c) throw new UsageError(`no correction ${id}`);
        if (c.freezeId) throw new UsageError(`${shortRef(c)} is freeze ${c.freezeId.slice(0, 8)} already: ./evals freeze rm ${c.freezeId.slice(0, 8)} first`);
        saveCorrection({ ...c, status: 'dismissed', why: flags.why ?? 'dismissed by hand' });
        console.log(`${shortRef(c)} dismissed`);
      }
    });
}

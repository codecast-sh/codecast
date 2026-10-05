import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { CheckResult, ConvoMessage, GateResult } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { parseProposal, type ExpectationProposalInput } from '../../../../shared/contracts/expectations';
import { substitute } from '../../../../shared/contracts/orgTemplateManifest';
import { treeRoot } from '../../paths';
import { gate, type ReplayResult, type SurfaceImpl } from '../../surface';
import { describeTurn, servedDirFor, withHarnessNote, type StandingWorld } from '../roleWake/world';
import { meta, PROMPT_REL } from './meta';

// expectations: one daily pass of a project's expectations routine (LM5). The
// agent reads the team's context since the document's cursor and writes one
// proposal. A fixture is a synthetic team: the document as it stands, then
// calls, chat, tasks and decisions in the window, some of them a person's
// ruling and some an agent's account of what shipped. The label names which
// records are a person's words and which are not, and the gates read the
// proposal the run wrote through the shared parser prod uses.

export interface ExpectationsSnap extends StandingWorld {
  /** The project the pass runs for, as the routine's prompt names it. */
  project: { ref: string; name: string };
}

export interface ExpectationsLabel {
  /** The document's cursor: where the window must start. */
  since: string;
  /** Records that are no source (an agent's shipped or verified note, a bot digest): no change may cite them. */
  not_sources?: string[];
  /** A person's rulings in the window: each should ground a change. */
  sources?: string[];
  /** The window holds nothing for the project: the proposal must change nothing. */
  empty?: boolean;
}

export const PROPOSAL_FILE = 'proposal.md';

/** The routine's prompt for this project, filled as prod fills it, then the harness note. */
export function briefing(snap: ExpectationsSnap): string {
  const text = substitute(readFileSync(join(treeRoot(), PROMPT_REL), 'utf8'), { 'project.name': snap.project.name, 'project.ref': snap.project.ref });
  return withHarnessNote(text, snap, [`Write the proposal to ${PROPOSAL_FILE} in the current directory: \`cast expectations propose\` is refused here, so that file is what this run is graded on.`]);
}

/** The proposal the run wrote, read with prod's parser: proposal.md, else the last file it wrote that parses. */
export function proposalOf(out: Pick<ReplayResult, 'agents'>): { proposal: ExpectationProposalInput; file: string } | { error: string } {
  const agent = out.agents[0];
  if (!agent) return { error: 'no agent ran' };
  const written = (agent.wrote ?? []).flat().map((f) => (isAbsolute(f) ? f : join(agent.runSubdir, f)));
  const candidates = [join(agent.runSubdir, PROPOSAL_FILE), ...written.reverse()].filter((f, i, all) => all.indexOf(f) === i && existsSync(f));
  let last = `no ${PROPOSAL_FILE} in the run dir`;
  for (const file of candidates) {
    try {
      return { proposal: parseProposal(readFileSync(file, 'utf8')), file };
    } catch (err) {
      last = `${file}: ${(err as Error).message}`;
    }
  }
  return { error: last };
}

/** Whether a citation names a record: refs are written several ways (`#infra/<id>`, `<id>`, `cl-150:42`), so a record matches by containment. */
const names = (ref: string, record: string): boolean => ref.toLowerCase().includes(record.toLowerCase());

const impl: SurfaceImpl = {
  refForms: 'expectations@ takes fixtures only, like expectations@fixture:infra-agent-notes',

  capture: async () => {
    throw new UsageError('expectations has no capture of real moments yet: freeze a fixture, like expectations@fixture:infra-agent-notes');
  },

  async replay(snap: ExpectationsSnap, ctx) {
    const serveDir = servedDirFor(snap, ctx, meta);
    const a = await ctx.agent({ prompt: briefing(snap), serveDir, model: ctx.model, maxTurns: 80 });
    const read = proposalOf({ agents: [a] });
    const shown = 'proposal' in read ? readFileSync(read.file, 'utf8').trim() : `(no proposal: ${read.error})`;
    return { reply: [`Proposal:\n${shown}`, ...a.said.slice(-1)].join('\n\n'), parsed: 'proposal' in read ? read.proposal : null };
  },

  gates(_snap: ExpectationsSnap, out, label?: ExpectationsLabel): GateResult[] {
    const read = proposalOf(out);
    if (!('proposal' in read)) return [gate('proposal-written', false, read.error)];
    const { proposal } = read;
    const gates = [gate('proposal-written', true, `${proposal.ops.length} change(s) in ${read.file.split('/').pop()}`)];
    if (!label) return gates;
    const since = Date.parse(label.since);
    gates.push(gate('window', proposal.since === since && (proposal.until ?? 0) > since, `since ${proposal.since ? new Date(proposal.since).toISOString() : 'unset'} (cursor ${label.since}), until ${proposal.until ? new Date(proposal.until).toISOString() : 'unset'}`));
    const borrowed = proposal.ops.flatMap((op) => op.citations.filter((c) => (label.not_sources ?? []).some((r) => names(c.ref, r))).map((c) => `${op.op}${op.op === 'add' ? '' : ` ${op.id}`} cites ${c.kind} ${c.ref}`));
    gates.push(gate('persons-words-only', borrowed.length === 0, borrowed.length ? `no source: ${borrowed.join('; ')}` : 'no change cites an agent note or a digest'));
    if (label.empty) gates.push(gate('nothing-to-change', proposal.ops.length === 0, `${proposal.ops.length} change(s) from a window that held nothing for the project`));
    return gates;
  },

  checks(_snap: ExpectationsSnap, out, label?: ExpectationsLabel): CheckResult[] {
    const read = proposalOf(out);
    const sources = label?.sources ?? [];
    if (!('proposal' in read) || !sources.length) return [];
    const cited = sources.filter((r) => read.proposal.ops.some((op) => op.citations.some((c) => names(c.ref, r))));
    return [{ id: 'rulings-grounded', ask: `a change grounded in each ruling the window holds (${sources.join(', ')})`, weight: 1, score: cited.length / sources.length, evidence: `${cited.length} of ${sources.length} cited${cited.length ? `: ${cited.join(', ')}` : ''}` }];
  },

  describe: (snap: ExpectationsSnap): ConvoMessage[] => describeTurn(briefing(snap), snap.captured_at, 'routine'),

  // The routine's text is the prompt under test, so the judge reads what the pass is for in its place.
  judgeMoment: (snap: ExpectationsSnap): ConvoMessage[] =>
    describeTurn(`(The routine's instructions are the prompt under test and are not shown. It is the daily pass that keeps ${snap.project.name}'s expectations current: it reads the team's context since the document's cursor and writes one proposal of changes, each quoting the words of the person who ruled it.)`, snap.captured_at, 'routine'),

  productionReply: () => null,
};

export default impl;

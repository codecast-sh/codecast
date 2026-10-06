import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import type { CheckResult, ConvoMessage } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { renderGuidanceFile, type GuidanceMode } from '../../../../shared/contracts/snippets';
import { gate, type AgentResult, type SurfaceImpl } from '../../surface';
import { describeTurn } from '../roleWake/world';
import { meta } from './meta';

// guidance: the codecast sections `cast install` writes into a person's
// global CLAUDE.md, rendered from the catalog in this tree. Each fixture is one
// request a person types; the run loads the rendered file as its user-level
// CLAUDE.md, and the checks read which tool the agent reached for first. The
// competing native tools (Agent, ScheduleWakeup, CronCreate, WebFetch, TodoWrite
// and the rest) are all present, so a choice between them is a real one.

export interface GuidanceSnap {
  captured_at: string;
  /** What the person types. */
  request: string;
  /** Full sections or stubs; full unless the fixture says otherwise. */
  mode?: GuidanceMode;
}

export interface GuidanceLabel {
  /** Actions that are the right first move (regexes over `Tool: input`, a Bash command as `Bash: <command>`). */
  want: string[];
  /** Actions that are the wrong first move. */
  avoid?: string[];
  /** A pattern the reply text must hold instead of (or as well as) an action, like a cast-canvas fence. */
  reply?: string;
}

/** The run's frame: identical in every arm, so it biases neither. */
const REHEARSAL =
  '\n\n(This is a rehearsal environment: some commands are recorded rather than executed, and their output says so. Take the step you would take for real. Once the work is started or set up, stop and say briefly what you did; do not wait for results.)';

/** Every top-level tool call of the run, in order, as `Tool: input` ("Bash: <command>" for the shell). */
export function actionsOf(agent: Pick<AgentResult, 'runSubdir'>): string[] {
  let text = '';
  try {
    text = readFileSync(join(agent.runSubdir, 'stream.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== 'assistant' || e.parent_tool_use_id) continue;
    for (const c of e.message?.content ?? []) {
      if (c?.type !== 'tool_use') continue;
      const input = c.input ?? {};
      out.push(`${c.name}: ${typeof input.command === 'string' ? input.command : JSON.stringify(input)}`);
    }
  }
  return out;
}

/** The first action that is either wanted or avoided, and which. */
export function firstDecisive(actions: string[], label: GuidanceLabel): { action: string; wanted: boolean } | null {
  const want = label.want.map((p) => new RegExp(p, 'i'));
  const avoid = (label.avoid ?? []).map((p) => new RegExp(p, 'i'));
  for (const action of actions) {
    if (want.some((re) => re.test(action))) return { action, wanted: true };
    if (avoid.some((re) => re.test(action))) return { action, wanted: false };
  }
  return null;
}

const promptOf = (snap: GuidanceSnap): string => snap.request + REHEARSAL;

const impl: SurfaceImpl = {
  refForms: 'guidance@ takes fixtures only, like guidance@fixture:delegate-audits',

  capture: async () => {
    throw new UsageError('guidance has no capture of real moments: freeze a fixture, like guidance@fixture:delegate-audits');
  },

  async replay(snap: GuidanceSnap, ctx) {
    const claudeMd = renderGuidanceFile(snap.mode ?? 'full', 'eval');
    const a = await ctx.agent({ prompt: promptOf(snap), model: ctx.model, maxTurns: 20, claudeMd, promptSha: createHash('sha256').update(claudeMd).digest('hex') });
    const actions = actionsOf(a);
    return { reply: [`Actions:\n${actions.map((x) => `- ${x.slice(0, 300)}`).join('\n') || '(none)'}`, ...a.said.slice(-1)].join('\n\n'), parsed: { actions, bytes: claudeMd.length } };
  },

  gates: (_snap: GuidanceSnap, out) => [gate('ran', out.agents.length === 1, `${out.agents.length} agent run(s)`)],

  checks(_snap: GuidanceSnap, out, label?: GuidanceLabel): CheckResult[] {
    const agent = out.agents[0];
    if (!agent || !label) return [];
    const checks: CheckResult[] = [];
    if (label.want.length) {
      const hit = firstDecisive(actionsOf(agent), label);
      checks.push({ id: 'first-choice', ask: `the first decisive action matches ${label.want.join(' | ')}`, weight: 1, score: hit?.wanted ? 1 : 0, evidence: hit ? `${hit.wanted ? 'wanted' : 'avoided'}: ${hit.action.slice(0, 240)}` : 'no wanted or avoided action' });
    }
    if (label.reply) {
      const said = agent.said.join('\n');
      const ok = new RegExp(label.reply, 'i').test(said);
      checks.push({ id: 'reply-form', ask: `the reply holds ${label.reply}`, weight: 1, score: ok ? 1 : 0, evidence: ok ? 'present' : 'absent' });
    }
    return checks;
  },

  describe: (snap: GuidanceSnap): ConvoMessage[] => describeTurn(promptOf(snap), snap.captured_at, 'request'),

  productionReply: () => null,
};

export default impl;

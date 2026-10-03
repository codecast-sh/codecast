import { spawnSync } from 'node:child_process';

import type { ConvoMessage } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { parseRouterReply, routerDecision, routerRequest, rosterText, type RouterRoster } from '../../../../convex/convex/lib/orgRouter';
import { ownerOf, type LeadRole } from '../../../../shared/contracts/orgLead';
import { apiConfig, toConvoMessages } from '../../adapters/convo';
import { gate, type Captured, type SurfaceImpl } from '../../surface';

// The semantic router (org-staffing.md S35) replayed as prod posts it: the
// roster of a workspace's roles and one request, through the same
// routerRequest. A real freeze is a task filed in a project or plan: the
// request is its title and description, and the expected owner is what the
// rule (ownerOf) says for that anchor, which the router never sees. The gates
// fail a confident wrong answer and pass a right one or an unsure answer that
// lists the right role; the judge reads the reason.

export interface RouteSnap {
  request: string;
  roster: RouterRoster;
  /** The owner the rule names for the request's real anchor, when there is one. */
  expected?: { handle: string; by: string } | null;
  task?: { short_id: string; title: string };
  approximate?: string[];
}

export interface RouteLabel {
  /** A person's correction of `expected`. */
  expected?: string;
}

const REF_FORMS = `route@ takes a fixture or a team and a task, like route@fixture:<case> or route@Union:ct-55017 (the task's title and description are the request; the rule's owner for its project or plan is the expected answer)`;

const castJson = (args: string[]): any => {
  const r = spawnSync('cast', [...args, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new UsageError(`cast ${args.join(' ')} --json failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  return JSON.parse(r.stdout);
};

/** The roster as the CLI's org tree carries it (charter, areas, the standing line, what it holds). */
export function rosterFromTree(tree: any): { roster: RouterRoster; roles: Array<LeadRole & { handle: string }> } {
  const roles: any[] = (tree.roles ?? []).filter((r: any) => r.status !== 'retired' && !r.assistant);
  const roster: RouterRoster = {
    workspace: tree.workspace?.name ?? 'workspace',
    roles: roles.map((r) => ({
      handle: r.handle,
      name: r.name,
      given_name: r.given_name ?? undefined,
      charter: (r.charter ?? '').trim() || undefined,
      areas: [
        ...(r.scope_names?.projects ?? []).map((p: any) => ({ kind: 'project' as const, title: p.title })),
        ...(r.scope_names?.plans ?? []).map((p: any) => ({ kind: 'plan' as const, title: p.title })),
      ],
      standing: r.standing?.state_line ? [r.standing.state_line] : [],
      holding: (r.sessions ?? []).filter((s: any) => !s.is_anchor && s.state !== 'done').slice(0, 6).map((s: any) => `session: ${(s.title ?? '').trim() || s.short_id}`),
      whole_workspace: !(r.scope?.project_ids?.length || r.scope?.plan_ids?.length) && /^(head-of-people|chief-of-staff)$/.test(r.handle) ? true : undefined,
    })),
  };
  return { roster, roles };
}

export const routeRequestFor = (snap: RouteSnap) => routerRequest(snap.roster, snap.request);

const DESCRIBE_CLOCK = Date.parse('2026-01-01T00:01:00.000Z');

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref): Promise<Captured> {
    const m = /^([^:]+):(ct-[a-z0-9]+)$/i.exec(ref.trim());
    if (!m) throw new UsageError(REF_FORMS);
    const [, team, taskRef] = m;
    const { siteUrl, apiToken } = apiConfig();
    const task: any = await (await fetch(`${siteUrl}/cli/work/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_token: apiToken, short_id: taskRef }) })).json();
    if (!task?._id) throw new UsageError(`no task ${taskRef} readable here`);
    const { roster, roles } = rosterFromTree(castJson(['org', 'ls', '--team', team]));
    let anchor = { project_id: task.project_id, plan_id: task.plan_id };
    if (!anchor.project_id && anchor.plan_id) {
      const plan: any = await (await fetch(`${siteUrl}/cli/plans/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_token: apiToken, id: anchor.plan_id }) })).json();
      anchor = { ...anchor, project_id: plan?.project_id };
    }
    const owner = ownerOf(anchor, roles);
    const expected = owner.kind === 'owner' ? { handle: owner.role.handle, by: anchor.plan_id && (owner.role.scope?.plan_ids ?? []).some((p: any) => String(p) === String(anchor.plan_id)) ? 'plan' : anchor.project_id && (owner.role.scope?.project_ids ?? []).some((p: any) => String(p) === String(anchor.project_id)) ? 'project' : 'workspace' } : null;
    const request = [task.title, (task.description ?? '').trim()].filter(Boolean).join('\n\n');
    const snapshot: RouteSnap = {
      request,
      roster,
      expected,
      task: { short_id: task.short_id, title: task.title },
      approximate: ['the roster is the org tree as the CLI prints it: charter text, area titles without goals, the pinned standing line, up to six held sessions; prod also reads the charter doc, the brief\'s dated lines and open tasks'],
    };
    return {
      snapshot,
      subject: { kind: 'task', id: String(task._id), title: task.title },
      asOf: new Date().toISOString(),
      anchor: { kind: 'message', id: `task:${task.short_id}` },
      name: `route ${task.short_id}`,
      meta: { team, task: task.short_id, expected: expected?.handle ?? null },
    };
  },

  async replay(snap: RouteSnap, ctx) {
    const r = await ctx.call(routeRequestFor(snap));
    const reply = parseRouterReply(r.text, snap.roster);
    return { reply: r.text, parsed: { reply, decision: routerDecision(reply) } };
  },

  gates(snap: RouteSnap, out, label?: RouteLabel) {
    const parsed = out.parsed as { reply: ReturnType<typeof parseRouterReply>; decision: ReturnType<typeof routerDecision> } | undefined;
    const reply = parsed?.reply ?? null;
    const decision = parsed?.decision;
    const gates = [gate('parse', reply !== null, reply ? `handle ${reply.handle ?? 'null'} at ${reply.confidence}` : `no JSON answer in: ${out.reply.slice(0, 120)}`)];
    const expected = label?.expected ?? snap.expected?.handle;
    if (expected && decision) {
      const filedTo = decision.kind === 'file' ? decision.handle : null;
      gates.push(gate('no-misfile', !filedTo || filedTo === expected, filedTo ? `filed to @${filedTo}, expected @${expected}` : `asked, not filed`));
      const named = decision.kind === 'file' ? [decision.handle] : decision.choices.map((c) => c.handle);
      gates.push(gate('owner-known', named.includes(expected), `expected @${expected}; ${decision.kind === 'file' ? 'filed to' : 'choices'} ${named.map((h) => `@${h}`).join(', ') || 'none'}`));
    }
    return gates;
  },

  describe(snap: RouteSnap): ConvoMessage[] {
    // The judge keeps transcript lines at or before the freeze's asOf, so the
    // roster and request carry a clock before any capture (a snapshot has none).
    const now = DESCRIBE_CLOCK;
    return toConvoMessages([
      { role: 'user', content: rosterText(snap.roster), line: 1, timestamp: now - 60_000 },
      { role: 'user', content: `The request${snap.task ? ` (${snap.task.short_id})` : ''}:\n\n${snap.request}${snap.expected ? `\n\n(expected by the rule: @${snap.expected.handle}, by its ${snap.expected.by})` : ''}`, line: 2, timestamp: now },
    ]);
  },

  productionReply: () => null,
};

export default impl;

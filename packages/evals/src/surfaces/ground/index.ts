import type { ConvoMessage } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { COMMENTS_SHOWN, GROUND_AUTHOR, groundRequest, SIGNALS_SHOWN } from '../../../../convex/convex/lineGround';
import { parseJsonBlock } from '../../../../convex/convex/lib/anthropic';
import { briefGoalRefs, parseGroundReply, type GoalsBrief, type GroundCauseInput, type GroundFields } from '../../../../shared/contracts/goalsBrief';
import { castJson } from '../../adapters/cast';
import { toConvoMessages } from '../../adapters/convo';
import { gate, type Captured, type SurfaceImpl } from '../../surface';

// The line's ground step (the-line-end-to-end.md LE5) replayed as the server
// posts it: one cause, its signals and comments, and the goals brief of its
// project, through the same groundRequest. A real freeze is a cause as it
// stood when prod grounded it (the ground step's own comment marks the
// moment); a fixture is a synthetic cause. A label names what a person
// expects; the gates hold the parse and each labeled field.

export interface GroundSnap {
  cause: GroundCauseInput;
  brief: GoalsBrief;
  /** The clock the prompt's "Today" and its dates read. */
  now: number;
  approximate?: string[];
}

export interface GroundLabel {
  goal_ref?: string;
  category?: GroundFields['category'];
  readiness?: GroundFields['readiness'];
}

const REF_FORMS = `ground@ takes a fixture or a cause, like ground@fixture:<case> or ground@ct-57863 (the cause as prod grounded it: its signals and comments up to the ground step's note, and its goals brief)`;

export const groundRequestFor = (snap: GroundSnap) => groundRequest(snap.cause, snap.brief, snap.now);

/** The ground fields from a reply, read the way the server reads them. */
export const parseGround = (snap: GroundSnap, text: string) => parseGroundReply(parseJsonBlock(text), briefGoalRefs(snap.brief));

type Parsed = ReturnType<typeof parseGround>;

/** A cause as `cast task show`, `cast signal ls --task` and `cast goals --task` print it, cut at `now`: what lineGround.groundInput read then. */
export function groundSnapFrom(task: any, signals: any[], brief: any, now: number): GroundSnap {
  const { principles: _principles, ...goals } = brief ?? {};
  return {
    cause: {
      short_id: task.short_id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      created_at: task._creationTime ?? task.created_at,
      signal_count: task.cause?.signal_count,
      first_seen: task.cause?.first_seen,
      last_seen: task.cause?.last_seen,
      signals: signals
        .filter((s) => (s.created_at ?? s.observed_at) <= now)
        .sort((a, b) => (b.created_at ?? b.observed_at) - (a.created_at ?? a.observed_at))
        .slice(0, SIGNALS_SHOWN)
        .map((s) => ({ source: s.source, kind: s.kind, title: s.title, subject: s.subject, goal_hint: s.goal_hint, detail_md: s.detail_md, observed_at: s.observed_at })),
      comments: (task.comments ?? [])
        .filter((c: any) => c.created_at < now)
        .sort((a: any, b: any) => a.created_at - b.created_at)
        .slice(-COMMENTS_SHOWN)
        .map((c: any) => ({ author: c.author, text: c.text ?? '', created_at: c.created_at })),
    },
    brief: goals as GoalsBrief,
    now,
    approximate: ['the goals brief is as it reads at capture, not as it stood when the cause was grounded'],
  };
}

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref): Promise<Captured> {
    const id = ref.trim();
    if (!/^ct-\d+$/i.test(id)) throw new UsageError(REF_FORMS);
    const task = castJson(['task', 'show', id]);
    if (!task?.short_id) throw new UsageError(`no task ${id} readable here`);
    const grounded = (task.comments ?? []).filter((c: any) => c.author === GROUND_AUTHOR).sort((a: any, b: any) => a.created_at - b.created_at)[0];
    const now: number = grounded?.created_at ?? Date.now();
    const signals = castJson(['signal', 'ls', '--task', id, '-n', '200']);
    const snapshot = groundSnapFrom(task, Array.isArray(signals) ? signals : [], castJson(['goals', '--task', id]), now);
    const prod = task.readiness ? { goal_ref: task.goal_ref ?? null, category: task.category ?? null, risk: task.risk ?? null, readiness: task.readiness } : null;
    return {
      snapshot,
      subject: { kind: 'task', id: String(task._id), title: task.title },
      asOf: new Date(now).toISOString(),
      anchor: { kind: 'message', id: `task:${task.short_id}` },
      name: `ground ${task.short_id}`,
      meta: { task: task.short_id, workspace: task.workspace ?? null, grounded_by: grounded ? 'ground step' : null, prod },
    };
  },

  async replay(snap: GroundSnap, ctx) {
    const r = await ctx.call(groundRequestFor(snap));
    return { reply: r.text, parsed: parseGround(snap, r.text) };
  },

  gates(_snap: GroundSnap, out, label?: GroundLabel) {
    const parsed = out.parsed as Parsed | undefined;
    const fields = parsed && 'fields' in parsed ? parsed.fields : null;
    const gates = [gate('parse', !!fields, fields ? `${fields.goal_ref}, ${fields.category}, risk ${fields.risk}, ${fields.readiness}` : parsed && 'error' in parsed ? parsed.error : `nothing parsed from: ${out.reply.slice(0, 120)}`)];
    for (const key of ['goal_ref', 'category', 'readiness'] as const) {
      const want = label?.[key];
      if (want) gates.push(gate(`${key.replace('_', '-')}-match`, fields?.[key] === want, `expected ${want}, got ${fields?.[key] ?? 'nothing'}`));
    }
    return gates;
  },

  describe(snap: GroundSnap): ConvoMessage[] {
    return toConvoMessages([{ role: 'user', content: groundRequestFor(snap).prompt, line: 1, timestamp: snap.now }]);
  },

  productionReply: () => null,
};

export default impl;

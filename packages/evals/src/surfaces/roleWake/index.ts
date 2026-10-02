import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseScheduledTask, triggerRunFrame, type RoleCard, type WaitingSession } from '@codecast/shared/contracts';
import { parseStandingSection, standingLineStale } from '@codecast/shared/contracts/briefStanding';
import { UsageError } from '@platform/evals/cli';

import { cliFetchRead } from '../../../../cli/src/cliHttp';
import { defaultConfigDir, readAuthConfig } from '../../../../cli/src/config/readAuthConfig';
import { ROLE_NEEDS_INPUT_SPEC, roleRoutineFor } from '../../../../convex/convex/lib/orgRoutine';
import { apiConfig } from '../../adapters/convo';
import { gate, type Captured, type CaptureCtx, type SurfaceImpl } from '../../surface';
import { meta } from './meta';
import { standingGates, type StandingLabel } from './actions';
import { claudeModel, describeTurn, findSnapshot, servedDirFor, withHarnessNote, type SnapshotDir, type StandingWorld } from './world';

// role-wake: one firing of a role's trigger in its standing session. The role
// gets the frame the server builds for every trigger run (triggerRunFrame: the
// trigger's prompt inside <scheduled-task>, with the role's card, and the
// waiting session when one fired it), reads its world, and writes its brief.
//
// A real freeze replays the frame prod built at capture (agentTasks.injectFrame,
// the query the daemon delivers it through) against the reads `./evals
// snapshot` saved at the same moment, so it tests the agent and the model. A
// fixture renders the frame from the tree over synthetic facts, so it tests
// edits to the routine prompts and the frame builder too.

/** How far the frame (read at `freeze create`) may trail the served reads (read at `snapshot`). */
export const MAX_SKEW_MS = 60 * 60 * 1000;

const BRIEF_NOTE = 'Where you would save your brief with `cast brief edit -`, write the brief as it should stand at the end of this turn to `brief.md` in the current directory instead, in full, whether or not it changed.';

const HINT = '`./evals snapshot role-wake --trigger tr-N --team <team> --role <handle> --name <name>`, then freeze it within the hour';

/** A fixture's frame, from facts: the routine (or needs-input event) the tree's orgRoutine defines for this role. */
export interface RoleWakeFixture {
  trigger: string;
  routine: 'check' | 'needs-input';
  role: RoleCard;
  waiting?: WaitingSession;
  stashed?: boolean;
}

export interface RoleWakeSnap extends StandingWorld {
  /** A real freeze: the frame prod built. */
  frame?: string;
  trigger?: { short_id: string; title: string };
  fixture?: RoleWakeFixture;
}

/** The frame the agent gets: prod's for a real freeze, the tree's over the facts for a fixture. */
export function frameOf(snap: RoleWakeSnap): string {
  if (snap.frame) return snap.frame;
  const f = snap.fixture;
  if (!f) throw new Error('role-wake snapshot carries neither a frame nor fixture facts');
  const spec = f.routine === 'needs-input' ? ROLE_NEEDS_INPUT_SPEC : { ...roleRoutineFor(f.role), event: undefined };
  const task = { _id: `fixture-${f.trigger}`, short_id: f.trigger, title: spec.title, prompt: spec.prompt, role_id: `fixture-${f.role.handle}`, ...(spec.event ? { event_filter: { event_type: spec.event } } : {}) };
  return triggerRunFrame(task, { role: f.role, waiting: f.waiting ?? null, stashed: Boolean(f.stashed) });
}

/** What the agent gets, and what the judge reads it got: the frame, then the harness note. */
const briefingOf = (snap: RoleWakeSnap): string => withHarnessNote(frameOf(snap), snap, [BRIEF_NOTE]);

const briefOf = (out: { parsed?: unknown }): string | null => ((out.parsed as { brief?: string | null } | undefined)?.brief ?? null);

/** The live reads a capture makes, injectable so the capture is testable without a sign-in. */
export interface RoleWakeDeps {
  listTriggers(): Promise<Array<Record<string, any>>>;
  injectFrame(taskId: string): Promise<string | null>;
  readConversation: CaptureCtx['readConversation'];
  now(): number;
}

export async function captureRoleWake(ref: string, deps: RoleWakeDeps): Promise<Captured> {
  const world: SnapshotDir = findSnapshot('role-wake', 'trigger', ref, HINT);
  const short = world.values.trigger;
  if (!short) throw new UsageError(`${world.served} was captured without --trigger: ${HINT}`);
  const age = deps.now() - Date.parse(world.captured_at);
  if (age > MAX_SKEW_MS) throw new UsageError(`${world.served} was captured ${Math.round(age / 60000)} minutes ago, and the frame is read now: the two must share a moment, so snapshot again (${HINT})`);
  const trigger = (await deps.listTriggers()).find((t) => t.short_id === short);
  if (!trigger) throw new UsageError(`no trigger ${short} on this account`);
  const frame = await deps.injectFrame(String(trigger._id));
  if (!frame) throw new UsageError(`${short} has no frame: it is not yours, or it no longer exists`);
  const handle = parseScheduledTask(frame)?.role?.handle;
  if (!handle) throw new UsageError(`${short} is not a role's trigger: role-wake replays a role's wake`);
  const want = (world.values.role ?? '').replace(/^@/, '');
  if (want !== handle) throw new UsageError(`${world.served} was captured as @${want || '?'}, but ${short} wakes @${handle}: snapshot again with --role ${handle}`);
  const standing = trigger.originating_conversation_id ? String(trigger.originating_conversation_id) : null;
  const session = standing ? await deps.readConversation(standing, { from: 1, to: 1 }).catch(() => null) : null;
  const model = claudeModel(trigger.model) ?? claudeModel((session as { conversation?: { model?: string } } | null)?.conversation?.model);
  const snapshot: RoleWakeSnap = { captured_at: world.captured_at, served: world.served, frame, trigger: { short_id: short, title: String(trigger.title ?? '') } };
  return {
    snapshot,
    name: `role-wake ${short} @${handle}`,
    subject: { kind: 'session', id: standing ?? String(trigger._id), title: String(trigger.title ?? short) },
    asOf: world.captured_at,
    anchor: { kind: 'run', id: short },
    meta: { trigger_id: String(trigger._id), ...(standing ? { conversation_id: standing } : {}), workspace: world.values.team, ...(model ? { model } : {}) },
  };
}

/** A public query through the CLI's own token: the query checks the token owns what it reads. */
async function convexQuery<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const config = readAuthConfig(defaultConfigDir());
  if (!config?.auth_token || !config.convex_url) throw new Error('not signed in to codecast here: run `cast auth`, then retry');
  const r = await fetch(`${config.convex_url}/api/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, args: { ...args, api_token: config.auth_token }, format: 'json' }) });
  const body = (await r.json()) as { status?: string; value?: T; errorMessage?: string };
  if (body.status !== 'success') throw new Error(`${path}: ${body.errorMessage ?? `HTTP ${r.status}`}`);
  return body.value as T;
}

const liveDeps = (ctx: CaptureCtx): RoleWakeDeps => ({
  async listTriggers() {
    const { siteUrl, apiToken } = apiConfig();
    const r = await cliFetchRead(`${siteUrl}/cli/tasks/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_token: apiToken }) });
    const rows = (await r.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error(`cli/tasks/list: ${(rows as { error?: string })?.error ?? 'unexpected answer'}`);
    return rows;
  },
  injectFrame: (taskId) => convexQuery<string | null>('agentTasks:injectFrame', { task_id: taskId }),
  readConversation: ctx.readConversation,
  now: Date.now,
});

const impl: SurfaceImpl = {
  refForms: 'role-wake@ needs a trigger whose world was captured within the hour (./evals snapshot role-wake --trigger tr-N --team T --role <handle> --name n), like role-wake@tr-42',

  capture: (ref, ctx) => captureRoleWake(ref, liveDeps(ctx)),

  async replay(snap: RoleWakeSnap, ctx) {
    const serveDir = servedDirFor(snap, ctx, meta);
    const a = await ctx.agent({ prompt: briefingOf(snap), serveDir, model: ctx.model, maxTurns: 80 });
    const written = join(a.runSubdir, 'brief.md');
    const brief = existsSync(written) ? readFileSync(written, 'utf8') : null;
    if (brief !== null) writeFileSync(join(ctx.runDir, 'brief.md'), brief);
    return { reply: a.said.join('\n\n'), parsed: { brief } };
  },

  gates(snap: RoleWakeSnap, out, label?: StandingLabel) {
    const brief = briefOf(out);
    const scope = parseScheduledTask(frameOf(snap))?.role?.scope ?? [];
    const lines = parseStandingSection(brief);
    const now = Date.parse(snap.captured_at);
    const stale = lines.filter((l) => standingLineStale(l, now));
    const parses =
      brief === null
        ? gate('brief-parses', false, 'the run wrote no brief.md')
        : scope.length && !lines.length
          ? gate('brief-parses', false, `brief.md has no line under "## Where it stands" that parses, for a role that looks after ${scope.join(', ')}`)
          : gate('brief-parses', true, `${lines.length} standing line(s) parse`);
    return [
      parses,
      gate('no-stale-lines', stale.length === 0, stale.length ? `older than a week at the wake: ${stale.map((l) => l.raw).join(' | ')}` : 'no standing line is older than a week at the wake'),
      ...standingGates(out.agents, label, 1, brief === null ? [] : [brief]),
    ];
  },

  describe: (snap: RoleWakeSnap) => describeTurn(briefingOf(snap), snap.captured_at, 'wake'),

  productionReply: () => null,
};

export default impl;

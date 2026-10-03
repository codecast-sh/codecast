import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { ConvoMessage } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { readFrozenVerbs } from '../../served';
import type { ReplayResult, SurfaceImpl } from '../../surface';
import { buildBriefing, type OrgHashes, type OrgMode } from './build';
import { freezeContext, gradeDir, gradeExisting, handlePool, loadGradeSets, snapshotsRoot, snapshotWorkspace, tryJson, wrongClosesOf, type GradeSets, type OrgGrade } from './grade';

// org-review: the Head of People's analyzer run as an agent against a saved
// workspace (a served dir under EVALS_HOME/snapshots/org-review). A replay
// builds the briefing from the working tree, lets the agent write its
// proposals to <run>/proposals, then grades the run with grade.py's sets and
// bands against the workspace's hand labels. Presentation is attended only.

const REF_FORMS = 'org-review@ needs a snapshot name under EVALS_HOME/snapshots/org-review, like org-review@union-base8';

interface OrgExtra {
  runDir: string;
  workspace: string;
  servedDir: string;
  hashes: OrgHashes;
}

// gates() and checks() see the same result; grade it once.
const graded = new WeakMap<object, OrgGrade>();
function gradeOf(out: ReplayResult, label?: GradeSets): OrgGrade {
  const x = out.extra as unknown as OrgExtra;
  const hit = graded.get(x);
  if (hit) return hit;
  const g = gradeDir(x.runDir, { workspace: x.workspace, servedDir: x.servedDir, sets: label ?? loadGradeSets(x.workspace), pool: handlePool(x.workspace) });
  graded.set(x, g);
  return g;
}

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    const dir = join(snapshotsRoot(), ref);
    if (!existsSync(join(dir, 'org-inputs.json'))) {
      const have = existsSync(snapshotsRoot()) ? readdirSync(snapshotsRoot()).filter((n) => statSync(join(snapshotsRoot(), n)).isDirectory()) : [];
      throw new UsageError(`no org-review snapshot ${ref} here (have: ${have.join(', ') || 'none'}). ${REF_FORMS}; ./evals snapshot org-review --team <T> --name <ws>-<name> captures one`);
    }
    const workspace = snapshotWorkspace(dir);
    if (!workspace) throw new UsageError(`snapshot ${ref} names no workspace: its captured.json has no workspace and its inputs no workspace.name`);
    const asOf = String(tryJson(join(dir, 'captured.json'))?.captured_at ?? statSync(join(dir, 'org-inputs.json')).mtime.toISOString());
    return {
      snapshotRef: `org-review/${ref}`,
      subject: { id: ref, kind: 'org-snapshot', title: `org-review ${ref}` },
      asOf,
      anchor: { kind: 'run', id: ref },
      name: `org-review ${ref}`,
      meta: { workspace, mode: 'review' },
    };
  },

  async replay(_snap, ctx) {
    const servedDir = ctx.snapshotDir;
    if (!servedDir) throw new Error('org-review replays a served dir; this freeze has none');
    const { workspace } = freezeContext(ctx.freeze);
    const mode = ((ctx.freeze.meta as { mode?: OrgMode } | undefined)?.mode ?? 'review') as OrgMode;
    const b = buildBriefing({ inputsText: readFileSync(join(servedDir, 'org-inputs.json'), 'utf8'), workspace, served: basename(servedDir), proposalsDir: join(ctx.runDir, 'proposals'), frozen: readFrozenVerbs(servedDir), mode });
    mkdirSync(ctx.runDir, { recursive: true });
    writeFileSync(join(ctx.runDir, 'hashes.json'), JSON.stringify(b.hashes, null, 1));
    const a = await ctx.agent({ prompt: b.briefing, model: ctx.model, maxTurns: 200 });
    const extra: OrgExtra = { runDir: ctx.runDir, workspace, servedDir, hashes: b.hashes };
    return { reply: a.said.at(-1) ?? '', promptSha: b.hashes.promptSha, extra: extra as unknown as Record<string, unknown> };
  },

  // frozen-reads and no-unexpected-writes are route gates; these are the surface's own.
  gates: (_snap, out, label) => gradeOf(out, label).gates,
  checks: (_snap, out, label) => gradeOf(out, label).checks,

  /** Which must-stay-open records the set's reps closed, and in how many reps: the plan's ct-49328 gate reads here. */
  summarize(scores) {
    const closed = new Map<string, number>();
    for (const s of scores) for (const id of new Set(wrongClosesOf(s))) closed.set(id, (closed.get(id) ?? 0) + 1);
    const held = scores.filter((s) => !wrongClosesOf(s).length).length;
    const list = [...closed].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, n]) => `${id} in ${n}`);
    return [`no-wrong-close held in ${held}/${scores.length} graded reps${list.length ? `; closed ${list.join(', ')}` : ''}`];
  },

  describe(snap: { captured_at?: string; argv?: string[][]; workspace?: string }): ConvoMessage[] {
    const reads = (snap?.argv ?? []).map((a) => `cast ${a.join(' ')}`).join('; ');
    return [{ n: 1, id: 'org-snapshot', at: snap?.captured_at ?? new Date(0).toISOString(), channel: 'session', isGroup: false, direction: 'in', from: 'workspace', text: `The ${snap?.workspace ?? ''} workspace as saved${reads ? `: ${reads}` : ''}. The analyzer reviews it and proposes changes to the org.` }];
  },

  productionReply: () => null,

  grade: (dir, label, freeze) => gradeExisting(dir, label, freeze),

  async capturePresentation(runDir) {
    await (await import('./present')).capturePresentation(runDir);
  },
};

export default impl;

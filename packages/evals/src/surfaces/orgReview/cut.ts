import type { SnapshotCut } from '../../surface';

// The org-review world at its capture (SurfaceMeta.cut): the records the
// analyzer drills into are captured beside the org reads, and the
// repositories it reads history from are pinned.

const RECORD = /^(?:ct|pl)-\d+$|^jx[a-z0-9]{5}$/;

/** The org inputs a capture read, parsed; null when the capture has none. */
function inputsOf(captured: Array<{ argv: string[]; out: string }>): any {
  const hit = captured.find((c) => c.argv[0] === 'org' && c.argv[1] === 'inputs');
  try {
    return hit ? JSON.parse(hit.out) : null;
  } catch {
    return null;
  }
}

/** Every task, plan and session id under the parts of the inputs the analyzer judges: activity, coverage, the org and the long running sessions. */
export function recordIds(inputs: any): string[] {
  const ids = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (RECORD.test(v)) ids.add(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk([inputs?.activity, inputs?.coverage, inputs?.org, inputs?.sessions?.long_running]);
  return [...ids].sort();
}

export const orgCut: SnapshotCut = {
  follow(captured) {
    return recordIds(inputsOf(captured)).flatMap((id) => {
      if (id.startsWith('jx')) return [{ argv: ['read', id], prefix: true }];
      const verb = id.startsWith('pl-') ? 'plan' : 'task';
      return [{ argv: [verb, 'show', id, '--json'] }, { argv: [verb, 'show', id], prefix: true }];
    });
  },
  gitRoots(captured) {
    const roots: unknown[] = inputsOf(captured)?.git_roots ?? [];
    return [...new Set(roots.map((r: any) => r?.git_root).filter((r): r is string => typeof r === 'string' && r.startsWith('/')))];
  },
};

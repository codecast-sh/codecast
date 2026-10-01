import type { SurfaceImpl, SurfaceMeta } from './surface';
import { surfaceDir } from './surface';
import { echoMeta } from './testSurface';
import { meta as anchorBrief } from './surfaces/anchorBrief/meta';
import { meta as ask } from './surfaces/ask/meta';
import { meta as callSummary } from './surfaces/callSummary/meta';
import { meta as handoff } from './surfaces/handoff/meta';
import { meta as insight } from './surfaces/insight/meta';
import { meta as orgReview } from './surfaces/orgReview/meta';
import { meta as roleWake } from './surfaces/roleWake/meta';
import { meta as settle } from './surfaces/settle/meta';
import { meta as suggest } from './surfaces/suggest/meta';
import { meta as title } from './surfaces/title/meta';

// Every surface's meta, statically: light, so `stale` and `status` answer
// without loading a single implementation. Implementations load on demand.

const PHASE1: SurfaceMeta[] = [settle, title, insight, callSummary, ask, handoff, suggest, orgReview, roleWake, anchorBrief];

/** The test surface joins only when a test asks for it. */
export const testMode = (): boolean => process.env.CODECAST_EVALS_TEST === '1';

export function surfaces(): SurfaceMeta[] {
  return testMode() ? [...PHASE1, echoMeta] : PHASE1;
}

export function surfaceMeta(id: string): SurfaceMeta | null {
  return surfaces().find((s) => s.id === id) ?? null;
}

const loaded = new Map<string, SurfaceImpl>();

export async function loadSurface(id: string): Promise<SurfaceImpl> {
  const hit = loaded.get(id);
  if (hit) return hit;
  if (!surfaceMeta(id)) throw new Error(`no surface ${id}`);
  const impl = id === 'echo' ? (await import('./testSurface')).echoImpl : ((await import(`./surfaces/${surfaceDir(id)}/index.ts`)) as { default: SurfaceImpl }).default;
  loaded.set(id, impl);
  return impl;
}

/** The one line every bad ref answers with: each surface's ref forms. */
export async function refFormsLine(): Promise<string> {
  const forms = await Promise.all(surfaces().map(async (s) => (await loadSurface(s.id)).refForms));
  return `${forms.join('; ')}; every surface also takes <surface>@fixture:<case>`;
}

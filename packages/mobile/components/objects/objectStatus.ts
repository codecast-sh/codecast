// How a project's and a goal's status read on the phone: the word and colour
// of web's own tables (lib/projectStatus, lib/initiativeColors), whose glyphs
// components/marks draws. And the sessions a project or goal holds, as rows
// the session list draws.
import type { Palette } from '@/constants/Theme';
import type { SessionData } from '@/components/SessionItem';
import type { OrgSession } from '@codecast/web/components/org/orgTypes';
import { webColor } from '@/lib/solColor';
import { projectStatusOf } from '@codecast/web/lib/projectStatus';
import { HEALTH_COLOR, INITIATIVE_STATUS_VISUAL } from '@codecast/web/lib/initiativeColors';
import { INITIATIVE_HEALTH_LABEL, INITIATIVE_STATUS_LABEL, type InitiativeHealth, type InitiativeStatus } from '@codecast/shared/contracts/initiative';

type Visual = { label: string; color: string };

export { PROJECT_STATUS_ORDER } from '@codecast/web/lib/projectStatus';

/** Drawn by ProjectStatusMark. A status nobody wrote down reads as active, as on the web. */
export function projectStatusVisual(status: string | undefined, t: Palette): Visual {
  const v = projectStatusOf(status);
  return { label: v.label, color: webColor(v.color, t) };
}

/** Drawn by GoalStatusMark. */
export function goalStatusVisual(status: InitiativeStatus, t: Palette): Visual {
  const v = INITIATIVE_STATUS_VISUAL[status] ?? INITIATIVE_STATUS_VISUAL.active;
  return { label: INITIATIVE_STATUS_LABEL[status] ?? status, color: webColor(v.color, t) };
}

/** Drawn by HealthDot. */
export function healthVisual(health: InitiativeHealth, t: Palette): Visual {
  return { label: INITIATIVE_HEALTH_LABEL[health], color: webColor(HEALTH_COLOR[health], t) };
}

/** The sessions of some projects: the store's rows tagged with one of them,
 *  and the org tree's sessions under a role whose area holds one. A store row
 *  wins over the tree's thinner copy of the same session. */
export function sessionRowsFor(storeSessions: Record<string, any>, projectIds: readonly string[], orgSessions: readonly OrgSession[]): SessionData[] {
  const ids = new Set(projectIds);
  const out = new Map<string, SessionData>();
  for (const s of Object.values(storeSessions)) {
    if (s?.project_id && ids.has(String(s.project_id))) out.set(String(s._id), s as SessionData);
  }
  for (const o of orgSessions) {
    if (out.has(o._id)) continue;
    const stored = storeSessions[o._id];
    out.set(o._id, stored ?? {
      _id: o._id,
      title: o.title,
      updated_at: o.updated_at,
      agent_type: o.agent_type,
      project_path: o.project_path,
      message_count: 0,
      is_idle: o.state !== 'working',
    });
  }
  return [...out.values()];
}

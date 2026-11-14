// How a project's and a goal's status read on the phone (the web keeps the
// same words and colours in lib/projectStatus and InitiativeAtoms), and the
// sessions a project or goal holds, as rows the session list draws.
import type FontAwesome from '@expo/vector-icons/FontAwesome';
import type { Palette } from '@/constants/Theme';
import type { SessionData } from '@/components/SessionItem';
import type { OrgSession } from '@codecast/web/components/org/orgTypes';
import { INITIATIVE_HEALTH_LABEL, INITIATIVE_STATUS_LABEL, type InitiativeHealth, type InitiativeStatus } from '@codecast/shared/contracts/initiative';

type IconName = React.ComponentProps<typeof FontAwesome>['name'];
type Visual = { icon: IconName; label: string; color: string };

export const PROJECT_STATUS_ORDER = ['active', 'planning', 'paused', 'done'] as const;

export function projectStatusVisual(status: string | undefined, t: Palette): Visual {
  switch (status) {
    case 'planning': return { icon: 'circle-o', label: 'Planning', color: t.violet };
    case 'paused': return { icon: 'pause-circle-o', label: 'Paused', color: t.yellow };
    case 'done': return { icon: 'check-circle', label: 'Done', color: t.green };
    // A status nobody wrote down reads as active, as on the web.
    default: return { icon: 'dot-circle-o', label: 'Active', color: t.cyan };
  }
}

export function goalStatusVisual(status: InitiativeStatus, t: Palette): Visual {
  const label = INITIATIVE_STATUS_LABEL[status] ?? status;
  switch (status) {
    case 'proposed': return { icon: 'circle-thin', label, color: t.textDim };
    case 'planned': return { icon: 'circle-o', label, color: t.textMuted };
    case 'completed': return { icon: 'check-circle', label, color: t.textMuted };
    case 'cancelled': return { icon: 'times-circle-o', label, color: t.textDim };
    default: return { icon: 'dot-circle-o', label, color: t.magenta };
  }
}

export function healthVisual(health: InitiativeHealth, t: Palette): Visual {
  const label = INITIATIVE_HEALTH_LABEL[health];
  switch (health) {
    case 'on_track': return { icon: 'circle', label, color: t.green };
    case 'at_risk': return { icon: 'exclamation-circle', label, color: t.yellow };
    case 'off_track': return { icon: 'times-circle', label, color: t.red };
    default: return { icon: 'circle-thin', label, color: t.textDim };
  }
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

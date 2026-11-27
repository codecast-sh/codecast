// The phone's marks for every state and kind web draws one for. Each reads
// web's own vocabulary table (the glyph, the word, the colour) and draws the
// glyph natively (WebGlyph), so the phone and web show one icon per meaning.
import { View as RNView } from 'react-native';
import { Theme, useTheme } from '@/constants/Theme';
import { webColor } from '@/lib/solColor';
import { svgNodes } from '@/lib/webSvg';
import { SvgGlyph, WebIcon } from './WebGlyph';
import { SESSION_STATUS, type SessionStatus } from '@codecast/web/lib/sessionStatus';
import { STATUS_MARK_SHAPES } from '@codecast/web/components/inbox/SessionStatusMark';
import { taskVisual } from '@codecast/web/components/TaskStatusBadge';
import { taskPriority } from '@codecast/web/lib/taskPriority';
import { PLAN_STATUS_CONFIG } from '@codecast/web/lib/planStatus';
import { projectStatusOf } from '@codecast/web/lib/projectStatus';
import { HEALTH_COLOR, INITIATIVE_STATUS_VISUAL } from '@codecast/web/lib/initiativeColors';
import { ACCENT, TYPE_ICON } from '@codecast/web/lib/entityCardAccent';
import type { InitiativeHealth, InitiativeStatus } from '@codecast/shared/contracts/initiative';
import type { EntityType } from '@codecast/shared/entities';

export { WebIcon } from './WebGlyph';

/** A plan's status as web names it; an unknown one reads as draft. */
export const planStatusOf = (status: string | null | undefined) => PLAN_STATUS_CONFIG[status ?? ''] ?? PLAN_STATUS_CONFIG.draft;

/** A web colour (a class or a CSS value) in the live theme. */
export function useWebColor(value: string): string {
  return webColor(value, useTheme());
}

/** Web's vocabulary table as the phone's lists and menus read it: each
 *  entry's word, and its colour in the live theme. The glyph is a mark here. */
export function webLook<K extends string>(table: Record<K, { label: string; color: string }>): Record<K, { label: string; color: string }> {
  return Object.fromEntries(Object.entries<{ label: string; color: string }>(table).map(([k, v]) => [k, { label: v.label, get color() { return webColor(v.color, Theme); } }])) as Record<K, { label: string; color: string }>;
}

const SESSION_SHAPES = Object.fromEntries(Object.entries(STATUS_MARK_SHAPES).map(([mark, shape]) => [mark, svgNodes(shape)]));

/** A session's state: web's shape in web's colour (lib/sessionStatus). */
export function SessionStatusMark({ status, size = 10 }: { status: SessionStatus; size?: number }) {
  const meta = SESSION_STATUS[status];
  return <SvgGlyph viewBox="0 0 10 10" nodes={SESSION_SHAPES[meta.mark]} color={useWebColor(meta.color)} size={size} testID={`status-mark-${status}`} />;
}

/** A task's status disc (web StatusCircle, TASK_STATUS); an unknown status reads as open. */
export function TaskStatusMark({ status, size = 14, color }: { status: string | null | undefined; size?: number; color?: string }) {
  const v = taskVisual(status);
  const own = useWebColor(v.color);
  return <WebIcon icon={v.icon} color={color ?? own} size={size} testID={`task-status-${status ?? 'open'}`} />;
}

/** A task's priority glyph (web TASK_PRIORITY); an unset one reads as medium, as web's rows do. */
export function PriorityMark({ priority, size = 12 }: { priority: string | null | undefined; size?: number }) {
  const v = taskPriority(priority);
  return <WebIcon icon={v.icon} color={useWebColor(v.color)} size={size} />;
}

export function PlanStatusMark({ status, size = 14 }: { status: string | null | undefined; size?: number }) {
  const v = planStatusOf(status);
  return <WebIcon icon={v.icon} color={useWebColor(v.color)} size={size} />;
}

export function ProjectStatusMark({ status, size = 12 }: { status: string | null | undefined; size?: number }) {
  const v = projectStatusOf(status);
  return <WebIcon icon={v.icon} color={useWebColor(v.color)} size={size} />;
}

export function GoalStatusMark({ status, size = 12 }: { status: InitiativeStatus; size?: number }) {
  const v = INITIATIVE_STATUS_VISUAL[status] ?? INITIATIVE_STATUS_VISUAL.active;
  return <WebIcon icon={v.icon} color={useWebColor(v.color)} size={size} />;
}

/** A goal's health: web's dot, a ring when nobody has said. */
export function HealthDot({ health, size = 7 }: { health: InitiativeHealth; size?: number }) {
  const color = useWebColor(HEALTH_COLOR[health]);
  return <RNView style={{ width: size, height: size, borderRadius: size / 2, ...(health === 'none' ? { borderWidth: 1, borderColor: color } : { backgroundColor: color }) }} />;
}

/** A kind's glyph in its accent (web TYPE_ICON and ACCENT); `color` overrides the accent. */
export function EntityKindIcon({ type, size = 12, color }: { type: EntityType; size?: number; color?: string }) {
  const accent = useWebColor(ACCENT[type].text);
  return <WebIcon icon={TYPE_ICON[type]} color={color ?? accent} size={size} />;
}

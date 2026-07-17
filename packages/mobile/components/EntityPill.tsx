import React from 'react';
import { Text as RNText, StyleSheet } from 'react-native';
import { useQuery } from 'convex/react';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Theme } from '@/constants/Theme';
import { isConvexId, type EntityType } from '@codecast/shared/entities';

const api = _api as any;

// Same detection as web's EntityIdPill (packages/web/components/EntityIdPill.tsx).
// The bare 32-char alternative catches full Convex ids (docs have no short id);
// EntityPill resolves their table server-side.
const ENTITY_ID_RE = /^(?:(?:ct|pl)-[a-z0-9]+|jx[a-z0-9]{5,}|[a-z0-9]{32})$/i;

export function isEntityId(text: string): boolean {
  return ENTITY_ID_RE.test(text.trim());
}

function detectEntityType(id: string): EntityType | null {
  const lower = id.toLowerCase();
  if (lower.startsWith('ct-')) return 'task';
  if (lower.startsWith('pl-')) return 'plan';
  if (/^jx[a-z0-9]/i.test(id)) return 'session';
  return null;
}

const TYPE_LABEL: Record<EntityType, string> = {
  task: 'Task',
  plan: 'Plan',
  session: 'Session',
  doc: 'Doc',
  project: 'Project',
};

// Web pill palette: session=blue, plan=cyan, task=yellow, doc=green, project=violet.
const TYPE_COLOR: Record<EntityType, string> = {
  session: Theme.blue,
  plan: Theme.cyan,
  task: '#b58900',
  doc: Theme.green,
  project: Theme.violet,
};

const TYPE_ICON: Record<EntityType, React.ComponentProps<typeof Feather>['name']> = {
  session: 'message-square',
  plan: 'target',
  task: 'circle',
  doc: 'file-text',
  project: 'folder',
};

/**
 * Pick the right `webGet` argument for an id: a full Convex id resolves by
 * `{ id }`, a short id by `{ short_id }`. Sessions store a 7-char short id.
 * (Mirror of web EntityIdPill.entityQueryArgs.)
 */
function entityQueryArgs(type: EntityType, id: string): { short_id?: string; id?: string } {
  if (isConvexId(id)) return { id };
  if (type === 'session') return { short_id: id.slice(0, 7).toLowerCase() };
  if (type === 'task' || type === 'plan') return { short_id: id.toLowerCase() };
  return { id };
}

/**
 * Mobile twin of web's EntityIdPill: an object reference (jx… session, ct- task,
 * pl- plan, doc convex id) rendered as a colored, tappable pill. Sessions and
 * docs resolve their title server-side so the pill reads as the object's name,
 * not a bare id. Text-based so it sits inline in markdown prose as well as in
 * header rows. Tap navigates to the object's screen.
 */
export function EntityPill({ shortId, type: typeProp, id: idProp, fallback }: { shortId?: string; type?: EntityType; id?: string; fallback?: React.ReactNode }) {
  const router = useRouter();
  const rawId = (idProp ?? shortId ?? '').trim();
  const looksConvex = isConvexId(rawId);
  // A full Convex id carries no type prefix (docs have no short id at all), so
  // resolve its table server-side; prefix detection is for short ids only.
  const resolvedType = useQuery(api.entities.resolveIdType, !typeProp && looksConvex ? { id: rawId } : 'skip');
  const type: EntityType | null = typeProp ?? (looksConvex ? resolvedType ?? null : detectEntityType(rawId));
  const isSession = type === 'session';

  // Sessions and docs need the resolved row for their title (and the session's
  // Convex _id — the mobile route can't resolve short ids). Compact ct-/pl-
  // pills show the id itself, so tasks/plans only resolve when addressed by a
  // full Convex id (e.g. a pasted URL) and the id would make a terrible label.
  const queryArgs = type ? entityQueryArgs(type, rawId) : null;
  const needsResolve = isSession || type === 'doc' || looksConvex;
  const task = useQuery(api.tasks.webGet, type === 'task' && needsResolve && queryArgs ? queryArgs : 'skip');
  const plan = useQuery(api.plans.webGet, type === 'plan' && needsResolve && queryArgs ? queryArgs : 'skip');
  const session = useQuery(api.conversations.webGet, isSession && queryArgs ? queryArgs : 'skip');
  const doc = useQuery(api.docs.webGet, type === 'doc' && looksConvex ? { id: rawId } : 'skip');

  const entity: any = type === 'task' ? task : type === 'plan' ? plan : isSession ? session : type === 'doc' ? doc : undefined;

  // Unknown id shape, a Convex id resolving to no entity table, or the
  // transient state while resolveIdType is in flight.
  if (!type) return fallback !== undefined ? <>{fallback}</> : <RNText>{rawId}</RNText>;

  const color = TYPE_COLOR[type];

  // Label rules, same as web: convex ids never show raw; sessions show their
  // title once resolved; ct-/pl- short ids stay compact.
  const resolvedTitle: string | undefined = entity?.title || entity?.display_title || entity?.name;
  const truncated = resolvedTitle && resolvedTitle.length > 30 ? resolvedTitle.slice(0, 30) + '…' : resolvedTitle;
  const label = looksConvex
    ? truncated || entity?.short_id || TYPE_LABEL[type]
    : isSession
      ? truncated || rawId
      : rawId;

  const targetId = isSession || type === 'doc'
    ? entity?._id ?? (looksConvex ? rawId : null)
    : entity?.short_id ?? rawId;
  const route = !targetId ? null
    : type === 'session' ? `/session/${targetId}`
    : type === 'task' ? `/task/${targetId}`
    : type === 'plan' ? `/plan/${targetId}`
    : type === 'doc' ? `/doc/${targetId}`
    : null;

  return (
    <RNText
      style={[styles.pill, { backgroundColor: color + '1a', color }]}
      onPress={route ? () => router.push(route as any) : undefined}
      suppressHighlighting
    >
      <Feather name={TYPE_ICON[type]} size={10} color={color} />
      {isSession && entity?.status === 'active' && <RNText style={{ color: Theme.greenBright, fontSize: 8 }}>{' '}●</RNText>}
      {/* NBSP so the icon never strands on the previous line when the pill wraps */}
      {' '}{label}
    </RNText>
  );
}

const styles = StyleSheet.create({
  pill: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
});

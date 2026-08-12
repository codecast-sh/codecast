import React from 'react';
import { StyleSheet } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useQuery } from 'convex/react';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Theme } from '@/constants/Theme';
import { isConvexId, isEntityId, entityTypeFromId, entityReferenceLabel, type EntityType } from '@codecast/shared/entities';

const api = _api as any;

// Detection comes from the shared mention vocabulary, the same tables web reads
// (packages/shared/entities). Mobile used to keep its own copy of the id regex
// and prefix table; they drifted — triggers ("tr-…") were added to the
// vocabulary and mobile silently kept rendering them as plain text.
export { isEntityId };

const TYPE_LABEL: Record<EntityType, string> = {
  task: 'Task',
  plan: 'Plan',
  session: 'Session',
  doc: 'Doc',
  project: 'Project',
  trigger: 'Trigger',
};

// Web pill palette: session=blue, plan=cyan, task=yellow, doc=green,
// project=violet, trigger=orange.
const TYPE_COLOR: Record<EntityType, string> = {
  session: Theme.blue,
  plan: Theme.cyan,
  task: '#b58900',
  doc: Theme.green,
  project: Theme.violet,
  trigger: Theme.orange,
};

const TYPE_ICON: Record<EntityType, React.ComponentProps<typeof Feather>['name']> = {
  session: 'message-square',
  plan: 'target',
  task: 'circle',
  doc: 'file-text',
  project: 'folder',
  trigger: 'zap',
};

/**
 * Pick the right `webGet` argument for an id: a full Convex id resolves by
 * `{ id }`, a short id by `{ short_id }`. Sessions store a 7-char short id.
 * (Mirror of web EntityIdPill.entityQueryArgs.)
 */
function entityQueryArgs(type: EntityType, id: string): { short_id?: string; id?: string } {
  if (isConvexId(id)) return { id };
  if (type === 'session') return { short_id: id.slice(0, 7).toLowerCase() };
  if (type === 'task' || type === 'plan' || type === 'trigger') return { short_id: id.toLowerCase() };
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
  const type: EntityType | null = typeProp ?? (looksConvex ? resolvedType ?? null : entityTypeFromId(rawId));
  const isSession = type === 'session';

  // Every type resolves its row: the pill reads as the object's title, so the
  // title is what we came for (the session/doc branches also need the Convex
  // _id — mobile routes can't resolve short ids).
  const queryArgs = type ? entityQueryArgs(type, rawId) : null;
  const task = useQuery(api.tasks.webGet, type === 'task' && queryArgs ? queryArgs : 'skip');
  const plan = useQuery(api.plans.webGet, type === 'plan' && queryArgs ? queryArgs : 'skip');
  const session = useQuery(api.conversations.webGet, isSession && queryArgs ? queryArgs : 'skip');
  const trigger = useQuery(api.agentTasks.webGet, type === 'trigger' && queryArgs ? queryArgs : 'skip');
  const doc = useQuery(api.docs.webGet, type === 'doc' && looksConvex ? { id: rawId } : 'skip');

  const entity: any = type === 'task' ? task : type === 'plan' ? plan : isSession ? session : type === 'trigger' ? trigger : type === 'doc' ? doc : undefined;

  // Unknown id shape, a Convex id resolving to no entity table, or the
  // transient state while resolveIdType is in flight.
  if (!type) return fallback !== undefined ? <>{fallback}</> : <RNText>{rawId}</RNText>;

  const color = TYPE_COLOR[type];

  // One label rule for every type, shared with web: the pill reads as the
  // object's NAME.
  const resolvedTitle: string | undefined =
    (type === 'trigger' ? entity?.display_title : undefined) || entity?.title || entity?.display_title || entity?.name;
  const label = entityReferenceLabel({
    title: resolvedTitle,
    shortId: entity?.short_id,
    rawId,
    typeLabel: TYPE_LABEL[type],
  });

  const targetId = isSession || type === 'doc'
    ? entity?._id ?? (looksConvex ? rawId : null)
    : entity?.short_id ?? rawId;
  // No trigger screen on mobile yet — that pill still names the trigger and
  // reads inline, it just isn't tappable.
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

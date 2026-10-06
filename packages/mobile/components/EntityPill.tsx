import React from 'react';
import { StyleSheet } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { findEntityInStore, entityTypeInStore } from '@codecast/web/lib/liveEntities';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Theme, useTheme } from '@/constants/Theme';
import { isConvexId, isEntityId, entityTypeFromId, entityReferenceLabel, parseCallRef, callRefLabelSuffix, parseProposalChangeRef, proposalChangeLabelSuffix, type EntityType } from '@codecast/shared/entities';
import { mobileEntityRoute } from '@/lib/linkRoutes';
import { identityLine, identityRowOf } from '@codecast/web/lib/sessionIdentity';
import { usePersonifyAll } from '@codecast/web/hooks/usePersonifyAll';
import { MobileIdentityFace } from '@/components/identity';

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
  initiative: 'Initiative',
  proposal: 'Proposal',
  trigger: 'Trigger',
  decision: 'Decision',
  pr: 'Pull request',
  commit: 'Commit',
  call: 'Call',
  source: 'Source',
};

// Web pill palette: session=blue, plan=cyan, task=violet, doc=green,
// project=neutral, trigger=orange. (Magenta is reserved for chat.)
const TYPE_COLOR: Record<EntityType, string> = {
  session: Theme.blue,
  plan: Theme.cyan,
  task: Theme.violet,
  doc: Theme.green,
  project: Theme.textMuted,
  initiative: Theme.textMuted,
  proposal: Theme.violet,
  trigger: Theme.orange,
  decision: Theme.yellow,
  pr: Theme.green,
  commit: Theme.yellow,
  call: Theme.red,
  source: Theme.orange,
};

const TYPE_ICON: Record<EntityType, React.ComponentProps<typeof Feather>['name']> = {
  session: 'message-square',
  plan: 'target',
  task: 'circle',
  doc: 'file-text',
  project: 'folder',
  initiative: 'flag',
  proposal: 'share-2',
  trigger: 'zap',
  decision: 'help-circle',
  pr: 'git-pull-request',
  commit: 'git-commit',
  call: 'phone',
  source: 'radio',
};

// Mobile stand-in for web's StatusCircle glyphs: the circle "fills in" as the
// task progresses (disc = started, check/x = finished), tinted with the same
// status colors the web board uses.
const TASK_STATUS_ICON: Record<string, { icon: React.ComponentProps<typeof Feather>['name']; color: string }> = {
  backlog: { icon: 'circle', color: Theme.textDim },
  open: { icon: 'circle', color: Theme.blue },
  in_progress: { icon: 'disc', color: Theme.accent },
  in_review: { icon: 'disc', color: Theme.violet },
  done: { icon: 'check-circle', color: Theme.green },
  dropped: { icon: 'x-circle', color: Theme.textDim },
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
  const Theme = useTheme();
  const router = useRouter();
  const rawId = (idProp ?? shortId ?? '').trim();
  const looksConvex = isConvexId(rawId);
  // A full Convex id carries no type prefix (docs have no short id at all), so
  // resolve its table server-side; prefix detection is for short ids only.
  // The store usually holds the row already, which names the type on the first
  // frame; the server resolves only ids this phone has never seen.
  const storeType = React.useMemo(
    () => (!typeProp && looksConvex ? entityTypeInStore(useInboxStore.getState(), rawId) : undefined),
    [typeProp, looksConvex, rawId],
  );
  const resolvedType = useQueryNoThrow(api.entities.resolveIdType, !typeProp && looksConvex && !storeType ? { id: rawId } : 'skip').data;
  const type: EntityType | null = typeProp ?? (looksConvex ? storeType ?? resolvedType ?? null : entityTypeFromId(rawId));
  const isSession = type === 'session';
  const personifyAll = usePersonifyAll();

  // The pill reads as the object's title (the session/doc branches also need
  // the Convex _id, since mobile routes can't resolve short ids). Local-first,
  // same rule as web: the client usually already holds this row, so the title
  // paints on the FIRST frame. Read once and non-reactively (getState,
  // not a subscription): a pill must not re-render on the churn of a collection
  // with thousands of rows. A row the store already names needs no server read;
  // only an id this phone has never cached asks.
  const seed = React.useMemo(
    () => (type ? findEntityInStore(useInboxStore.getState(), type, rawId) : undefined),
    [type, rawId],
  ) as any;
  const named = !!(seed && (seed.title || seed.display_title || seed.name));
  const queryArgs = type && !named ? entityQueryArgs(type, rawId) : null;
  const task = useQueryNoThrow(api.tasks.webGet, type === 'task' && queryArgs ? queryArgs : 'skip').data;
  const plan = useQueryNoThrow(api.plans.webGet, type === 'plan' && queryArgs ? queryArgs : 'skip').data;
  const session = useQueryNoThrow(api.conversations.webGet, isSession && queryArgs ? queryArgs : 'skip').data;
  const trigger = useQueryNoThrow(api.agentTasks.webGet, type === 'trigger' && queryArgs ? queryArgs : 'skip').data;
  const doc = useQueryNoThrow(api.docs.webGet, type === 'doc' && looksConvex && !named ? { id: rawId } : 'skip').data;
  // A call names its title; a stretch of one (`cl-42:15-25`) adds the lines,
  // a moment (`cl-42@2:30`) the time, the way the web pill labels them.
  const callRef = type === 'call' ? parseCallRef(rawId) : null;
  const call = useQueryNoThrow(api.transcripts.webGetCallRef, callRef && !named ? { ref: callRef.call } : 'skip').data;
  const source = useQueryNoThrow(api.ingest.webGetSource, type === 'source' && !named ? { ref: rawId } : 'skip').data;

  const served: any = type === 'task' ? task : type === 'plan' ? plan : isSession ? session : type === 'trigger' ? trigger : type === 'doc' ? doc : type === 'call' ? call : type === 'source' ? source : undefined;

  const entity: any = served ?? seed;

  // Unknown id shape, a Convex id resolving to no entity table, or the
  // transient state while resolveIdType is in flight.
  if (!type) return fallback !== undefined ? <>{fallback}</> : <RNText>{rawId}</RNText>;

  const color = TYPE_COLOR[type];

  // One label rule for every type, shared with web: the pill reads as the
  // object's NAME.
  const resolvedTitle: string | undefined =
    (type === 'trigger' ? entity?.display_title : undefined) || entity?.title || entity?.display_title || entity?.name;
  // One change of a proposal (`op-55#3`) reads as the proposal's name and the
  // change's number. A proposal this phone does not hold has no name, so the
  // pill shows the reference as written, which already carries the number.
  const refLabel = entityReferenceLabel({
    title: resolvedTitle,
    shortId: entity?.short_id,
    rawId,
    typeLabel: TYPE_LABEL[type],
  }) +callRefLabelSuffix(callRef) + proposalChangeLabelSuffix(type === 'proposal' && entity ? parseProposalChangeRef(rawId) : null);
  // A session that wears a character or a role is named as that person, the
  // same rule as the web pill: its face in place of the glyph, its name as the
  // label. A session nobody personified reads exactly as it did before.
  const identityRow = isSession && entity?._id ? identityRowOf(entity) : null;
  const label = (identityRow && identityLine(identityRow, refLabel, personifyAll).name) || refLabel;

  // A call keeps the whole reference, so the screen opens at the moment or
  // the lines it names, not at the top of the call.
  const targetId = isSession || type === 'doc'
    ? entity?._id ?? (looksConvex ? rawId : null)
    : type === 'call'
      ? rawId
      : entity?.short_id ?? rawId;
  // No trigger screen on mobile yet — that pill still names the trigger and
  // reads inline, it just isn't tappable. The type → screen table is shared
  // with the link opener and the deep-link handler (lib/links).
  const route = targetId ? mobileEntityRoute(type, targetId) : null;

  return (
    <RNText
      style={[styles.pill, { backgroundColor: color + '1a', color }]}
      onPress={route ? () => router.push(route as any) : undefined}
      suppressHighlighting
    >
      {type === 'task' ? (
        (() => {
          const s = TASK_STATUS_ICON[entity?.status || 'open'] ?? TASK_STATUS_ICON.open;
          return <Feather name={s.icon} size={10} color={s.color} />;
        })()
      ) : (
        <MobileIdentityFace row={identityRow} size={12} fallback={<Feather name={TYPE_ICON[type]} size={10} color={color} />} />
      )}
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

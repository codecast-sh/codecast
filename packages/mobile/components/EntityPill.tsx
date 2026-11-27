import React from 'react';
import { StyleSheet } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { api } from '@codecast/convex/convex/_generated/api';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { findEntityInStore, entityTypeInStore } from '@codecast/web/lib/liveEntities';
import { useSyncOrgProposal } from '@codecast/web/hooks/useSyncOrgProposals';
import { usePriorityDetail, useSyncPriorityDetail } from '@codecast/web/hooks/usePriorityDetail';
import { useRouter } from 'expo-router';
import { Theme, useTheme, type Palette } from '@/constants/Theme';
import { mixColor, webColor } from '@/lib/solColor';
import { EntityKindIcon, TaskStatusMark, WebIcon } from '@/components/marks';
import { ACCENT, DECISION_STATE, TYPE_ICON } from '@codecast/web/lib/entityCardAccent';
import { PR_STATE_GLYPH } from '@codecast/web/lib/prStateGlyph';
import { deployLook } from '@codecast/web/lib/deploys/deployLook';
import { isConvexId, isEntityId, entityTypeFromId, entityReferenceLabel, parseCallRef, callRefLabelSuffix, parseProposalChangeRef, proposalChangeLabelSuffix, parseReplayRef, replayRefLabelSuffix, type EntityType } from '@codecast/shared/entities';
import { mobileEntityRoute } from '@/lib/linkRoutes';
import { openLink } from '@/lib/links';
import { replayTitle } from '@codecast/web/components/ops/opsModel';
import { identityLine, identityRowOf } from '@codecast/web/lib/sessionIdentity';
import { useIdentityPrefs } from '@codecast/web/hooks/useIdentityPrefs';
import { MobileIdentityFace } from '@/components/identity';
import { useMessageLongPress } from '@/components/MessageLongPress';
import { deployTitle } from '@codecast/web/lib/line/deployWords';
import { repoObjectTitle } from '@codecast/web/lib/repoObjects';
import { deployPillElapsed, deployPillState, deployPillSuffix, deployTone, runRefKey, type DeployTone } from '@codecast/web/lib/deploys/deployPill';
import { usePrPillLook, useRefLifecycle } from '@codecast/web/hooks/useRefLifecycle';
import type { PrGlyph } from '@codecast/web/lib/changes/prPill';
import { ChangeWords } from '@/components/ChangeText';
import { PriorityPillMarks } from '@/components/priorities/PriorityPillMarks';
import { useNowWhen } from '@codecast/web/hooks/useCoarseNow';


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
  replay: 'Replay',
  issue: 'Issue',
  metric: 'Metric',
  deploy: 'Deploy',
  role: 'Role',
  person: 'Person',
  secret: 'Secret',
  flow: 'Flow',
  priority: 'Priority',
};

// The pill's glyph is web's (components/marks): a kind's glyph and accent
// (lib/entityCardAccent), a task's status disc, a decision's state, a pull
// request's state (lib/prStateGlyph) and a deploy's (lib/deploys/deployLook).
const PILL_GLYPH = 11;
const prGlyphIcon = (glyph: PrGlyph) => PR_STATE_GLYPH[glyph]?.pr ?? TYPE_ICON.pr;

// A failure must be seen before it is read: about twice the tint every other pill wears.
const FAILED_TINT = '33';
export const toneColor = (t: Palette, tone: DeployTone) =>
  ({ green: t.green, yellow: t.yellow, red: t.red, orange: t.orange, muted: t.textMuted, dim: t.textDim })[tone];

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
export function EntityPill({ shortId, type: typeProp, id: idProp, fallback, to }: {
  shortId?: string;
  type?: EntityType;
  id?: string;
  fallback?: React.ReactNode;
  /** The link the pill was drawn from, when it carries more than the id (a
   *  share token): the tap opens through it, so the token reaches the screen. */
  to?: string;
}) {
  const Theme = useTheme();
  const router = useRouter();
  const messageLongPress = useMessageLongPress();
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
  const prefs = useIdentityPrefs();

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
  // A replay, or a moment of it (`rp-12@1:23`): the replay is the row, the time rides the label.
  const replayRef = type === 'replay' ? parseReplayRef(rawId) : null;
  const replay = useQueryNoThrow(api.replays.webGetReplay, type === 'replay' && !named ? { ref: replayRef?.replay ?? rawId } : 'skip').data;
  // An Ops issue (`eg-N`) and a metric watch (`mw-N`), named by their title and name.
  const issue = useQueryNoThrow(api.ingest.webGetGroup, type === 'issue' && !named ? { ref: rawId } : 'skip').data;
  const metric = useQueryNoThrow(api.metrics.webGetWatch, type === 'metric' && !named ? { ref: rawId } : 'skip').data;
  // A deploy's state is the point of its pill, so it reads live whatever the store holds (`dp-N`, or its Actions run).
  const deploy = useQueryNoThrow(api.deploys.get, type === 'deploy' ? { ref: rawId } : 'skip').data;

  // A proposal (`op-N`, or one change `op-N#k`) is store-fed, as on the web:
  // the feeder syncs its row and changes, and the pill reads the row's title back.
  const proposalRef = type === 'proposal' && !named ? parseProposalChangeRef(rawId)?.proposal ?? rawId : null;
  useSyncOrgProposal(proposalRef);
  const proposal = useInboxStore((s) => (proposalRef ? findEntityInStore(s, 'proposal', rawId) : undefined));

  // A priority (`pri-N`) is store-fed the same way: priorities.show into
  // priorityDetails, laid over the workspace list's row. A refusal reads as
  // no access, whatever the store held.
  const priorityFeed = useSyncPriorityDetail(type === 'priority' && !named ? rawId : null);
  const priorityRow = usePriorityDetail(type === 'priority' ? rawId : null);
  const priorityRefused = type === 'priority' && priorityFeed.refused;
  const priority = priorityRefused ? null : priorityRow;

  const served: any = type === 'priority' ? priority : type === 'proposal' ? proposal : type === 'task' ? task : type === 'plan' ? plan : isSession ? session : type === 'trigger' ? trigger : type === 'doc' ? doc : type === 'call' ? call : type === 'source' ? source : type === 'replay' ? replay : type === 'issue' ? issue : type === 'metric' ? metric : type === 'deploy' ? deploy : undefined;

  const entity: any = priorityRefused ? null : served ?? seed;
  const deployState = type === 'deploy' && entity ? deployPillState(entity) : null;
  const ticks = deployState === 'waiting' || deployState === 'going_out';
  const now = useNowWhen((t) => (ticks ? deployPillElapsed(entity, t) ?? '' : ''), 15_000);
  // A pull request or commit says where it stands as its change: the web's track and glyph (changes.md CH4).
  const change = useRefLifecycle(type === 'pr' || type === 'commit' ? type : null, entity);
  // A pull request's glyph is its state: open, draft, merged or closed.
  const prLook = usePrPillLook(type === 'pr' ? entity : null);

  // Unknown id shape, a Convex id resolving to no entity table, or the
  // transient state while resolveIdType is in flight.
  if (!type) return fallback !== undefined ? <>{fallback}</> : <RNText>{rawId}</RNText>;
  // A GitHub Actions run is a deploy only once codecast says so; until then, and for every CI run, it stays its link.
  if (type === 'deploy' && !entity && runRefKey(rawId)) return <>{fallback}</>;

  const color = deployState ? toneColor(Theme, deployTone(entity, Date.now())) : webColor(ACCENT[type].text, Theme);

  // One label rule for every type, shared with web: the pill reads as the
  // object's NAME.
  const resolvedTitle: string | undefined =
    (type === 'trigger' ? entity?.display_title : undefined) || (type === 'replay' ? replayTitle(entity) : undefined) || (deployState ? deployTitle(entity) : undefined) || ((type === 'commit' || type === 'pr') && entity ? repoObjectTitle(type, entity) : undefined) || entity?.title || entity?.display_title || entity?.name;
  // One change of a proposal (`op-55#3`) reads as the proposal's name and the
  // change's number. A proposal this phone does not hold has no name, so the
  // pill shows the reference as written, which already carries the number.
  const refLabel = entityReferenceLabel({
    title: resolvedTitle,
    shortId: entity?.short_id,
    rawId,
    typeLabel: TYPE_LABEL[type],
  }) + (entity ? callRefLabelSuffix(callRef) + replayRefLabelSuffix(replayRef) : '') + proposalChangeLabelSuffix(type === 'proposal' && entity ? parseProposalChangeRef(rawId) : null)
    // A priority reads as its title and how many critical milestones are done.
    + (type === 'priority' && entity?.counts?.critical_total ? ` ${entity.counts.critical_done}/${entity.counts.critical_total}` : '');
  // A session that wears a character or a role is named as that person, the
  // same rule as the web pill: its face in place of the glyph, its name as the
  // label. A session nobody personified reads exactly as it did before.
  const identityRow = isSession && entity?._id ? identityRowOf(entity) : null;
  const label = (identityRow && identityLine(identityRow, refLabel, prefs).name) || refLabel;

  // A call keeps the whole reference, so the screen opens at the moment or
  // the lines it names, not at the top of the call.
  const targetId = isSession || type === 'doc'
    ? entity?._id ?? (looksConvex ? rawId : null)
    : type === 'call' || type === 'proposal' || type === 'replay'
      ? rawId
      : entity?.short_id ?? rawId;
  // The type → screen table is shared with the link opener and the deep-link
  // handler (lib/links).
  const route = targetId ? mobileEntityRoute(type, targetId) : null;

  return (
    <RNText
      style={[styles.pill, { backgroundColor: color + (deployState === 'failed' ? FAILED_TINT : '1a'), color }]}
      accessibilityLabel={deployState ? `${label}, ${deployPillSuffix(entity, now)}` : prLook?.word ? `${label}, ${prLook.word}` : type === 'priority' && entity ? [label, entity.owner, entity.rank != null ? `rank ${entity.rank}` : null].filter(Boolean).join(', ') : undefined}
      onPress={to ? () => void openLink(to) : route ? () => router.push(route as any) : undefined}
      onLongPress={messageLongPress ? () => messageLongPress([{ label: 'Copy ID', text: entity?.short_id ?? rawId }]) : undefined}
      suppressHighlighting
    >
      {type === 'task' ? (
        <TaskStatusMark status={entity?.status} size={PILL_GLYPH} />
      ) : type === 'decision' ? (
        <WebIcon icon={(DECISION_STATE[entity?.status ?? 'pending'] ?? DECISION_STATE.pending).icon} color={color} size={PILL_GLYPH} />
      ) : prLook ? (
        <WebIcon icon={prGlyphIcon(prLook.glyph)} color={color} size={PILL_GLYPH} />
      ) : deployState ? (
        (() => {
          const look = deployLook(entity, Date.now());
          // A failure wears web's heavier stroke; a replaced deploy fades.
          return <WebIcon icon={look.Icon} color={deployState === 'replaced' ? mixColor(color, 50, Theme.bg) : color} size={PILL_GLYPH} strokeWidth={deployState === 'failed' ? 3 : undefined} />;
        })()
      ) : type === 'priority' && entity ? (
        <PriorityPillMarks row={entity} />
      ) : (
        <MobileIdentityFace row={identityRow} size={12} fallback={<EntityKindIcon type={type} size={PILL_GLYPH} color={color} />} />
      )}
      {isSession && entity?.status === 'active' && <RNText style={{ color: Theme.greenBright, fontSize: 8 }}>{' '}●</RNText>}
      {/* NBSP so the icon never strands on the previous line when the pill wraps */}
      {' '}{label}
      {/* The glyph and tone carry a deploy's state; only how long one still waits or goes out follows its name. */}
      {ticks && ` ${deployPillElapsed(entity, now) ?? ''}`}
      {change && <ChangeWords lifecycle={change} />}
    </RNText>
  );
}

const styles = StyleSheet.create({
  pill: {
    fontFamily: 'JetBrainsMono-Regular',
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
});

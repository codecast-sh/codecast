// The Modern Activity page's items: the feed's rows (team or personal, from
// the existing feed hooks) joined with what the store already holds about
// each session, read once per page and never per row:
//   - the viewer's own sessions (store.sessions): the full status, its reason
//     and the pinned state line, decided by the rail's own rules;
//   - git and GitHub events (store.externalEvents): the PRs a session touched
//     and the commits it made;
//   - tasks (store.tasks, the active workspace): the ones a session worked on;
//   - decisions (store.sessionDecisions): asks still open, answers given.
// Every read is a wake signature of the fields drawn, so a liveness heartbeat
// re-renders nothing; time-driven state rides the shared 15s clock the feed
// hooks already tick on.
import { useMemo, useRef } from "react";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { railRowPlacement, useTrackedStore, type InboxSession, type SessionDecisionItem } from "../../store/inboxStore";
import { makeCollectionSig } from "../../store/wakeSig";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useViewerIdentity } from "../../hooks/useTeamRoster";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { externalEventsNewestFirst, useExternalEvents } from "../../hooks/useSyncExternalEvents";
import { feedActorId } from "../../lib/liveEntities";
import { cleanTitle } from "../../lib/conversationProcessor";
import { sessionCardTitle } from "../../lib/sessionCard";
import { sessionCardSummary } from "../../lib/sessionSummary";
import { sessionCardLine } from "../../lib/sessionCardLine";
import { sessionStatusOf, type SessionStatus } from "../../lib/sessionStatus";
import { threadStateView } from "../../lib/threadState";
import type { Conversation } from "../../lib/conversationRow";
import type { ExternalEventRecord } from "../../lib/externalEventRecord";
import {
  indexOutcomes, keepStableItems, loosePrs, makeItem, prFromStatus, prThreads, withLivePr,
  type ActivityActor, type ActivityItem, type DecisionRowLike, type PrThread, type TaskRowLike,
} from "./activityModel";

// What a row of the viewer's own draws or decides its state from. Liveness
// stamps (last_heartbeat, updated_at) and the streamed message_count stay out:
// the clock covers what time changes.
const ownSessionsSig = makeCollectionSig<InboxSession>((s) => [
  s.title ?? "", s.short_title ?? "", s.subtitle ?? "", s.idle_summary ?? "", s.thread_state ?? "", s.thread_state_status ?? "",
  s.agent_status ?? "", s.is_idle ? 1 : 0, s.awaiting_input ? 1 : 0, s.is_connected ? 1 : 0, s.is_unresponsive ? 1 : 0,
  s.pending_api_error ? 1 : 0, s.pending_api_error_kind ?? "", s.session_error ?? "", s.user_rest ?? "",
  s.inbox_killed_at ?? 0, s.inbox_dismissed_at ?? 0, s.inbox_stashed_at ?? 0, s.inbox_snoozed_until ?? 0,
  (s.message_count ?? 0) > 0 ? 1 : 0, s.pr_status ? `${s.pr_status.number}:${s.pr_status.state}` : "",
].join("|"));

const decisionsSig = makeCollectionSig<SessionDecisionItem>((d) =>
  `${d.conversation_id}|${d.status}|${d.short_id ?? ""}|${(d.asked_user_ids ?? []).join(",")}|${d.resolved_at ?? 0}|${d.question?.length ?? 0}`);

const taskSig = (t: TaskRowLike) =>
  `${t.status ?? ""}|${t.closed_at ?? 0}|${t.title ?? ""}|${(t.conversation_ids ?? []).join(",")}|${t.created_from_conversation ?? ""}`;

const NO_DECISIONS: Record<string, SessionDecisionItem> = {};

export type ActivityItems = { items: ActivityItem[]; loose: PrThread[] };

export function useActivityItems(rows: readonly Conversation[], opts: { teamId: string | null; teamMode: boolean }): ActivityItems {
  const now = useCoarseNow(15_000);
  const viewer = useViewerIdentity();
  const st = useTrackedStore([
    (s) => ownSessionsSig(s.sessions),
    (s) => decisionsSig(s.sessionDecisions ?? NO_DECISIONS),
  ]);
  const sessionsSig = ownSessionsSig(st.sessions);
  const decisionMap = st.sessionDecisions ?? NO_DECISIONS;
  const decisionSig = decisionsSig(decisionMap);

  const tasks = useWorkspaceCollection<TaskRowLike>("tasks", taskSig);
  const { teamId, teamMode } = opts;
  // The externalEvents key is one shared overlay other views feed into, so the
  // team view reads only the active team's rows (as the Classic feed does).
  const eventsWhere = useMemo(
    () => (teamMode && teamId ? (row: ExternalEventRecord) => String(row.team_id) === teamId : undefined),
    [teamMode, teamId],
  );
  const events = useExternalEvents(eventsWhere, externalEventsNewestFirst);

  const prs = useMemo(() => prThreads(events), [events]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- decisionSig stands in for the churny map
  const decisions = useMemo(() => Object.values(decisionMap) as DecisionRowLike[], [decisionSig]);
  const outcomes = useMemo(
    () => indexOutcomes({ events, prs, tasks, decisions, viewerId: viewer?._id ?? null }),
    [events, prs, tasks, decisions, viewer?._id],
  );

  const cache = useRef<Map<string, ActivityItem>>(new Map());
  const items = useMemo(() => {
    const sessions = st.sessions;
    const me: ActivityActor | null = viewer ? { id: viewer._id, name: viewer.name || viewer.email || "You", image: viewer.image ?? viewer.github_avatar_url ?? null } : null;
    const built = rows.map((conv) => {
      const own = conv.is_own ? sessions[conv._id] : undefined;
      const sessionOutcomes = outcomes.get(conv._id);
      const pendingAsk = !!sessionOutcomes?.decisions.some((d) => d.pending);
      let status: SessionStatus;
      let reason: string | null = null;
      let line: string;
      let title: string;
      if (own) {
        const hosted = isHostedAgentType(own.agent_type);
        const live = { asking: !!sessionOutcomes?.decisions.some((d) => d.pending && d.askedOfViewer), blocked: !!own.pending_api_error };
        status = sessionStatusOf({ row: own, placement: railRowPlacement(own, now), now, live, hosted });
        const card = sessionCardLine({
          row: own,
          status,
          now,
          live,
          stateLine: threadStateView(own, own.message_count, now)?.cardLine,
          summary: sessionCardSummary(own),
          prompt: null,
          hosted,
        });
        reason = card.reason;
        line = card.text;
        title = sessionCardTitle(own);
      } else {
        // A teammate's row carries liveness and nothing finer: running now,
        // an ask waiting on someone, or neither.
        status = pendingAsk ? "needs_you" : conv.is_active ? "working" : "idle";
        reason = pendingAsk ? "Decision" : null;
        line = sessionCardSummary({ subtitle: conv.visibility_mode === "minimal" ? null : conv.subtitle }) || conv.activity_summary?.trim() || "";
        title = cleanTitle(conv.title || "Untitled");
      }
      const actorId = feedActorId(conv) ?? (conv.is_own && me ? me.id : "unknown");
      // A role seat the viewer hosts is the role's (its bot is the actor), so
      // it never reads as a second copy of the viewer.
      const seat = own?.role ? (own.role.given_name || own.role.name) : null;
      const actor: ActivityActor = conv.author_name
        ? { id: actorId, name: conv.author_name, image: conv.author_avatar ?? null }
        : seat ? { id: actorId, name: seat, image: null }
        : conv.is_own && me && !conv.acting_user_id ? me : { id: actorId, name: "Unknown", image: null };
      return makeItem({
        conv,
        status,
        reason,
        line,
        title,
        actor,
        outcomes: withLivePr(sessionOutcomes, own?.pr_status ? prFromStatus(own.pr_status) : null),
        hiddenFromTeam: teamMode && !!conv.is_own && conv.is_private !== false,
      });
    });
    const next = keepStableItems(cache.current, built);
    cache.current = next.cache;
    return next.items;
    // sessionsSig stands in for st.sessions: only the drawn fields wake it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sessionsSig, outcomes, now, viewer, teamMode]);

  // Only inside the span the loaded sessions cover, as the Classic feed keeps
  // its git rows: older pages bring their own, and a busy repo never fills
  // days the feed has not reached with PRs alone.
  const loose = useMemo(() => {
    if (!teamMode || items.length === 0) return [];
    let floor = Infinity;
    for (const i of items) if (i.at && i.at < floor) floor = i.at;
    return loosePrs(prs, new Set(items.map((i) => i.id))).filter((p) => p.stateAt >= floor);
  }, [teamMode, prs, items]);

  return { items, loose };
}

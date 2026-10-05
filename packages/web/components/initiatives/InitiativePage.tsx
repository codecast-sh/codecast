"use client";
// /initiatives/in-N (docs/architecture/initiatives-projects-role-page.md I1
// "The page"). It opens the way a scope opens (scopes-and-feed.md F4): the
// conversation with whoever drives the initiative on the left (a role's
// standing session, or a person's own anchor), the initiative on the right,
// through the one layout a scope uses, so the column, the overlay and the
// phone sheet behave the same. When nobody's conversation can open beside it
// (no owner, or a person with no anchor here) the initiative is the page.
//
// Paints from the store: the workspace's initiatives, the org tree, and the
// projects, plans and tasks every rollup derives from at render. Every edit is
// a store action that moves the page in the same tick and rides dispatch to
// the side effect of its own name.
import { useMemo, useState } from "react";
import { ShareControl } from "../ShareControl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarDays, Flag, PanelRightClose, PanelRightOpen } from "lucide-react";
import { INITIATIVE_STATUSES, INITIATIVE_STATUS_LABEL, metricReadings, metricTrends, milestoneCounts, nextMilestone, type InitiativeOwner, type InitiativeRow, type InitiativeStatus } from "@codecast/shared/contracts/initiative";
import { InboxConversation } from "../../app/inbox/QueuePageClient";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInitiative, useSyncInitiativeUpdates, useBoardTasks, useTasksBackfilled } from "../../hooks/useInitiatives";
import { useRolesAndPeopleOptions } from "../../hooks/useRolesAndPeopleOptions";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useSyncPlans } from "../../hooks/useSyncPlans";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { useSyncTasks } from "../../hooks/useSyncTasks";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { initiativeHref, initiativeProgress, ownerId, ownerSeat, progressPercent } from "../../lib/initiatives";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { canEditRole } from "../../lib/scopePage";
import { cn } from "../../lib/utils";
import { EntityIdPill } from "../EntityIdPill";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { ConversationWithPanel } from "../org/scope/ConversationWithPanel";
import { usePanelLayout } from "../../hooks/usePanelLayout";
import { useSeat } from "../org/scope/useSeat";
import { SeatLead } from "../org/scope/SeatLead";
import { HEALTH_COLOR, INITIATIVE_ACCENT } from "../../lib/initiativeColors";
import { HealthChip, MetricTile, NextMilestoneChip, OwnerChip, ProgressBar, StatusGlyph, TargetDate } from "./InitiativeAtoms";
import { IntentHeader, IntentIdChip, IntentPickChip, useIntentTab } from "./IntentHeader";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { isConvexId } from "../../lib/entityLinks";
const api = _api as any;
import { targetDayOf, targetDayStamp } from "@codecast/shared/time";
import { INITIATIVE_TABS, InitiativePanel } from "./InitiativePanel";

const ended = (s: InitiativeStatus) => s === "completed" || s === "cancelled";

export function InitiativePageInner({ id }: { id: string }) {
  const { tree } = useSyncOrgTree();
  // Every rollup on the page derives from these at render: keep them fed.
  useSyncProjects(); useSyncTasks(); useSyncPlans();
  const { initiative, all } = useInitiative(id);
  useSyncInitiativeUpdates(initiative?._id ?? null);
  const { layout, phone, measureRef } = usePanelLayout();
  const now = useCoarseNow(30_000);
  const tasks = useBoardTasks();
  const counted = useTasksBackfilled();
  const me = useTrackedStore([(st) => st.currentUser?._id]);
  const meId = me.currentUser?._id ? String(me.currentUser._id) : null;

  const seatOf = useMemo(() => ownerSeat(tree, initiative?.owner), [tree, initiative?.owner]);
  const conversationId = seatOf.conversationId;
  // The session heartbeats about once a second: read the fields the
  // conversation branches on, never the row.
  const st = useTrackedStore([
    (x) => (conversationId ? (x.sessions[conversationId] as any)?.is_idle : undefined),
    (x) => (conversationId ? (x.sessions[conversationId] as any)?.session_error : undefined),
  ]);
  const session = conversationId ? (st.sessions[conversationId] as any) : undefined;

  // The panel's tab lives in the URL, like the project page's: ?tab=activity.
  const { tab, linked, setTab } = useIntentTab(INITIATIVE_TABS, `/initiatives/${id}`);
  // A link straight to a tab opens the panel on it, whatever the width.
  const [panelOpen, setPanelOpen] = useState<boolean>(() => !phone || linked);
  // A page opened by a stub's key moves to the `in-N` the server minted, so
  // the address a person copies is the one that lasts.
  const router = useRouter();
  useWatchEffect(() => {
    if (initiative?.short_id && id !== initiative.short_id) router.replace(initiativeHref(initiative));
  }, [initiative?.short_id, id]);
  const progress = initiative ? initiativeProgress(initiative, tasks) : null;

  // Talk follows the seat's own rule: a role's host, its parent or an admin;
  // a person's anchor is theirs alone. Anyone else reads and asks to send.
  const canTalk = seatOf.role
    ? canEditRole(tree, seatOf.role, meId) || (seatOf.role.reports_to.kind === "user" && seatOf.role.reports_to.user_id === meId)
    : initiative?.owner?.kind === "user" && initiative.owner.user_id === meId;
  const lead = useMemo(
    () => (initiative && seatOf.speaker && progress ? <InitiativeLead initiative={initiative} done={progress.done} total={progress.total} counted={counted} /> : null),
    [initiative, seatOf.speaker, progress?.done, progress?.total, counted], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const seat = useSeat({ conversationId, speaker: seatOf.speaker ?? "the owner", lead, canTalk: !!canTalk, hideDiff: panelOpen });

  if (!initiative || !progress) return <NotFound id={id} loading={all.length === 0 && !tree} />;

  const readings = metricReadings(initiative);
  const trends = metricTrends(initiative);
  const panel = (
    <InitiativePanel
      initiative={initiative}
      all={all}
      now={now}
      tab={tab}
      onTab={setTab}
      onClose={conversationId ? () => setPanelOpen(false) : undefined}
      closeLabel={layout === "sheet" ? "Back to the conversation" : "Close the initiative"}
    />
  );

  return (
    <div ref={measureRef} className="h-full flex flex-col overflow-hidden" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-initiative-page={initiative.short_id || initiative._id} data-scope-layout={layout} data-initiative-owner-kind={initiative.owner?.kind ?? "none"}>
      <IntentHeader
        // the stripe says how it is going, in the colour of the owner's last word
        stripeColor={initiative.health === "none" ? INITIATIVE_ACCENT : HEALTH_COLOR[initiative.health]}
        back={{ href: "/initiatives", label: "Back to initiatives" }}
        glyph={<Flag className="w-4 h-4 shrink-0" style={{ color: INITIATIVE_ACCENT }} />}
        title={initiative.title}
        onRename={(title) => useInboxStore.getState().updateInitiative(initiative._id, { title })}
        renameLabel="Initiative title"
        titleData={{ "data-initiative-title": "" }}
        idChip={initiative.short_id ? <IntentIdChip id={initiative.short_id} /> : null}
        share={<ShareControl label="initiative" path={`/initiatives/${initiative.short_id || initiative._id}`} publicShare={{ kind: "initiative", id: initiative._id, token: (initiative as any).share_token }} />}
        phone={phone}
        // Line two: status, who drives it, how it is going, when it is due, how
        // far along, the number against its target, and the next milestone.
        chips={<>
          <StatusControl initiative={initiative} />
          <OwnerControl initiative={initiative} />
          <HealthChip health={initiative.health} at={initiative.health_at} now={now} />
          <TargetControl initiative={initiative} now={now} />
          <ProgressBar progress={progress} partial={!counted} className="w-[150px]" />
          {readings.map((r) => <MetricTile key={r.key} reading={r} trend={trends[r.key]} now={now} size="chip" />)}
          <NextMilestoneChip milestone={nextMilestone(initiative)} now={now} counts={milestoneCounts(initiative)} className="max-w-[260px]" />
          {initiative.parent_initiative_id && (
            <span className="inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-initiative-parent>
              under <EntityIdPill type="initiative" id={all.find((r) => r._id === initiative.parent_initiative_id)?.short_id ?? initiative.parent_initiative_id} />
            </span>
          )}
          <OriginLine initiativeId={initiative._id} />
        </>}
        actions={conversationId && (
          <ShortcutTooltip label={panelOpen ? "Close the initiative" : `Open the initiative: ${progressPercent(progress)}% done`} side="bottom">
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              className={cn("shrink-0 h-[32px] inline-flex items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium transition-colors hover:bg-sol-bg-highlight/70", phone ? "w-[32px]" : "px-3", panelOpen && "bg-sol-bg-highlight/60")}
              style={{ border: "1px solid color-mix(in srgb, var(--sol-border) 40%, transparent)", color: panelOpen ? "var(--sol-text)" : "var(--sol-text-muted)" }}
              aria-pressed={panelOpen}
              aria-label={phone ? "Initiative" : undefined}
              data-initiative-panel-toggle={panelOpen ? "open" : "closed"}
            >
              {panelOpen ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
              {!phone && "Initiative"}
            </button>
          </ShortcutTooltip>
        )}
      />

      {conversationId ? (
        <ConversationWithPanel open={panelOpen} layout={layout} panel={panel} conversation={
          <div className="flex-1 min-w-0 min-h-0" data-initiative-conversation={conversationId}>
            <InboxConversation
              sessionId={conversationId}
              isIdle={!!session?.is_idle}
              sessionError={session?.session_error}
              lastUserMessage={session?.last_user_message}
              seat={seat}
              autoFocusInput={!phone}
            />
          </div>
        } />
      ) : (
        // Nobody's conversation opens beside it: the initiative is the page.
        <div className="flex-1 min-h-0" data-initiative-alone>
          <div className="h-full mx-auto w-full max-w-[760px]">{panel}</div>
        </div>
      )}
    </div>
  );
}

/** The owner's opening line: what this is and how it stands, said from the
 *  rows, in the frame a scope's lead uses. */
function InitiativeLead({ initiative, done, total, counted }: { initiative: InitiativeRow; done: number; total: number; counted: boolean }) {
  const projects = initiative.project_ids.length;
  // The opening line says a number only once the task store holds them all.
  const carried = projects === 0 ? "No project carries it yet" : `${projects} ${projects === 1 ? "project carries" : "projects carry"} it${counted && total > 0 ? `, with ${done} of ${total} tasks done` : ""}`;
  return (
    <SeatLead data-initiative-lead>
      I drive {initiative.title}. {carried}. Ask me how it is going, or tell me what changed.
    </SeatLead>
  );
}

function NotFound({ id, loading }: { id: string; loading: boolean }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: "var(--sol-bg)" }} data-initiative-missing>
      {loading ? (
        <p className="text-[12.5px]" style={{ color: "var(--sol-text-dim)" }}>Loading the initiative…</p>
      ) : (
        <>
          <Flag className="w-8 h-8" style={{ color: "var(--sol-text-dim)" }} />
          <p className="text-[14px]" style={{ color: "var(--sol-text)" }}>No initiative <span style={{ fontFamily: "var(--font-mono)" }}>{id}</span> in this workspace.</p>
          <p className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>It may belong to another team. Switch the workspace or go back to the list.</p>
          <Link href="/initiatives" className="mt-1 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-medium" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)" }}><ArrowLeft className="w-3.5 h-3.5" /> Initiatives</Link>
        </>
      )}
    </div>
  );
}

/** Where the goal came from (initiatives-projects-role-page.md "I1, revised"):
 *  an initiative an accepted change made says so, from the org log, with the
 *  proposal one click away. A goal set on the page says nothing here. */
function OriginLine({ initiativeId }: { initiativeId: string }) {
  const { data } = useQueryNoThrow(api.orgChanges.origin, isConvexId(initiativeId) ? { subject: initiativeId } : "skip");
  if (!data) return null;
  const day = new Date(data.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: new Date(data.at).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  const words = `Proposed by the review on ${day}`;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-initiative-origin={data.proposal?.short_id ?? "proposal"}>
      {data.proposal ? <Link href={`/org?proposal=${data.proposal.short_id}`} className="hover:underline" title={data.proposal.title ?? data.proposal.short_id}>{words}</Link> : words}
      {data.undone && <span title="The change that set it was undone; the goal stays as cancelled">(undone)</span>}
    </span>
  );
}

// ------------------------------------------------------------ the header's controls

function StatusControl({ initiative }: { initiative: InitiativeRow }) {
  const options = useMemo(() => INITIATIVE_STATUSES.map((s) => ({ key: s, label: INITIATIVE_STATUS_LABEL[s], face: <StatusGlyph status={s} /> })), []);
  return (
    <IntentPickChip data-initiative-pick="status" options={options} value={initiative.status} width="w-44" onPick={(key) => { if (key && key !== initiative.status) useInboxStore.getState().updateInitiative(initiative._id, { status: key as InitiativeStatus }); }}>
      <StatusGlyph status={initiative.status} />
      <span style={{ color: "var(--sol-text-secondary)" }}>{INITIATIVE_STATUS_LABEL[initiative.status]}</span>
    </IntentPickChip>
  );
}

/** Roles and people are peers (R5): the owner is either, picked from one list. */
function OwnerControl({ initiative }: { initiative: InitiativeRow }) {
  const roster = useTeamRosterIdentity();
  const { people, roles } = useRolesAndPeopleOptions(roster);
  const options = useMemo(() => [{ key: "", label: "No owner" }, ...roles, ...people], [roles, people]);
  const roleIds = useMemo(() => new Set(roles.map((r) => r.key)), [roles]);
  const pick = (key: string) => {
    if (key === (ownerId(initiative.owner) ?? "")) return;
    const owner: InitiativeOwner | null = !key ? null : roleIds.has(key) ? { kind: "role", role_id: key } : { kind: "user", user_id: key };
    useInboxStore.getState().updateInitiative(initiative._id, { owner });
  };
  return (
    <IntentPickChip data-initiative-pick="owner" options={options} value={ownerId(initiative.owner) ?? ""} onPick={pick}>
      <OwnerChip owner={initiative.owner} />
    </IntentPickChip>
  );
}

// One shared pair stores and reads a target day (shared/time), so the picker
// and `cast initiative` name the same day in every timezone.
const dateInputValue = (ts?: number) => targetDayOf(ts) ?? "";

function TargetControl({ initiative, now }: { initiative: InitiativeRow; now: number }) {
  const set = (value: string) => useInboxStore.getState().updateInitiative(initiative._id, { target_date: value ? targetDayStamp(value) : null });
  return (
    <label className="relative inline-flex items-center gap-1.5 -mx-1 px-1 h-6 rounded-md cursor-pointer transition-colors hover:bg-sol-bg-highlight/70" data-initiative-pick="target">
      <CalendarDays className="w-3.5 h-3.5" style={{ color: "var(--sol-text-dim)" }} />
      {initiative.target_date ? <TargetDate ts={initiative.target_date} now={now} done={ended(initiative.status)} /> : <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>No target</span>}
      <input type="date" value={dateInputValue(initiative.target_date)} onChange={(e) => set(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Target date" />
    </label>
  );
}

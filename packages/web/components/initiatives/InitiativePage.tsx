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
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarDays, Flag, PanelRightClose, PanelRightOpen } from "lucide-react";
import { INITIATIVE_STATUSES, INITIATIVE_STATUS_LABEL, type InitiativeOwner, type InitiativeRow, type InitiativeStatus } from "@codecast/shared/contracts/initiative";
import { InboxConversation } from "../../app/inbox/QueuePageClient";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInitiative, useSyncInitiativeUpdates, useTasksByProject } from "../../hooks/useInitiatives";
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
import { FilterOptionList, type FilterOption } from "../FilterDropdown";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { ConversationWithPanel, usePanelLayout } from "../org/scope/ConversationWithPanel";
import { useSeat } from "../org/scope/useSeat";
import { RoleFace } from "../org/RoleFace";
import type { OrgRole } from "../org/orgTypes";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { HEALTH_COLOR, HealthChip, INITIATIVE_ACCENT, OwnerChip, ProgressBar, StatusGlyph, TargetDate } from "./InitiativeAtoms";
import { InitiativePanel } from "./InitiativePanel";

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 22%, transparent)";
const ended = (s: InitiativeStatus) => s === "completed" || s === "cancelled";

export function InitiativePageInner({ id }: { id: string }) {
  const { tree } = useSyncOrgTree();
  // Every rollup on the page derives from these at render: keep them fed.
  useSyncProjects(); useSyncTasks(); useSyncPlans();
  const { initiative, all } = useInitiative(id);
  useSyncInitiativeUpdates(initiative?._id ?? null);
  const { layout, phone } = usePanelLayout();
  const now = useCoarseNow(30_000);
  const byProject = useTasksByProject();
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

  const [panelOpen, setPanelOpen] = useState<boolean>(() => !phone);
  // A page opened by a stub's key moves to the `in-N` the server minted, so
  // the address a person copies is the one that lasts.
  const router = useRouter();
  useWatchEffect(() => {
    if (initiative?.short_id && id !== initiative.short_id) router.replace(initiativeHref(initiative));
  }, [initiative?.short_id, id]);
  const progress = initiative ? initiativeProgress(initiative, byProject) : null;

  // Talk follows the seat's own rule: a role's host, its parent or an admin;
  // a person's anchor is theirs alone. Anyone else reads and asks to send.
  const canTalk = seatOf.role
    ? canEditRole(tree, seatOf.role, meId) || (seatOf.role.reports_to.kind === "user" && seatOf.role.reports_to.user_id === meId)
    : initiative?.owner?.kind === "user" && initiative.owner.user_id === meId;
  const lead = useMemo(
    () => (initiative && seatOf.speaker && progress ? <InitiativeLead initiative={initiative} role={seatOf.role} speaker={seatOf.speaker} done={progress.done} total={progress.total} /> : null),
    [initiative, seatOf.role, seatOf.speaker, progress?.done, progress?.total], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const seat = useSeat({ conversationId, speaker: seatOf.speaker ?? "the owner", lead, canTalk: !!canTalk, hideDiff: panelOpen });

  if (!initiative || !progress) return <NotFound id={id} loading={all.length === 0 && !tree} />;

  const tone = HEALTH_COLOR[initiative.health];
  const panel = (
    <InitiativePanel
      initiative={initiative}
      all={all}
      now={now}
      onClose={conversationId ? () => setPanelOpen(false) : undefined}
      closeLabel={layout === "sheet" ? "Back to the conversation" : "Close the initiative"}
    />
  );

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-initiative-page={initiative.short_id || initiative._id} data-scope-layout={layout} data-initiative-owner-kind={initiative.owner?.kind ?? "none"}>
      {/* the stripe says how it is going, in the colour of the owner's last word */}
      <div className="shrink-0 h-[3px] w-full" style={{ background: `linear-gradient(90deg, ${initiative.health === "none" ? INITIATIVE_ACCENT : tone}, color-mix(in srgb, ${initiative.health === "none" ? INITIATIVE_ACCENT : tone} 30%, transparent) 70%, transparent)` }} aria-hidden />

      <header className={cn("shrink-0 border-b", phone ? "px-3 pt-2 pb-2.5" : "px-5 pt-3 pb-3")} style={{ borderColor: HAIRLINE }}>
        <div className="flex items-start gap-3">
          <Link href="/initiatives" className="shrink-0 mt-[3px] inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }} aria-label="Back to initiatives">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <Flag className="w-4 h-4 shrink-0" style={{ color: INITIATIVE_ACCENT }} />
              <Title initiative={initiative} phone={phone} />
              {initiative.short_id && <span className="shrink-0 inline-flex items-center h-[20px] px-1.5 rounded-md text-[10.5px] font-medium" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>{initiative.short_id}</span>}
            </div>
            {/* Line two: status, who drives it, how it is going, when it is due, how far along. */}
            <div className={cn("mt-2 flex items-center gap-x-4 gap-y-1.5 flex-wrap", phone ? "text-[12px]" : "text-[12.5px]")}>
              <StatusControl initiative={initiative} />
              <OwnerControl initiative={initiative} />
              <HealthChip health={initiative.health} at={initiative.health_at} now={now} />
              <TargetControl initiative={initiative} now={now} />
              <ProgressBar progress={progress} className="w-[150px]" />
              {initiative.parent_initiative_id && (
                <span className="inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-initiative-parent>
                  under <EntityIdPill type="initiative" id={all.find((r) => r._id === initiative.parent_initiative_id)?.short_id ?? initiative.parent_initiative_id} />
                </span>
              )}
            </div>
          </div>
          {conversationId && (
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
        </div>
      </header>

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

/** The owner's opening bubble: what this is and how it stands, said from the
 *  rows, in the frame a scope's lead uses. */
function InitiativeLead({ initiative, role, speaker, done, total }: { initiative: InitiativeRow; role: OrgRole | null; speaker: string; done: number; total: number }) {
  const projects = initiative.project_ids.length;
  const carried = projects === 0 ? "No project carries it yet" : `${projects} ${projects === 1 ? "project carries" : "projects carry"} it${total > 0 ? `, with ${done} of ${total} tasks done` : ""}`;
  return (
    <div className="conv-col mx-auto px-2 sm:px-3 md:px-4 pt-4 pb-2" data-initiative-lead>
      <div className="flex items-center gap-2 mb-2">
        {role ? <RoleFace role={role} size={24} /> : <span className="w-6 h-6 rounded-full inline-flex items-center justify-center shrink-0" style={{ background: `color-mix(in srgb, ${INITIATIVE_ACCENT} 16%, transparent)`, color: INITIATIVE_ACCENT }}><Flag className="w-3.5 h-3.5" /></span>}
        <span className="text-xs font-medium" style={{ color: "var(--sol-text-secondary)" }}>{speaker}</span>
      </div>
      <div className="pl-8 text-[13.5px] leading-relaxed" style={{ color: "var(--sol-text)" }}>
        <p>I drive {initiative.title}. {carried}. Ask me how it is going, or tell me what changed.</p>
      </div>
    </div>
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

// ------------------------------------------------------------ the header's controls

function Title({ initiative, phone }: { initiative: InitiativeRow; phone: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    const next = draft?.trim();
    if (next && next !== initiative.title) useInboxStore.getState().updateInitiative(initiative._id, { title: next });
    setDraft(null);
  };
  const size = phone ? "text-[18px]" : "text-[22px]";
  if (draft !== null) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setDraft(null); }}
        className={cn("min-w-0 flex-1 bg-transparent outline-none font-semibold tracking-tight leading-none border-b", size)}
        style={{ fontFamily: "var(--font-serif)", borderColor: INITIATIVE_ACCENT }}
        aria-label="Initiative title"
      />
    );
  }
  return (
    <h1 className={cn("min-w-0 truncate font-semibold tracking-tight leading-none cursor-text", size)} style={{ fontFamily: "var(--font-serif)" }} onClick={() => setDraft(initiative.title)} title="Click to rename" data-initiative-title>
      {initiative.title}
    </h1>
  );
}

/** A chip that opens a list: the header's status, owner and target all read and write this way. */
function PickChip({ children, options, value, onPick, name, width = "w-56" }: { children: ReactNode; options: FilterOption[]; value: string; onPick: (key: string) => void; name: string; width?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1.5 -mx-1 px-1 h-6 rounded-md transition-colors hover:bg-sol-bg-highlight/70" data-initiative-pick={name}>{children}</button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(width, "p-1 max-h-80 overflow-y-auto bg-sol-bg border border-sol-border shadow-xl")}>
        <FilterOptionList options={options} value={value} onChange={onPick} onPicked={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function StatusControl({ initiative }: { initiative: InitiativeRow }) {
  const options = useMemo(() => INITIATIVE_STATUSES.map((s) => ({ key: s, label: INITIATIVE_STATUS_LABEL[s], face: <StatusGlyph status={s} /> })), []);
  return (
    <PickChip name="status" options={options} value={initiative.status} width="w-44" onPick={(key) => { if (key && key !== initiative.status) useInboxStore.getState().updateInitiative(initiative._id, { status: key as InitiativeStatus }); }}>
      <StatusGlyph status={initiative.status} />
      <span style={{ color: "var(--sol-text-secondary)" }}>{INITIATIVE_STATUS_LABEL[initiative.status]}</span>
    </PickChip>
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
    <PickChip name="owner" options={options} value={ownerId(initiative.owner) ?? ""} onPick={pick}>
      <OwnerChip owner={initiative.owner} />
    </PickChip>
  );
}

const dateInputValue = (ts?: number) => (ts ? new Date(ts).toISOString().slice(0, 10) : "");

function TargetControl({ initiative, now }: { initiative: InitiativeRow; now: number }) {
  const set = (value: string) => useInboxStore.getState().updateInitiative(initiative._id, { target_date: value ? Date.parse(`${value}T12:00:00Z`) : null });
  return (
    <label className="relative inline-flex items-center gap-1.5 -mx-1 px-1 h-6 rounded-md cursor-pointer transition-colors hover:bg-sol-bg-highlight/70" data-initiative-pick="target">
      <CalendarDays className="w-3.5 h-3.5" style={{ color: "var(--sol-text-dim)" }} />
      {initiative.target_date ? <TargetDate ts={initiative.target_date} now={now} done={ended(initiative.status)} /> : <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>No target</span>}
      <input type="date" value={dateInputValue(initiative.target_date)} onChange={(e) => set(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Target date" />
    </label>
  );
}

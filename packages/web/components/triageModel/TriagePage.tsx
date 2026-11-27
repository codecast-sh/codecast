// /triage: the inbox drawn in the triage model (lane, ask, shelf), next to a
// lab for trying every situation by hand. The Inbox tab reads the same placed
// inbox every list reads (placeInboxRows) and regroups it with the shared
// triageOf, so what it shows is your real sessions under the new model.
import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { TRIAGE_ASKS, triageSectionOf, triageTally, type TriageSection } from "@codecast/shared/contracts/triage";
import {
  placeInboxRows,
  resolveShowOld,
  sessionsWakeSig,
  sessionUnreadMap,
  sessionUnreadWakeSig,
  teamInboxIdsOf,
  pendingSendWakeSig,
  useInboxStore,
  useTrackedStore,
  type InboxSession,
} from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { isMove, triageInbox, TODAY_SECTION_WORD, type TriagedRow } from "../../lib/triage/liveTriage";
import { useContextMenu, ContextMenu } from "../ui/context-menu";
import { SessionMenuItems } from "../menus/ObjectContextMenus";
import { isForeignSession } from "../../lib/liveEntities";
import { useTriggerKillNotice } from "../../hooks/useTriggerKillNotice";
import { SessionStatusMark } from "../inbox/SessionStatusMark";
import { RowButton, TriageRowView } from "./triageVisual";
import { ASK_STATUS, ASK_TEXT, LANE_STATUS, LANE_TEXT, askWord, laneWord } from "../../lib/triage/triageLook";
import { TriageLab } from "./TriageLab";

type Tab = "inbox" | "lab";

const SECTION_WORD: Record<TriageSection, string> = {
  pinned: "Pinned", you: laneWord("you"), agent: laneWord("agent"), parked: laneWord("parked"), settled: laneWord("settled"),
  snoozed: "Snoozed", stashed: "Stashed", retired: "Retired",
};

function projectOf(s: InboxSession): string | null {
  const p = s.project_path || s.git_root || "";
  return p ? p.split("/").filter(Boolean).pop() ?? null : null;
}

export function TriagePage() {
  const [tab, setTab] = useState<Tab>("inbox");
  return (
    <div data-triage-page className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-sol-border px-5">
        <h1 className="text-sm font-semibold text-sol-text">Triage</h1>
        <nav className="flex items-center gap-1" role="tablist">
          {(["inbox", "lab"] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`rounded-md px-2.5 py-1 text-sm ${tab === k ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-muted hover:text-sol-text"}`}
            >
              {k === "inbox" ? "Inbox" : "Lab"}
            </button>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === "inbox" ? <TriageInbox /> : <TriageLab />}</div>
    </div>
  );
}

function TriageInbox() {
  const s = useTrackedStore([
    (st) => sessionsWakeSig(st.sessions),
    (st) => sessionUnreadWakeSig(st),
    (st) => st.sessionsWithQueuedMessages,
    (st) => st.pendingMessages,
    (st) => resolveShowOld(st.clientState.ui),
    (st) => st.currentUser?._id?.toString?.() ?? null,
    (st) => teamInboxIdsOf(st),
    (st) => st.pendingSessionCreates,
    (st) => st.blockedReviveRequestedAt,
    (st) => st.sessionDecisions,
    (st) => st.killedShelf,
  ]);
  const now = useCoarseNow(15_000);
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const [compare, setCompare] = useState(false);
  const [openShelf, setOpenShelf] = useState<TriageSection | null>(null);
  const [settledAll, setSettledAll] = useState(false);
  const sectionRefs = useRef<Partial<Record<TriageSection, HTMLElement | null>>>({});

  const placed = useMemo(
    () => placeInboxRows(s, { scope, now }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signatures are the deps (FleetBoard's pattern)
    [sessionsWakeSig(s.sessions), scope, now, teamInboxIdsOf(s), s.sessionsWithQueuedMessages, pendingSendWakeSig(s.pendingMessages), s.pendingSessionCreates, s.blockedReviveRequestedAt, s.sessionDecisions, s.killedShelf],
  );
  const unread = useMemo(
    () => sessionUnreadMap(s),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionUnreadWakeSig(s)],
  );
  const live = useMemo(() => triageInbox(placed, unread, now), [placed, unread, now]);
  const tally = useMemo(() => triageTally(Object.values(live.sections).flat().map((r) => r.triage)), [live]);

  const menu = useContextMenu<{ session: InboxSession; isForeign: boolean }>();
  const openMenu = menu.open;
  const onRowMenu = useCallback((e: ReactMouseEvent, session: InboxSession) => {
    const meId = useInboxStore.getState().currentUser?._id?.toString?.();
    openMenu(e, { session, isForeign: isForeignSession(session, undefined, meId) });
  }, [openMenu]);
  const { killWithNotice } = useTriggerKillNotice();
  const open = useCallback((id: string) => useInboxStore.getState().navigateToSession(id), []);

  const changedMoves = live.moves.filter((m) => isMove(m.from, m.to));
  const movedCount = changedMoves.reduce((n, m) => n + m.count, 0);

  const renderRow = (r: TriagedRow) => {
    const st = useInboxStore.getState();
    const moved = isMove(String(r.today), triageSectionOf(r.triage));
    const actions: ReactNode[] = [];
    if (r.triage.ask === "review") actions.push(<RowButton key="read" title="Mark read: it settles" onClick={() => st.ackSessionRead(r.s._id, r.s.updated_at)}>Read</RowButton>);
    if (r.triage.lane === "settled" && r.triage.shelf !== "retired") actions.push(<RowButton key="unread" title="Mark unread: back to Needs you if it has something to review" onClick={() => st.markSessionUnread(r.s._id)}>Unread</RowButton>);
    return (
      <TriageRowView
        key={r.s._id}
        triage={r.triage}
        title={r.s.title?.trim() || "Untitled session"}
        project={projectOf(r.s)}
        activityAt={r.s.updated_at}
        now={now}
        compare={compare && moved ? TODAY_SECTION_WORD[r.today] ?? r.today : null}
        actions={actions.length ? actions : undefined}
        onOpen={() => open(r.s._id)}
        onContextMenu={(e) => onRowMenu(e, r.s)}
      />
    );
  };

  const settledRows = live.sections.settled;
  const SETTLED_PREVIEW = 8;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-5 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <LaneTile lane="you" count={tally.needs_you} onClick={() => sectionRefs.current.you?.scrollIntoView({ behavior: "smooth" })}>
          <span className="flex items-center gap-2 text-meta tabular-nums">
            {TRIAGE_ASKS.map((a) => (
              <span key={a} className={ASK_TEXT[a]} title={askWord(a)}>{tally[a]} {askWord(a).toLowerCase()}</span>
            ))}
          </span>
        </LaneTile>
        <LaneTile lane="agent" count={tally.agent} onClick={() => sectionRefs.current.agent?.scrollIntoView({ behavior: "smooth" })} />
        <LaneTile lane="parked" count={tally.parked} onClick={() => sectionRefs.current.parked?.scrollIntoView({ behavior: "smooth" })} />
        <LaneTile lane="settled" count={tally.settled} onClick={() => sectionRefs.current.settled?.scrollIntoView({ behavior: "smooth" })} />
        <div className="ml-auto flex items-center gap-1">
          <Segmented value={scope} options={[["mine", "Mine"], ["team", "Team"]]} onChange={setScope} />
          <button
            type="button"
            aria-pressed={compare}
            onClick={() => setCompare((v) => !v)}
            className={`rounded-md px-2.5 py-1 text-sm ${compare ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-muted hover:text-sol-text"}`}
          >
            Compare {movedCount > 0 && <span className="tabular-nums text-sol-text-dim">{movedCount}</span>}
          </button>
        </div>
      </div>

      {compare && changedMoves.length > 0 && (
        <div data-triage-moves className="flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-sol-bg-alt px-3 py-2 text-meta">
          {changedMoves.map((m) => (
            <span key={`${m.from}>${m.to}`} className="tabular-nums text-sol-text-muted">
              {TODAY_SECTION_WORD[m.from] ?? m.from} → <span className="text-sol-text">{SECTION_WORD[m.to]}</span> {m.count}
            </span>
          ))}
        </div>
      )}

      {live.sections.pinned.length > 0 && (
        <Section title="Pinned" count={live.sections.pinned.length} lead={<span className="h-1.5 w-1.5 rounded-full bg-sol-magenta" />}>
          {live.sections.pinned.map(renderRow)}
        </Section>
      )}

      <Section refCb={(el) => { sectionRefs.current.you = el; }} title={laneWord("you")} count={live.sections.you.length} lead={<SessionStatusMark status={LANE_STATUS.you} markId="triage.you" labeled />} empty="Nothing needs you">
        {TRIAGE_ASKS.map((ask) => {
          const rows = live.sections.you.filter((r) => r.triage.ask === ask);
          if (!rows.length) return null;
          return (
            <div key={ask} className="flex flex-col">
              <div className={`flex items-center gap-2 px-2 pb-0.5 pt-2 text-meta font-medium ${ASK_TEXT[ask]}`}>
                <SessionStatusMark status={ASK_STATUS[ask]} markId={`triage.${ask}`} size={9} labeled />
                {askWord(ask)}
                <span className="tabular-nums text-sol-text-dim">{rows.length}</span>
              </div>
              {rows.map(renderRow)}
            </div>
          );
        })}
      </Section>

      <Section refCb={(el) => { sectionRefs.current.agent = el; }} title={laneWord("agent")} count={live.sections.agent.length} lead={<SessionStatusMark status={LANE_STATUS.agent} markId="triage.agent" labeled />} empty="No agent is running">
        {live.sections.agent.map(renderRow)}
      </Section>

      <Section refCb={(el) => { sectionRefs.current.parked = el; }} title={laneWord("parked")} count={live.sections.parked.length} lead={<SessionStatusMark status={LANE_STATUS.parked} markId="triage.parked" labeled />} empty="Nothing is parked">
        {live.sections.parked.map(renderRow)}
      </Section>

      <Section refCb={(el) => { sectionRefs.current.settled = el; }} title={laneWord("settled")} count={settledRows.length} lead={<SessionStatusMark status={LANE_STATUS.settled} markId="triage.settled" labeled />} empty="Nothing settled">
        {(settledAll ? settledRows : settledRows.slice(0, SETTLED_PREVIEW)).map(renderRow)}
        {settledRows.length > SETTLED_PREVIEW && (
          <button type="button" onClick={() => setSettledAll((v) => !v)} className="self-start px-2 py-1 text-meta text-sol-text-muted hover:text-sol-text">
            {settledAll ? "Show fewer" : `Show ${settledRows.length - SETTLED_PREVIEW} more`}
          </button>
        )}
      </Section>

      <div className="flex flex-col gap-2 border-t border-sol-border pt-4">
        <div className="flex items-center gap-1">
          {(["snoozed", "stashed", "retired"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={openShelf === k}
              onClick={() => setOpenShelf((v) => (v === k ? null : k))}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ${openShelf === k ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-muted hover:text-sol-text"}`}
            >
              {SECTION_WORD[k]} <span className="tabular-nums text-sol-text-dim">{live.sections[k].length}</span>
            </button>
          ))}
        </div>
        {openShelf && <div className="flex flex-col">{live.sections[openShelf].map(renderRow)}</div>}
      </div>

      <ContextMenu state={menu}>
        {({ session, isForeign }) => (
          <SessionMenuItems session={session} isForeign={isForeign} onOpen={() => open(session._id)} onKill={() => killWithNotice(session._id)} />
        )}
      </ContextMenu>
    </div>
  );
}

function LaneTile({ lane, count, onClick, children }: { lane: "you" | "agent" | "parked" | "settled"; count: number; onClick: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      data-lane-tile={lane}
      onClick={onClick}
      className="flex min-w-[7.5rem] flex-col items-start gap-0.5 rounded-lg border border-sol-border px-3 py-2 text-left hover:bg-sol-bg-alt"
    >
      <span className={`flex items-center gap-1.5 text-meta font-medium ${LANE_TEXT[lane]}`}>
        <SessionStatusMark status={LANE_STATUS[lane]} markId={`triage.${lane}`} size={9} labeled />
        {laneWord(lane)}
      </span>
      <span className="text-xl font-semibold tabular-nums text-sol-text">{count}</span>
      {children}
    </button>
  );
}

function Section({ title, count, lead, children, empty, refCb }: { title: string; count: number; lead: ReactNode; children: ReactNode; empty?: string; refCb?: (el: HTMLElement | null) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section ref={refCb} className="flex flex-col">
      <button type="button" onClick={() => setCollapsed((v) => !v)} className="flex h-7 items-center gap-2 px-2 text-left">
        <span className="flex shrink-0 items-center">{lead}</span>
        <span className="text-mark font-semibold uppercase tracking-[0.08em] text-sol-text-muted">{title}</span>
        <span className="text-mark tabular-nums text-sol-text-dim">{count}</span>
        <ChevronDown aria-hidden className={`h-3.5 w-3.5 text-sol-text-dim transition-transform ${collapsed ? "-rotate-90" : ""}`} />
      </button>
      {!collapsed && (count === 0 && empty ? <div className="px-2 py-1.5 text-sm text-sol-text-dim">{empty}</div> : children)}
    </section>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center rounded-md border border-sol-border p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`rounded px-2 py-0.5 text-meta ${value === v ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-muted hover:text-sol-text"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

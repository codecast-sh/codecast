"use client";

/**
 * Chapter 1, Inbox: the desk's rail and the inbox list, drawn by the app's own
 * rail primitives and SessionCardView from ../fixtures/desk.ts. The lead's row
 * lands on top and takes the selection; the two workers the lead spawns in
 * chapter 3 land under it. A row mounts at its cue and drops in, and the rows
 * under it glide down to make room (glideOver in ../fixtures/desk.ts).
 *
 * Poster chapter: this module renders in the prerender, so nothing it mounts
 * may read the app's store (inbox.poster.test.tsx).
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeft, Plus } from "lucide-react";
import { NotificationBellButton } from "@/components/NotificationBell";
import { ViewerFaces } from "@/components/presence/ViewerFaces";
import { SearchField } from "@/components/search/SearchField";
import { TeamSwitcherButton } from "@/components/TeamSwitcher";
import { TopbarButton } from "@/components/TopbarButton";
import { InboxViewMenu } from "@/components/InboxViewMenu";
import { SectionHeader } from "@/components/inbox/SectionHeader";
import { SessionCardView, type SessionCardChrome } from "@/components/inbox/SessionCardView";
import { InboxNavRow, NeedsInputCount, type SectionRowSpec } from "@/components/sidebar/navPrimitives";
import { ChatNavSectionView, FeedNavRowView, QuestionsNavRowView, SidebarNavView, ThreadsNavRowView } from "@/components/sidebar/SidebarNav";
import { AnchorAvatar } from "@/components/anchor/AnchorIdentity";
import { agentName } from "@/hooks/useSyncAnchors";
import { projectDotClass } from "@/lib/projectColors";
import { useLabelColor } from "@/lib/labelColors";
import { FilmGrow } from "../film";
import { fly, useFilmTime } from "../filmClock";
import { clamp, fade, SEAM_GHOST } from "../timeline";
import { apiWorkerPhase, holdIndex, inboxRows, leadMessages, leadRow, workerRow, DESK, INBOX_SECTIONS, WORKER_HOST } from "../fixtures/desk";
import { CUES, PEOPLE, SESSIONS } from "../fixtures/story";
import { RAIL, RAIL_ACTIVE, TEAM_CHIP, TEAMMATES } from "../fixtures/inbox";
import { PREV } from "../fixtures/conversation";
import type { PartProps } from "./contract";

const CHROME: SessionCardChrome = { showModelBadge: false, showAgentIcon: true, showBranchPill: true, personifyAll: false };
const IDLE = { isLive: false, pendingSend: false, restarting: false, draft: "" };
const LIVE = { ...IDLE, isLive: true };
const noop = () => {};
/** How long before a spawned worker's row lands its room starts to open (s): the room is open by the time the row drops into it, so it never draws over the row under it. */
const ROW_ROOM = 0.5;

const PROJECTS = ["billing", "gateway", "web", "infra"];
const PREV_ID = PREV.id;

/** The window's top bar: the team, who is online, session search, and the bell with the ask that is waiting. */
export function DeskTopBar(_: PartProps) {
  const unread = useFilmTime((t) => (apiWorkerPhase(t) === "asking" ? 2 : 1));
  return (
    <div className="flex h-full items-center gap-3 border-b border-black/10 bg-sol-bg px-3">
      <div className="flex items-center gap-2">
        <TopbarButton aria-label="Toggle sidebar"><PanelLeft /></TopbarButton>
        <TeamSwitcherButton team={TEAM_CHIP} label={TEAM_CHIP.name} tabIndex={-1} />
        <ViewerFaces members={TEAMMATES} size={20} />
      </div>
      <div className="flex min-w-0 flex-1 justify-center">
        <SearchField value="" expanded={false} onChange={noop} />
      </div>
      <div className="flex items-center gap-0.5">
        <TopbarButton aria-label="New session"><Plus /></TopbarButton>
        <NotificationBellButton active={false} unreadCount={unread} />
      </div>
    </div>
  );
}

/** The rail: the app's own three groups, with the counts the film moves (needs input, the decision in the queue). */
export function DeskRail(_: PartProps) {
  // The cursor e2e asks from the start; the API worker waits on its question until it is answered.
  const needsInput = useFilmTime((t) => (apiWorkerPhase(t) === "asking" ? 2 : 1));
  const [projectsOpen, setProjectsOpen] = useState(false);
  const colorOf = useLabelColor();
  const projects: SectionRowSpec[] = PROJECTS.map((name) => ({
    id: `hero-p-${name}`,
    name,
    icon: <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${projectDotClass({ title: name }, colorOf)}`} />,
    active: false,
    onSelect: noop,
  }));
  const shut = { items: [], expanded: false, onToggle: noop };
  return (
    <nav data-sv-nav className="h-full w-full flex flex-col bg-sol-bg-alt select-none text-sol-text">
      {/* Live for the Projects chevron: the rows are links, which the sandbox keeps inert. */}
      <div data-sidebar-scroll data-hero-live className="flex-1 overflow-hidden pt-4">
        <SidebarNavView
          isNarrow={false}
          inbox={<InboxNavRow active isNarrow={false} badge={<NeedsInputCount n={needsInput} />} />}
          threads={<ThreadsNavRowView isActive={false} isNarrow={false} unread={0} />}
          feed={<FeedNavRowView team={TEAM_CHIP} isActive={false} isNarrow={false} unread={RAIL.feedUnread} />}
          // The decision's queue entry opens its own room in the rail and closes it once answered, so the rows under it glide.
          questions={
            <FilmGrow at={CUES.decisionAsked} until={CUES.decisionAnswered} dur={0.45}>
              <QuestionsNavRowView isActive={false} isNarrow={false} pending={1} />
            </FilmGrow>
          }
          chat={<ChatNavSectionView isActive={false} isNarrow={false} channels={RAIL.chatUnread} mentions={0} expanded={false} onToggle={noop} />}
          active={RAIL_ACTIVE}
          projects={{ items: projects, expanded: projectsOpen, onToggle: () => setProjectsOpen((v) => !v) }}
          tasks={shut}
          docs={shut}
          orgOn
          agent={{ label: agentName(null), title: agentName(null), icon: <AnchorAvatar anchor={null} size={20} className="flex-shrink-0" /> }}
        />
      </div>
    </nav>
  );
}

/**
 * The inbox list in its default grouped view: Needs Input, Done, then
 * Working, where the lead lands on top and its workers nest under it from
 * their spawn cues. Clicking a row selects it and the star toggles, locally,
 * until the camera moves on.
 */
export function InboxList({ now }: PartProps) {
  const hold = useFilmTime(holdIndex);
  return <InboxListAt key={hold} now={now} />;
}

/** The open session as the film moves: the first row's (open in the pane as the film starts), then the lead's, then the cloud worker's, then the first row's again as the film comes home (timeline.ts SEAM_GHOST). */
const SELECTIONS = [
  { at: -Infinity, id: PREV_ID },
  { at: CUES.leadSelected, id: SESSIONS.lead.id },
  { at: CUES.remoteOpen, id: SESSIONS.api.id },
  { at: SEAM_GHOST.from, id: PREV_ID },
] as const;
/** As the film comes home, the rows it added (faded out just before, inbox.motion.ts) close their room, so the list is its opening self by the time the seam's copy shows. */
const HOME = SEAM_GHOST.from;
const SELECT_DUR = 0.3;

/** How selected a row is at t: the selection passes from one row to the next over SELECT_DUR, one fading out as the other fades in. */
function selectedness(id: string, t: number): number {
  let w = 0;
  SELECTIONS.forEach((s, i) => {
    const k = s.at === -Infinity ? 1 : fade(clamp((t - s.at) / SELECT_DUR));
    if (s.id === id) w += k;
    const prev = SELECTIONS[i - 1];
    if (prev?.id === id) w -= k;
  });
  return clamp(w);
}

/**
 * A row the film selects and lets go of: its own selected state fading in
 * over its resting one, so the treatment passes between rows without a jump.
 * The selected card's thicker accent border sets its content a few px right
 * of the resting card's, so the two copies glide together across the fade
 * (the resting one toward the selected one's place, the selected one from the
 * resting one's), and the text never shows doubled.
 */
function FilmSelected({ id, render }: { id: string; render: (active: boolean) => ReactNode }) {
  const w = useFilmTime((t) => Math.round(selectedness(id, t) * 30) / 30);
  const mid = w > 0 && w < 1;
  const wrap = useRef<HTMLDivElement>(null);
  const [dx, setDx] = useState(0);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!mid || !el) return;
    const text = (n: Element | undefined) => (n ? [...n.querySelectorAll("*")].find((c) => c.children.length === 0 && c.textContent?.trim()) : undefined);
    const [a, b] = [text(el.children[0]), text(el.children[1])];
    const box = el.getBoundingClientRect();
    if (!a || !b || box.width === 0) return;
    const d = ((b.getBoundingClientRect().left - a.getBoundingClientRect().left) * el.offsetWidth) / box.width;
    setDx((v) => (Math.abs(v - d) > 0.1 ? d : v));
  }, [mid]);
  return (
    <div ref={wrap} className="relative">
      <div style={mid ? { transform: `translateX(${(dx * w).toFixed(2)}px)` } : undefined}>{render(w >= 1)}</div>
      {mid && (
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ opacity: w, transform: `translateX(${(-dx * (1 - w)).toFixed(2)}px)` }}>
          {render(true)}
        </div>
      )}
    </div>
  );
}

function InboxListAt({ now }: PartProps) {
  const messages = useFilmTime(leadMessages);
  const steered = useFilmTime((t) => t >= DESK.steerSent);
  const leadIn = useFilmTime((t) => t >= CUES.leadLands && t < HOME);
  const apiPhase = useFilmTime(apiWorkerPhase);
  const [picked, setPicked] = useState<string | null>(null);
  const [starred, setStarred] = useState<Record<string, boolean>>({});
  const rows = inboxRows(now);

  // Until a visitor picks a row, the film's selection moves between rows (FilmSelected); a pick is the app's own, at once.
  const card = (session: ReturnType<typeof leadRow>, live: boolean, extra?: { isUnread?: boolean; runHost?: (typeof rows)[number]["runHost"] }) =>
    picked === null && SELECTIONS.some((s) => s.id === session._id) ? (
      <FilmSelected id={session._id} render={(active) => cardView(session, live, active, extra)} />
    ) : (
      cardView(session, live, picked === session._id, extra)
    );
  const cardView = (session: ReturnType<typeof leadRow>, live: boolean, active: boolean, extra?: { isUnread?: boolean; runHost?: (typeof rows)[number]["runHost"] }) => (
    <SessionCardView
      session={session}
      isActive={active}
      isFavorite={!!starred[session._id]}
      sessionLabel={null}
      now={now}
      chrome={CHROME}
      liveness={live ? LIVE : IDLE}
      viewerId={PEOPLE.me.id}
      author={null}
      viewers={[]}
      spawnedByTitle={session.is_subagent ? SESSIONS.lead.title : null}
      anchorIdentity={null}
      isUnread={extra?.isUnread}
      runHost={extra?.runHost}
      onSelect={(s) => setPicked(s._id)}
      onToggleFavorite={(id) => setStarred((m) => ({ ...m, [id]: !m[id] }))}
      onPin={noop}
      onStash={noop}
    />
  );
  const row = (i: number) => (
    <div key={rows[i].session._id} {...fly(`desk/inbox.row:${i}`)}>
      {card(rows[i].session, rows[i].isLive, rows[i])}
    </div>
  );

  return (
    <div data-sv-rail className="h-full w-full flex flex-col bg-sol-bg-alt overflow-hidden border-x border-sol-border/30">
      <div className="cc-panel__head min-w-0">
        <div className="flex items-center flex-shrink-0 ml-auto gap-0.5 rounded-md border border-sol-border/40 p-px">
          <InboxViewMenu value="grouped" onChange={noop} hasLabels={false} hasPlans={false} hasTriggers={false} />
        </div>
      </div>
      <div data-hero-live className="flex flex-col">
        {INBOX_SECTIONS.map((sec) => {
          const working = sec.key === "working";
          return (
            <div key={sec.key}>
              <SectionHeader label={sec.label} count={sec.rows.length + (working && leadIn ? 1 : 0)} color={sec.color} sectionKey={sec.key} collapsed={false} />
              {/* Each newcomer opens its own room (FilmGrow), so the rows under it glide down rather than jump. */}
              {working && <FilmGrow at={CUES.leadLands - ROW_ROOM} until={HOME} dur={0.42}><div {...fly("desk/inbox.row:lead")}>{card(leadRow(now, messages, steered), true)}</div></FilmGrow>}
              {working && <FilmGrow at={CUES.workerRowA - ROW_ROOM} until={HOME} dur={0.42}><div {...fly("desk/inbox.row:api")}>{card(workerRow(now, "api", apiPhase), apiPhase !== "asking", { runHost: WORKER_HOST.api })}</div></FilmGrow>}
              {working && <FilmGrow at={CUES.workerRowB - ROW_ROOM} until={HOME} dur={0.42}><div {...fly("desk/inbox.row:ui")}>{card(workerRow(now, "ui", "working"), true)}</div></FilmGrow>}
              {working ? <div {...fly("desk/inbox.rows")}>{sec.rows.map(row)}</div> : sec.rows.map(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

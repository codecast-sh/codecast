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

import { useState } from "react";
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
import { fly, useFilmTime } from "../filmClock";
import { apiWorkerPhase, holdIndex, inboxRows, leadMessages, leadRow, workerRow, DESK, INBOX_SECTIONS, WORKER_HOST } from "../fixtures/desk";
import { CUES, PEOPLE, SESSIONS } from "../fixtures/story";
import { RAIL, RAIL_ACTIVE, TEAM_CHIP, TEAMMATES } from "../fixtures/inbox";
import type { PartProps } from "./contract";

const CHROME: SessionCardChrome = { showModelBadge: false, showAgentIcon: true, showBranchPill: true, personifyAll: false };
const IDLE = { isLive: false, pendingSend: false, restarting: false, draft: "" };
const LIVE = { ...IDLE, isLive: true };
const noop = () => {};

const PROJECTS = ["billing", "gateway", "web", "infra"];

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
  // The cursor e2e asks from the start; the API worker asks between the permission cues.
  const needsInput = useFilmTime((t) => (apiWorkerPhase(t) === "asking" ? 2 : 1));
  const questions = useFilmTime((t) => (t >= CUES.decisionAsked && t < CUES.decisionAnswered ? 1 : 0));
  const [projectsOpen, setProjectsOpen] = useState(false);
  const projects: SectionRowSpec[] = PROJECTS.map((name) => ({
    id: `hero-p-${name}`,
    name,
    icon: <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${projectDotClass({ title: name })}`} />,
    active: false,
    onSelect: noop,
  }));
  const shut = { items: [], expanded: false, onToggle: noop };
  return (
    <nav data-sv-nav className="h-full w-full flex flex-col bg-sol-bg-alt select-none text-sol-text">
      <div data-sidebar-scroll data-hero-live className="flex-1 overflow-hidden pt-4">
        <SidebarNavView
          isNarrow={false}
          inbox={<InboxNavRow active isNarrow={false} badge={<NeedsInputCount n={needsInput} />} />}
          threads={<ThreadsNavRowView isActive={false} isNarrow={false} unread={0} />}
          feed={<FeedNavRowView team={TEAM_CHIP} isActive={false} isNarrow={false} unread={RAIL.feedUnread} />}
          questions={questions > 0 ? <QuestionsNavRowView isActive={false} isNarrow={false} pending={questions} /> : null}
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

function InboxListAt({ now }: PartProps) {
  const messages = useFilmTime(leadMessages);
  const steered = useFilmTime((t) => t >= DESK.steerSent);
  const leadIn = useFilmTime((t) => t >= CUES.leadLands);
  const selected = useFilmTime((t) => (t >= CUES.remoteOpen ? SESSIONS.api.id : t >= CUES.leadSelected ? SESSIONS.lead.id : null));
  const workers = useFilmTime((t) => (t >= CUES.workerRowB ? 2 : t >= CUES.workerRowA ? 1 : 0));
  const apiPhase = useFilmTime(apiWorkerPhase);
  const [picked, setPicked] = useState<string | null>(null);
  const [starred, setStarred] = useState<Record<string, boolean>>({});
  const rows = inboxRows(now);
  const active = picked ?? selected;

  const card = (session: ReturnType<typeof leadRow>, live: boolean, extra?: { isUnread?: boolean; runHost?: (typeof rows)[number]["runHost"] }) => (
    <SessionCardView
      session={session}
      isActive={active === session._id}
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
              {working && leadIn && <div {...fly("desk/inbox.row:lead")}>{card(leadRow(now, messages, steered), true)}</div>}
              {working && workers >= 1 && <div {...fly("desk/inbox.row:api")}>{card(workerRow(now, "api", apiPhase), apiPhase !== "asking", { runHost: WORKER_HOST.api })}</div>}
              {working && workers >= 2 && <div {...fly("desk/inbox.row:ui")}>{card(workerRow(now, "ui", "working"), true)}</div>}
              {working ? <div {...fly("desk/inbox.rows")}>{sec.rows.map(row)}</div> : sec.rows.map(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

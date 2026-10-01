"use client";

/**
 * Chapter 1, Inbox: the desk's rail and the inbox list, drawn by the app's own
 * rail primitives and SessionCardView from ../fixtures/desk.ts. The lead's row
 * lands on top and takes the selection; the two workers the lead spawns in
 * chapter 3 land under it. Every row is always mounted: a row waits invisible
 * in its place until its cue, and the rows under it ride a `push` beat up over
 * that space, so the film is a pure function of time.
 *
 * Poster chapter: this module renders in the prerender, so nothing it mounts
 * may read the app's store (inbox.poster.test.tsx).
 */

import { useState } from "react";
import { FolderGit2, FolderKanban, Workflow, Zap } from "lucide-react";
import type { InboxViewMode } from "@/store/inboxStore";
import { InboxViewMenu } from "@/components/InboxViewMenu";
import { SectionHeader } from "@/components/inbox/SectionHeader";
import { SessionCardView, type SessionCardChrome } from "@/components/inbox/SessionCardView";
import { InboxNavRow, NavSection, NeedsInputCount, RailHeading, type SectionRowSpec } from "@/components/sidebar/navPrimitives";
import { DocsNavIcon, SessionsNavIcon, TasksNavIcon } from "@/components/sidebar/navIcons";
import { projectDotClass } from "@/lib/projectColors";
import { fly, useFilmTime } from "../filmClock";
import { apiWorkerPhase, holdIndex, inboxRows, leadMessages, leadRow, workerRow, DESK } from "../fixtures/desk";
import { CUES, PEOPLE, SESSIONS } from "../fixtures/story";
import type { PartProps } from "./contract";
import { DeskRouter } from "./desk";

const CHROME: SessionCardChrome = { showModelBadge: false, showAgentIcon: true, showBranchPill: true, personifyAll: false };
const IDLE = { isLive: false, pendingSend: false, restarting: false, draft: "" };
const LIVE = { ...IDLE, isLive: true };
const noop = () => {};

const PROJECTS = ["billing", "gateway", "web", "infra"];

/** The rail: Inbox with its needs-input count, then the Work and Agents groups. */
export function DeskRail(_: PartProps) {
  // The cursor e2e asks from the start; the API worker asks between the permission cues.
  const needsInput = useFilmTime((t) => (apiWorkerPhase(t) === "asking" ? 2 : 1));
  const [projectsOpen, setProjectsOpen] = useState(true);
  const projects: SectionRowSpec[] = PROJECTS.map((name) => ({
    id: `hero-p-${name}`,
    name,
    icon: <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${projectDotClass({ title: name })}`} />,
    active: false,
    onSelect: noop,
  }));
  return (
    <DeskRouter>
      <nav data-sv-nav className="h-full w-full pt-4 pb-4 flex flex-col bg-sol-bg-alt select-none text-sol-text">
        <RailHeading label="Conversations" isNarrow={false} />
        <div className="text-sm">
          <InboxNavRow active isNarrow={false} badge={<NeedsInputCount n={needsInput} />} />
        </div>
        <RailHeading label="Work" isNarrow={false} />
        <div className="text-sm" data-hero-live>
          <NavSection
            label="Projects"
            href="/projects"
            isActive={false}
            isNarrow={false}
            items={projects}
            expanded={projectsOpen}
            onToggle={() => setProjectsOpen((v) => !v)}
            icon={<FolderKanban className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
          />
          <NavSection label="Tasks" href="/tasks" isActive={false} isNarrow={false} icon={<TasksNavIcon />} />
          <NavSection label="Docs" href="/docs" isActive={false} isNarrow={false} icon={<DocsNavIcon />} />
          <NavSection label="Code" href="/repo" isActive={false} isNarrow={false} icon={<FolderGit2 className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />} />
        </div>
        <RailHeading label="Agents" isNarrow={false} />
        <div className="text-sm">
          <NavSection label="Sessions" href="/sessions" isActive={false} isNarrow={false} icon={<SessionsNavIcon />} />
          <NavSection label="Workflows" href="/routines" isActive={false} isNarrow={false} icon={<Workflow className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />} />
          <NavSection label="Triggers" href="/triggers" isActive={false} isNarrow={false} icon={<Zap className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />} />
        </div>
      </nav>
    </DeskRouter>
  );
}

/**
 * The inbox list, flat and newest first ("By updated"): the six sessions the
 * film opens on, the lead on top of them from `leadLands`, and the workers
 * under the lead from their spawn cues. Clicking a row selects it and the
 * star toggles, locally, until the camera moves on.
 */
export function InboxList({ now }: PartProps) {
  const hold = useFilmTime(holdIndex);
  return <InboxListAt key={hold} now={now} />;
}

function InboxListAt({ now }: PartProps) {
  const messages = useFilmTime(leadMessages);
  const steered = useFilmTime((t) => t >= DESK.steerSent);
  const leadIn = useFilmTime((t) => t >= CUES.leadLands);
  const selected = useFilmTime((t) => t >= CUES.leadSelected);
  const workers = useFilmTime((t) => (t >= CUES.workerRowB ? 2 : t >= CUES.workerRowA ? 1 : 0));
  const apiPhase = useFilmTime(apiWorkerPhase);
  const [view, setView] = useState<InboxViewMode>("recent");
  const [picked, setPicked] = useState<string | null>(null);
  const [starred, setStarred] = useState<Record<string, boolean>>({});
  const rows = inboxRows(now);
  const active = picked ?? (selected ? SESSIONS.lead.id : null);

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

  return (
    <DeskRouter>
      <div data-sv-rail className="h-full w-full flex flex-col bg-sol-bg-alt overflow-hidden border-x border-sol-border/30">
        <div className="cc-panel__head min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-sol-text-dim">Inbox</span>
          <div data-hero-live className="flex items-center flex-shrink-0 ml-auto gap-0.5 rounded-md border border-sol-border/40 p-px">
            <InboxViewMenu value={view} onChange={setView} hasLabels={false} hasPlans={false} hasTriggers={false} />
          </div>
        </div>
        <SectionHeader label="All" count={rows.length + (leadIn ? 1 : 0) + workers} color="text-sol-cyan" sectionKey="all" collapsed={false} />
        <div data-hero-live className="flex flex-col">
          <div {...fly("desk/inbox.row:lead")}>{card(leadRow(now, messages, steered), leadIn)}</div>
          <div {...fly("desk/inbox.row:api")}>{card(workerRow(now, "api", apiPhase), workers >= 1 && apiPhase !== "asking")}</div>
          <div {...fly("desk/inbox.row:ui")}>{card(workerRow(now, "ui", "working"), workers >= 2)}</div>
          <div {...fly("desk/inbox.rows")}>
            {rows.map((r, i) => (
              <div key={r.session._id} {...fly(`desk/inbox.row:${i}`)}>
                {card(r.session, r.isLive, r)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </DeskRouter>
  );
}

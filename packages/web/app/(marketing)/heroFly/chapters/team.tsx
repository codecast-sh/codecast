"use client";

/**
 * Chapter 9, Team: the #eng channel with the lead session answering a
 * teammate, the huddle beside it with live captions, then the org chart with
 * the billing role over the sessions it runs. Real chat, huddle and org views
 * fed from ../fixtures/team.ts; film time decides which lines have landed.
 */

import { useMemo, useState, type SyntheticEvent } from "react";
import { ChatChannelRail } from "@/components/chat/ChatChannelRail";
import { ChatMessage } from "@/components/chat/ChatMessage";
import type { ChatChannelView, ChatMessageView, ChatReaction } from "@/components/chat/chatTypes";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { FaceCircle } from "@/components/calls/FaceCircle";
import { buildPassages, type EventRow } from "@/components/calls/roomThreadModel";
import { EventLine, PassageBlock, RecapCard } from "@/components/calls/RoomThreadRows";
import { FeedCard } from "@/components/ActivityFeed";
import { OrgGraph } from "@/components/org/OrgGraph";
import { CursorArrow } from "@/components/presence/CursorArrow";
import "@/components/calls/faces.css";
import type { PartProps } from "./contract";
import { fly } from "../filmClock";
import { CHANNELS, CHAT_PEOPLE, FEED, HUDDLE, MESSAGES, REACTIONS, TEAM, orgTree } from "../fixtures/team";
import { PEOPLE, SESSIONS } from "../fixtures/story";
import { useFilmTime } from "../filmClock";

const noop = () => {};
const EMPTY = new Set<string>();
const KNOWN = new Set([PEOPLE.me.handle, PEOPLE.sarah.handle, PEOPLE.maya.handle]);
const SELF = new Set([PEOPLE.me.handle]);
const NAMES = new Map([[PEOPLE.me.handle, PEOPLE.me.name], [PEOPLE.sarah.handle, PEOPLE.sarah.name], [PEOPLE.maya.handle, PEOPLE.maya.name]]);
const MAYA_MEMBER = [{ _id: PEOPLE.maya.id, name: PEOPLE.maya.name, image: CHAT_PEOPLE.maya.avatarUrl }];

/** How far the channel has got: one step per cue passed. */
const CHAT_CUES = [TEAM.ask, TEAM.thinking, TEAM.reply, TEAM.reactA, TEAM.reactB, TEAM.typing, TEAM.followUp];
const stepAt = (cues: readonly number[]) => (t: number) => cues.filter((c) => t >= c).length;

/** Only a reaction pill reaches its handler; the rest of a line (links, pills, the author) stays inert. */
function onlyReactions(e: SyntheticEvent) {
  if (!(e.target instanceof Element) || !e.target.closest(".ch-reaction")) e.stopPropagation();
}

function ChannelLine({ m, now, step, grouped }: { m: (typeof MESSAGES)[number]; now: number; step: number; grouped: boolean }) {
  const [mineToggled, setMineToggled] = useState<Record<string, boolean>>({});
  const answered = "answered" in m && step >= CHAT_CUES.indexOf(m.answered) + 1;
  const reactions: ChatReaction[] | undefined = m.who === "lead" && answered
    ? REACTIONS.filter((r) => step >= CHAT_CUES.indexOf(r.cue) + 1 || mineToggled[r.emoji]).map((r) => {
      const landed = step >= CHAT_CUES.indexOf(r.cue) + 1;
      const mine = !!mineToggled[r.emoji];
      return { emoji: r.emoji, count: (landed ? 1 : 0) + (mine ? 1 : 0), mine };
    }).filter((r) => r.count > 0)
    : undefined;
  const view: ChatMessageView = {
    id: m.id,
    author: CHAT_PEOPLE[m.who],
    content: "answered" in m && !answered ? "" : m.content,
    createdAt: now - m.ago,
    mentionRefs: "mentionRefs" in m ? [...m.mentionRefs] : undefined,
    agentStatus: "answered" in m ? (answered ? "done" : "thinking") : undefined,
    reactions,
  };
  return (
    <div data-hero-live="" onClickCapture={onlyReactions} className="[&_.ch-tools]:hidden" {...fly(`team/team.msg:${m.id}`)}>
      <ChatMessage
        message={view}
        grouped={grouped}
        knownHandles={KNOWN}
        selfHandles={SELF}
        handleNames={NAMES}
        now={now}
        onReact={(_, emoji) => setMineToggled((s) => ({ ...s, [emoji]: !s[emoji] }))}
      />
    </div>
  );
}

function Channel({ now }: { now: number }) {
  const step = useFilmTime(stepAt(CHAT_CUES));
  const landed = MESSAGES.filter((m) => !("cue" in m) || step >= CHAT_CUES.indexOf(m.cue) + 1);
  const typing = step >= CHAT_CUES.indexOf(TEAM.typing) + 1 && step < CHAT_CUES.indexOf(TEAM.followUp) + 1;
  return (
    <div className="ch-main">
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden pb-1">
        {landed.map((m, i) => (
          <ChannelLine key={m.id} m={m} now={now} step={step} grouped={i > 0 && landed[i - 1].who === m.who} />
        ))}
      </div>
      <div className="flex h-7 shrink-0 items-center px-4">{typing && <TypingIndicator members={MAYA_MEMBER} />}</div>
    </div>
  );
}

const HUDDLE_CUES = [...TEAM.turns];

function Huddle({ now }: { now: number }) {
  const said = useFilmTime(stepAt(HUDDLE_CUES));
  const start = now - HUDDLE.startedAgo;
  const passage = useMemo(() => {
    const segments = HUDDLE.segments.slice(0, Math.max(1, said)).map((s, i) => {
      const who = PEOPLE[s.who];
      return { seq: i, speaker_id: who.id, speaker_name: who.name, text: s.text, t0: s.t0, t1: s.t0 + 5000, at: start + s.t0 };
    });
    return buildPassages(segments)[0];
  }, [said, start]);
  const speaking = said > 0 ? PEOPLE[HUDDLE.segments[said - 1].who].id : null;
  const joined: EventRow = {
    _id: "hero-ev-1",
    user_id: PEOPLE.me.id,
    user_name: PEOPLE.me.name,
    text: "",
    at: start + 20_000,
    mine: false,
    event: "agent_joined",
    agent: { conversation_id: SESSIONS.lead.id, short_id: SESSIONS.lead.shortId, title: SESSIONS.lead.title, agent_type: SESSIONS.lead.agent },
  };
  return (
    <div className="flex h-full flex-col px-4 pt-5">
      <div className="faces-row mb-5 justify-start">
        {HUDDLE.people.map((p, i) => (
          <div key={p.id} {...fly(`team/team.face:${i}`)}>
            <FaceCircle person={p} diameter={58} speaking={speaking === p.id} shown onPointerDown={noop} onPointerUp={noop} />
          </div>
        ))}
      </div>
      <div {...fly("team/team.thread")}>
        <RecapCard summary="Walking through the webhook retry change before it ships." items={[]} live />
        <EventLine row={joined} me={null} ownRoomId={null} ended={false} explain fresh={false} dayOf={start} onOpen={noop} />
        {said > 0 && (
          <PassageBlock passage={passage} idPrefix="hero-huddle" open live fresh={false} recording={false} dayOf={start} onToggle={noop} />
        )}
      </div>
    </div>
  );
}

function Feed({ now }: { now: number }) {
  return (
    <div className="space-y-1.5 p-3 pt-4">
      {FEED.map((c) => (
        <FeedCard key={c._id} conv={{ ...c, updated_at: now - c.ago, author_avatar: null } as any} showActor onNavigate={noop} />
      ))}
    </div>
  );
}

function Org({ now }: { now: number }) {
  const tree = useMemo(() => orgTree(now), [now]);
  const view = useMemo(() => ({ collapsed: EMPTY, expanded: {} }), []);
  return (
    <div className="pointer-events-none relative h-full w-full">
      <OrgGraph
        tree={tree}
        view={view}
        selectedId={null}
        loadingClusters={EMPTY}
        showMiniMap={false}
        onSelect={noop}
        onToggleCollapse={noop}
        onExpandCluster={noop}
        onCollapseCluster={noop}
        onReparentRequest={noop}
        onNodeContextMenu={noop}
        canDrag={() => false}
        chrome={false}
      />
      <div {...fly("team/team.cursor", { position: "absolute", left: 262, top: 205 })}>
        <CursorArrow color="var(--sol-green)" label={PEOPLE.sarah.name.split(" ")[0]} />
      </div>
    </div>
  );
}

export function TeamScene({ now }: PartProps) {
  const orgOn = useFilmTime((t) => t >= TEAM.org - 0.05);
  return (
    <div className="ch-shell relative">
      <div className="pointer-events-none flex shrink-0">
        <ChatChannelRail channels={CHANNELS as ChatChannelView[]} activeChannelId={CHANNELS[0].id} onSelect={noop} showDms={false} />
      </div>
      <Channel now={now} />
      <div className="relative w-[360px] shrink-0 border-l border-sol-border/30 bg-sol-bg-alt/30">
        <div className="absolute inset-0" {...fly("team/team.feed")}>
          <Feed now={now} />
        </div>
        <div className="absolute inset-0" {...fly("team/team.huddle")}>
          <Huddle now={now} />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[14px] border border-sol-border/60 bg-sol-bg shadow-2xl shadow-black/20" {...fly("team/team.org")}>
        {orgOn && <Org now={now} />}
      </div>
    </div>
  );
}

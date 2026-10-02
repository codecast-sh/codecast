"use client";

/**
 * Chapter 9, Team: the #eng channel with the lead session answering a
 * teammate, and the huddle beside it with live captions. Real chat and
 * huddle views fed from ../fixtures/team.ts; film time decides which lines
 * have landed.
 */

import { Fragment, useMemo, useState, type SyntheticEvent } from "react";
import { ChatChannelRail } from "@/components/chat/ChatChannelRail";
import { ChatMessage } from "@/components/chat/ChatMessage";
import type { ChatChannelView, ChatMessageView, ChatReaction } from "@/components/chat/chatTypes";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { FaceCircle } from "@/components/calls/FaceCircle";
import { LiveRoomLabel } from "@/components/calls/LiveRoomLabel";
import { TranscribeSwitchView } from "@/components/calls/TranscribeSwitchView";
import { buildPassages, type EventRow } from "@/components/calls/roomThreadModel";
import { EventLine, PassageBlock, RecapCard } from "@/components/calls/RoomThreadRows";
import { FeedCard } from "@/components/ActivityFeed";
import "@/components/calls/faces.css";
import type { PartProps } from "./contract";
import { fly } from "../filmClock";
import { CHANNELS, CHAT_PEOPLE, FEED, HUDDLE, MESSAGES, REACTIONS, TEAM } from "../fixtures/team";
import { PEOPLE, SESSIONS } from "../fixtures/story";
import { useFilmTime } from "../filmClock";
import { FilmGrow, FilmSwap } from "../film";

const noop = () => {};
const KNOWN = new Set([PEOPLE.me.handle, PEOPLE.sarah.handle, PEOPLE.maya.handle]);
const SELF = new Set([PEOPLE.me.handle]);
const NAMES = new Map([[PEOPLE.me.handle, PEOPLE.me.name], [PEOPLE.sarah.handle, PEOPLE.sarah.name], [PEOPLE.maya.handle, PEOPLE.maya.name]]);
const MAYA_MEMBER = [{ _id: PEOPLE.maya.id, name: PEOPLE.maya.name, image: CHAT_PEOPLE.maya.avatarUrl }];
/** The huddle's room as the live-room rows name it. */
const ROOM = { label: `#${CHANNELS[0].name} huddle`, locked: false, redacted: false } as Parameters<typeof LiveRoomLabel>[0]["row"];

/** How far the channel has got: one step per cue passed. */
const CHAT_CUES = [TEAM.ask, TEAM.thinking, TEAM.reply, TEAM.reactA, TEAM.reactB, TEAM.typing, TEAM.followUp];
const stepAt = (cues: readonly number[]) => (t: number) => cues.filter((c) => t >= c).length;
const chatStep = stepAt(CHAT_CUES);
/** The channel's step for the agent's reply after `s` of its own changes (answered, then each reaction): its line is drawn from these, not from the channel's step, so lines landing under it never redraw it. */
const replyStep = (answered: number, s: number) => chatStep([answered, TEAM.reactA, TEAM.reactB][s - 1] ?? answered - 1e-3);

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
    <div data-hero-live="" onClickCapture={onlyReactions} className="[&_.ch-tools]:hidden">
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
  const step = useFilmTime(chatStep);
  const landed = MESSAGES.filter((m) => !("cue" in m) || step >= CHAT_CUES.indexOf(m.cue) + 1);
  const typing = step >= CHAT_CUES.indexOf(TEAM.typing) + 1 && step < CHAT_CUES.indexOf(TEAM.followUp) + 1;
  return (
    <div className="ch-main">
      {/* The channel reads from its foot: its oldest line runs under the top edge, as a scrolled channel does. */}
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden pb-1">
        {landed.map((m, i) => {
          const grouped = i > 0 && landed[i - 1].who === m.who;
          // The agent's reply fills in where it thought, and its reactions land under it: each state dissolves over the last as the line's height eases.
          const line = "answered" in m
            ? <FilmSwap cues={[m.answered, TEAM.reactA, TEAM.reactB]} render={(s) => <ChannelLine m={m} now={now} step={replyStep(m.answered, s)} grouped={grouped} />} />
            : <ChannelLine m={m} now={now} step={step} grouped={grouped} />;
          const flown = <div {...fly(`team/team.msg:${m.id}`)}>{line}</div>;
          // A line that arrives opens its own room, so the lines above it ease up rather than jump.
          return "cue" in m ? <FilmGrow key={m.id} at={m.cue}>{flown}</FilmGrow> : <Fragment key={m.id}>{flown}</Fragment>;
        })}
      </div>
      <div className="flex h-7 shrink-0 items-center px-4">{typing && <TypingIndicator members={MAYA_MEMBER} />}</div>
    </div>
  );
}

const HUDDLE_CUES = [...TEAM.turns];
const saidAt = stepAt(HUDDLE_CUES);
/** The huddle column's own ground (bg-sol-bg-alt/30 over the page), opaque, for what dissolves in over its thread. */
const HUDDLE_GROUND = "bg-[color-mix(in_srgb,var(--sol-bg-alt)_30%,var(--sol-bg))]";

function Huddle({ now }: { now: number }) {
  const said = useFilmTime(saidAt);
  const start = now - HUDDLE.startedAgo;
  // The passage after each caption, built once: the thread draws whichever its crossing needs.
  const passages = useMemo(() => HUDDLE.segments.map((_, n) => {
    const segments = HUDDLE.segments.slice(0, n + 1).map((s, i) => {
      const who = PEOPLE[s.who];
      return { seq: i, speaker_id: who.id, speaker_name: who.name, text: s.text, t0: s.t0, t1: s.t0 + 5000, at: start + s.t0 };
    });
    return buildPassages(segments)[0];
  }, []), [start]);
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
    <div className="flex h-full flex-col px-4 pt-4">
      {/* The room, and the switch that says it is live: every word lands in the thread below. */}
      <div className="mb-4 flex items-center gap-2 text-[12px] text-sol-text">
        <LiveRoomLabel row={ROOM} className="font-medium" />
        <TranscribeSwitchView on onToggle={noop} className="ml-auto" />
      </div>
      <div className="faces-row mb-5 justify-start">
        {HUDDLE.people.map((p, i) => (
          <div key={p.id} {...fly(`team/team.face:${i}`)}>
            <FaceCircle person={p} diameter={58} speaking={speaking === p.id} shown standalone onPointerDown={noop} onPointerUp={noop} />
          </div>
        ))}
      </div>
      {/* The thread reads from its foot, like the room's own: the newest caption always sits whole in view. */}
      <div {...fly("team/team.thread")} className="flex min-h-0 flex-1 flex-col justify-end overflow-clip pb-3">
        <RecapCard summary="Reviewing the retry change." items={[]} live />
        <EventLine row={joined} me={null} ownRoomId={null} ended={false} explain fresh={false} dayOf={start} onOpen={noop} />
        {/* Each caption dissolves in under the last as the thread's height eases, so the lines above rise rather than jump. */}
        <FilmSwap
          cues={HUDDLE_CUES}
          ground={HUDDLE_GROUND}
          render={(n) => n > 0 && <PassageBlock passage={passages[n - 1]} idPrefix="hero-huddle" open live fresh={false} recording={false} dayOf={start} onToggle={noop} />}
        />
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

export function TeamScene({ now }: PartProps) {
  return (
    <div className="ch-shell relative">
      <div className="pointer-events-none flex shrink-0">
        <ChatChannelRail channels={CHANNELS as ChatChannelView[]} activeChannelId={CHANNELS[0].id} onSelect={noop} showDms={false} standalone />
      </div>
      <Channel now={now} />
      {/* 300px, so the channel beside it keeps an agent's reply header (its title, "via" its person, the time) on one line. */}
      <div className="relative w-[300px] shrink-0 border-l border-sol-border/30 bg-sol-bg-alt/30">
        <div className="absolute inset-0" {...fly("team/team.feed")}>
          <Feed now={now} />
        </div>
        <div className="absolute inset-0" {...fly("team/team.huddle")}>
          <Huddle now={now} />
        </div>
      </div>
    </div>
  );
}

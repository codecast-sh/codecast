// The calls surface of the Acme world: yesterday's #eng huddle "Webhook retry
// backoff" between Alex, Maya and Sarah, finished, with its summary, action
// items, speaker-labeled transcript and the room's thread (a typed question to
// the Webhook retries session and its answer). The calls page reads the list
// and the detail through transcripts:webListCalls / webGetCall, the thread
// through callChat:list. Mobile's Metro reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { DECISION_SESSIONS, openableOnly } from "./decisions";
import { CAPTIONS, HOUR, HUDDLE_ROOM, MIN, PEOPLE, TEAM_ID, cid, session } from "./world";

export const CALL_ID = cid("callbackoff");
export const CALL_SHORT = "cl-218";
export const CALL_TITLE = "Webhook retry backoff";
const ROOM = "channel:hero-ch-eng";
/** Yesterday afternoon, 14 minutes long. */
const STARTED_AGO = 22 * HOUR;
const LENGTH = 14 * MIN;

export const CALL_SUMMARY =
  "Failed webhooks retry with exponential backoff capped at one hour, eight attempts, then a dead-letter queue support can replay from. Maya's replay of last week's failures showed 96% delivered by the fifth attempt. Sarah wants on-call paged only for customers on an SLA.";

export const CALL_ACTIONS = [
  "Alex: build the retry queue with exponential backoff, capped at 1 hour (ct-4182)",
  "Maya: dead-letter queue with a replay button for support (ct-4184)",
  "Sarah: page on-call when an SLA customer's webhook dead-letters (ct-4185)",
];

const who = { me: PEOPLE.me, maya: PEOPLE.maya, sarah: PEOPLE.sarah };
type Who = keyof typeof who;

/** The words, in order: [speaker, seconds into the call, text]. */
const LINES: [Who, number, string][] = [
  ["me", 4, "Okay, webhook retries. Support lost two Stripe events overnight because we never retry a failed delivery."],
  ["maya", 15, "I replayed last week's failures, 1,284 of them, under a fixed schedule and under exponential backoff."],
  ["maya", 26, "Exponential with jitter got 96% delivered by the fifth attempt. Fixed every five minutes got 91, and a short blip waits the full five minutes."],
  ["sarah", 41, "How long does exponential keep going before it gives up?"],
  ["me", 47, "Two, four, eight seconds, doubling up to an hour between attempts. Eight attempts, then it lands in dead letters."],
  ["sarah", 58, "Fine by me, as long as the cap is an hour. I don't want an endpoint that's down getting hit all night."],
  ["maya", 72, "Agreed on exponential, capped at one hour. Support needs a way to replay what dead-letters."],
  ["me", 81, "Maya, can you take the dead-letter queue and the replay button? I'll build the retry queue."],
  ["maya", 88, "Yes, I'll take it."],
  ["sarah", 96, "And let's page on-call only for the customers on an SLA. Everyone else goes to billing-alerts in the morning."],
  ["me", 108, "Makes sense. Sarah, that one's yours. I'll file all three."],
];

const segments = (start: number) =>
  LINES.map(([w, s, text], i) => {
    const next = LINES[i + 1]?.[1] ?? s + 8;
    return { seq: i + 1, speaker_id: who[w]._id, speaker_name: who[w].name, text, t0: s * 1000, t1: (next - 1) * 1000, at: start + s * 1000 };
  });

const row = (now: number) => {
  const start = now - STARTED_AGO;
  return {
    _id: CALL_ID,
    short_id: CALL_SHORT,
    room_key: ROOM,
    status: "ended",
    idle_since: null,
    started_at: start,
    ended_at: start + LENGTH,
    title: CALL_TITLE,
    participants: [who.me, who.maya, who.sarah].map((p) => ({ id: p._id, name: p.name })),
    summary: CALL_SUMMARY,
    action_items: CALL_ACTIONS,
    summary_status: "done",
    transcribe_status: null,
    last_seq: LINES.length,
    started_by: PEOPLE.me._id,
    team_id: TEAM_ID,
    rec_shared: false,
    filmed: false,
  };
};

const RETRIES = DECISION_SESSIONS.retries;
const AGENT = { conversation_id: RETRIES._id, short_id: RETRIES.short_id, title: RETRIES.title, agent_type: RETRIES.agent_type, name: RETRIES.title, character_avatar: null, character_name: null };

/** The room's thread during the call: Alex asks the Webhook retries session, it answers. */
const thread = (now: number) => {
  const start = now - STARTED_AGO;
  return [
    { _id: cid("callchat1"), user_id: PEOPLE.me._id, user_name: PEOPLE.me.name, user_image: PEOPLE.me.image, text: `@${RETRIES.short_id} how many of last week's failures would a one-hour cap still deliver?`, at: start + 52_000, mine: true, transcript_id: CALL_ID, agent: null, event: null },
    { _id: cid("callchat2"), user_id: PEOPLE.me._id, user_name: AGENT.name, text: "All but 9 of the 1,284. Those 9 were endpoints that stayed down for more than a day, and they land in dead letters either way.", at: start + 64_000, mine: false, transcript_id: CALL_ID, agent: AGENT, event: null },
  ].map((r) => ({ ...r, attachments: undefined, event_reason: null, event_guest_name: null, event_run_id: null, event_span: null }));
};

/** A call named in prose (transcripts webGetCallRef): the pill, or with seqs the excerpt card's turns. */
function callRef(a: { ref?: string; from_seq?: number; to_seq?: number }) {
  const ref = String(a?.ref ?? "").trim().toLowerCase();
  if (ref !== CALL_SHORT && ref !== CALL_ID) return null;
  const now = Date.now();
  const { _id, short_id, room_key, status, started_at, ended_at, title, participants, summary } = row(now);
  const lean = { _id, short_id, room_key, status, started_at, ended_at, title, participants, summary };
  if (a.from_seq === undefined) return { ...lean, turns: null };
  const from = Math.min(a.from_seq, a.to_seq ?? a.from_seq);
  const to = Math.max(a.from_seq, a.to_seq ?? a.from_seq);
  return { ...lean, turns: { from_seq: from, to_seq: to, more: false, segments: segments(now - STARTED_AGO).filter((x) => x.seq >= from && x.seq <= to) } };
}

const detail = (now: number) => ({
  ...row(now),
  share_token: null,
  can_share_link: true,
  recording_url: null,
  routes: [],
  sessions: [],
  guests: [],
  segments: segments(now - STARTED_AGO),
});

/** A session asked what the huddle agreed: it answers with the call and the two lines that settled it. */
export const RECAP_SESSION = { _id: cid("scallrecap"), short_id: "jx7c9rq", title: "Retry policy recap", agent_type: "claude_code" };

/** The transcript lines (seq) where Maya and Sarah settled the cap. */
const AGREED = LINES.findIndex(([w, , t]) => w === "maya" && t.startsWith("Agreed")) + 1;

const RECAP_TRANSCRIPT = (now: number) => [
  { _id: "hero-cr-m1", role: "user", content: "What did we agree on yesterday's call about the webhook retries?", timestamp: now - 3 * MIN },
  {
    _id: "hero-cr-m2",
    role: "assistant",
    content: `On ${CALL_SHORT} you settled on exponential backoff, capped at one hour between attempts. Sarah set the cap and Maya agreed:\n\n${CALL_SHORT}:${AGREED - 1}-${AGREED}\n\nMaya took the dead-letter queue and its replay button, and Sarah took paging on-call for SLA customers.`,
    timestamp: now - 2 * MIN,
  },
];

/* ── The live #eng huddle (the core's LIVE_ROOMS), joined from this window ── */

export const LIVE_ID = cid("calllive");
const LIVE_STARTED = 6 * MIN;

/** The live words so far, oldest first, ending on the core's captions. */
const liveSegments = (now: number) => {
  const start = now - LIVE_STARTED;
  const early: [Who, number, string][] = [
    ["maya", 20, "The replay numbers are in. Exponential backoff gets 96% of failed webhooks delivered by the fifth try."],
    ["me", 34, "Good. The retry queue is in review, I'll ask the session what's left."],
  ];
  const head = early.map(([w, s, text], i) => ({ seq: i + 1, speaker_id: who[w]._id, speaker_name: who[w].name, text, t0: s * 1000, t1: (s + 9) * 1000, at: start + s * 1000 }));
  const tail = CAPTIONS(now).tail.map((c, i) => ({ seq: head.length + i + 1, speaker_id: c.speaker_id, speaker_name: c.speaker_name, text: c.text, t0: c.at - start, t1: c.at - start + 5000, at: c.at }));
  return [...head, ...tail];
};

const liveRoutes = [{ kind: "session", target: RETRIES._id, mode: "live", added_by: PEOPLE.me._id }];

const liveDetail = (now: number) => ({
  ...row(now),
  _id: LIVE_ID,
  short_id: "cl-219",
  room_key: HUDDLE_ROOM,
  status: "live",
  started_at: now - LIVE_STARTED,
  ended_at: null,
  title: null,
  summary: null,
  action_items: [],
  summary_status: null,
  started_by: PEOPLE.sarah._id,
  share_token: null,
  can_share_link: true,
  recording_url: null,
  routes: liveRoutes,
  sessions: [],
  guests: [],
  segments: liveSegments(now),
});

/** The live room's thread: Alex asks the Webhook retries session, it answers as an agent. */
const liveThread = (now: number) =>
  [
    { _id: cid("livechat1"), user_id: PEOPLE.me._id, user_name: PEOPLE.me.name, user_image: PEOPLE.me.image, text: `@${RETRIES.short_id} what's left before the retry queue can ship?`, at: now - 3 * MIN, mine: true, agent: null },
    { _id: cid("livechat2"), user_id: PEOPLE.me._id, user_name: AGENT.name, text: "Two tests on the one-hour cap, then review. PR #482 is up; I'll post in #eng when it merges.", at: now - 2 * MIN - 30_000, mine: false, agent: AGENT },
  ].map((r) => ({ ...r, transcript_id: LIVE_ID, attachments: undefined, event: null, event_reason: null, event_guest_name: null, event_run_id: null, event_span: null }));

const seat = (p: { _id: string; name: string; image: string }, joinedAgo: number, now: number) => ({ user_id: p._id, user_name: p.name, user_image: p.image, muted: false, joined_at: now - joinedAgo });

export const CALLS_PART: AcmePart = {
  name: "calls",
  seed: (s, now) => {
    (globalThis as any).__acmeScene = {
      ...(globalThis as any).__acmeScene,
      /** Alex in the live #eng huddle with Sarah and Maya: the seats, and this window's call connected. */
      huddle() {
        const st = (globalThis as any).__inboxStore?.getState?.() ?? s;
        const t = Date.now();
        st.syncTable("callOccupancy", { [HUDDLE_ROOM]: [seat(PEOPLE.sarah, LIVE_STARTED, t), seat(PEOPLE.me, 4 * MIN, t), seat(PEOPLE.maya, 5 * MIN, t)] });
        st.setCallState({ phase: "connected", roomKey: HUDDLE_ROOM, muted: false, micDenied: false });
      },
    };
    openableOnly(s, [session(now, RECAP_SESSION, { ago: 2 * MIN, waiting: "done", project: "~/src/billing", messages: 2, state: "Answered what the retry huddle agreed" })]);
    s.applyTailMessages(RECAP_SESSION._id, 0, RECAP_TRANSCRIPT(now) as any, null);
  },
  answers: {
    "transcripts:webListCalls": () => [row(Date.now())],
    "transcripts:webGetCall": (a) => (a?.transcript_id === CALL_ID ? detail(Date.now()) : a?.transcript_id === LIVE_ID ? liveDetail(Date.now()) : null),
    "transcripts:webGetCallRef": callRef,
    "callChat:list": (a) => (a?.transcript_id === CALL_ID ? thread(Date.now()) : a?.room_key === HUDDLE_ROOM ? liveThread(Date.now()) : []),
    // The live huddle's words, its transcript and the session it hears (the core's captions, with the room's ids).
    "transcripts:getLive": () => {
      const now = Date.now();
      return { ...CAPTIONS(now), transcript_id: LIVE_ID, started_at: now - LIVE_STARTED, team_id: TEAM_ID, routes: liveRoutes };
    },
  },
};

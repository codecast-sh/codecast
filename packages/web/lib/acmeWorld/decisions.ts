// The decisions surface of the Acme world: the Webhook retries session parked
// on how failed webhooks retry, two more open questions from the sessions
// around it (dead letters, alerting), and the workers the session split its
// research across. The viewer's queue answers through the stub
// (sessionDecisions:listForUser), so its feeder writes the store the way the
// server's rows do. Mobile's Metro reaches this file, so imports stay relative.

import { formatDecisionAnswer } from "@codecast/shared/contracts/decisionAnswers";
import type { AcmePart } from "./parts";
import { MIN, PEOPLE, TEAM_ID, WORKSPACE, cid, session } from "./world";

export const DECISION_SESSIONS = {
  retries: { _id: cid("sretries"), short_id: "jx7r2kd", title: "Webhook retries", agent_type: "claude_code" },
  queue: { _id: cid("squeueworker"), short_id: "jx7q8mt", title: "Retry queue worker", agent_type: "claude_code" },
  hooksApi: { _id: cid("shooksapi"), short_id: "jx7w4hn", title: "Webhook retries API", agent_type: "codex" },
  reviewer: { _id: cid("sretriesreview"), short_id: "jx7v6pc", title: "Review the retry schedule", agent_type: "codex" },
  tests: { _id: cid("sretriestests"), short_id: "jx7t3ga", title: "Write retry schedule tests", agent_type: "claude_code" },
  research: { _id: cid("sretriesresearch"), short_id: "jx7s9fe", title: "Research provider retry policies", agent_type: "claude_code" },
  deadLetters: { _id: cid("sdeadletters"), short_id: "jx7d5lq", title: "Dead-letter queue", agent_type: "claude_code" },
  alerting: { _id: cid("salerting"), short_id: "jx7a7lt", title: "Alert on dead letters", agent_type: "claude_code" },
} as const;

const S = DECISION_SESSIONS;

/** The backoff question the Webhook retries session parks on (also the phone's decision shots). */
export const BACKOFF_DECISION_ID = cid("decbackoff");
export const BACKOFF = {
  question: "Retry failed webhooks with exponential backoff or a fixed schedule?",
  options: [
    { label: "Exponential backoff, capped at 1 hour", description: "Waits 2s, 4s, 8s and up to an hour between attempts, then dead-letters after 8. Rides out a ledger restart without hammering it." },
    { label: "Fixed schedule, every 5 minutes", description: "12 attempts over an hour. Simpler to explain to support, but a short outage waits the full 5 minutes for its first retry." },
  ],
};

const BACKOFF_CONTEXT = `Support found two Stripe events dropped overnight. Both failed on a 502 while the ledger restarted, and nothing tried them again.

I replayed last week's 1,284 failed deliveries under both schedules:

- **Exponential, capped at 1 hour:** 96% delivered by the fifth attempt, median 14s.
- **Fixed, every 5 minutes:** 91% delivered by the fifth attempt, median 5 min.

Either one fixes the dropped events. The difference is how fast a short blip recovers and how hard we hit an endpoint that is down.`;

type Row = Record<string, unknown> & { _id: string };

const decision = (now: number, d: { id: string; short: string; s: { _id: string; title: string }; project: string; question: string; context: string; options: { label: string; description: string }[]; blocking: boolean; ago: number; default_option?: number; category: string }): Row => ({
  _id: d.id,
  short_id: d.short,
  conversation_id: d.s._id,
  session_id: `${d.s._id}-sess`,
  user_id: PEOPLE.me._id,
  question: d.question,
  context_md: d.context,
  options: d.options,
  kind: "single",
  category: d.category,
  blocking: d.blocking,
  ...(d.default_option !== undefined ? { default_option: d.default_option } : {}),
  status: "pending",
  holder: { kind: "user", id: PEOPLE.me._id },
  holder_key: `user:${PEOPLE.me._id}`,
  asked_user_ids: [PEOPLE.me._id],
  passed_to: null,
  in_queue: true,
  team_id: TEAM_ID,
  workspace: WORKSPACE,
  session_title: d.s.title,
  project_path: d.project,
  created_at: now - d.ago,
  updated_at: now - d.ago,
  asked_message_count: 14,
  problem_severity: null,
});

export const DECISIONS = (now: number): Row[] => [
  decision(now, {
    id: BACKOFF_DECISION_ID,
    short: "sd-4101",
    s: S.retries,
    project: "~/src/billing",
    question: BACKOFF.question,
    context: BACKOFF_CONTEXT,
    options: BACKOFF.options,
    blocking: true,
    ago: 4 * MIN,
    category: "product",
  }),
  decision(now, {
    id: cid("decdeadletter"),
    short: "sd-4102",
    s: S.deadLetters,
    project: "~/src/billing",
    question: "Keep dead-lettered webhooks for 7 days or 30?",
    context: "An event that fails every attempt lands in the dead-letter queue with its last response. Support replays from there. Last month 41 events were dead-lettered; the oldest replay was 9 days after the failure.",
    options: [
      { label: "30 days", description: "Covers every replay support made last month. About 2 MB of storage." },
      { label: "7 days", description: "Matches the log retention, but the 9-day-old replay would have been gone." },
    ],
    blocking: false,
    default_option: 0,
    ago: 9 * MIN,
    category: "product",
  }),
  decision(now, {
    id: cid("decalerting"),
    short: "sd-4103",
    s: S.alerting,
    project: "~/src/billing",
    question: "Page on-call when a webhook dead-letters, or post to #billing-alerts?",
    context: "A dead-lettered webhook means a customer missed an event. Paging wakes someone for each one; a channel post batches them for the morning.",
    options: [
      { label: "Post to #billing-alerts", description: "One message per hour with every dead-lettered event. Nobody is woken up." },
      { label: "Page on-call", description: "Each dead letter pages within a minute. Last month that would have been 41 pages." },
      { label: "Page only for enterprise customers", description: "Pages for the 12 accounts on an SLA, posts the rest to the channel." },
    ],
    blocking: true,
    ago: 22 * MIN,
    category: "product",
  }),
];

const t = (now: number, minsAgo: number) => now - minsAgo * MIN;
const call = (id: string, name: string, input: unknown) => ({ id, name, input: JSON.stringify(input) });
const result = (id: string, content: string) => ({ tool_use_id: id, content });

/** Webhook retries: Alex's ask, two workers delegated by name, their reports, one combined answer, then the decision. */
export const RETRIES_TRANSCRIPT = (now: number) => [
  {
    _id: "hero-rt-m1",
    role: "user",
    content: "Failed webhooks get dropped after one try. Find out how retries should work here: split the research between two workers, one on how Stripe and GitHub retry, one writing tests for our delivery path. Come back with one answer.",
    timestamp: t(now, 48),
  },
  {
    _id: "hero-rt-m2",
    role: "assistant",
    content: "Splitting it in two. One worker reads how the big providers retry, the other writes tests that pin down what our delivery path does today.",
    tool_calls: [
      call("hero-rt-tc1", "Bash", { command: `cast spawn --subagent -- "Research how Stripe, GitHub and Shopify retry failed webhooks: schedule, cap, and when they give up."` }),
      call("hero-rt-tc2", "Bash", { command: `cast spawn --subagent -- "Write tests for src/billing/deliver.ts that pin down what happens on a 5xx, a 429 and a timeout."` }),
    ],
    tool_results: [result("hero-rt-tc1", `Spawned ${S.research.short_id}`), result("hero-rt-tc2", `Spawned ${S.tests.short_id}`)],
    timestamp: t(now, 47),
  },
  {
    _id: "hero-rt-m3",
    role: "assistant",
    content: `Two workers are on it: ${S.research.short_id} reads the provider policies and ${S.tests.short_id} writes the delivery tests. I'll combine their results when both report.`,
    timestamp: t(now, 46),
  },
  {
    _id: "hero-rt-m4",
    role: "user",
    content: `<session-message from="${S.research.short_id}" name="${S.research.title}" subagent="true">\nStripe retries for 3 days with exponential backoff, GitHub does not retry at all, Shopify retries 8 times over 4 hours. All three sign payloads and give up into a log the sender can replay from.\n</session-message>`,
    timestamp: t(now, 31),
  },
  {
    _id: "hero-rt-m5",
    role: "user",
    content: `<session-message from="${S.tests.short_id}" name="${S.tests.title}" subagent="true">\n9 tests in src/billing/deliver.test.ts. Today a 5xx, a 429 and a timeout all drop the event after one attempt; nothing is queued.\n</session-message>`,
    timestamp: t(now, 18),
  },
  {
    _id: "hero-rt-m6",
    role: "assistant",
    content:
      "Both workers are done. The combined answer:\n\n1. **We never retry.** Every failure drops the event on the first attempt, which is how support's two Stripe events were lost.\n2. **Providers retry with backoff and a cap.** Stripe and Shopify both back off exponentially and give up into a replayable log.\n3. **The fix is a retry queue plus a dead-letter queue.** Failed deliveries go to the queue; whatever exhausts its attempts lands in dead letters for support to replay.\n\nThe one open choice is the schedule itself, so I've asked.",
    timestamp: t(now, 6),
  },
  {
    _id: "hero-rt-m7",
    role: "assistant",
    content: "",
    tool_calls: [
      call("hero-rt-tc3", "Bash", {
        command: `cast decide "${BACKOFF.question}" -o "${BACKOFF.options[0].label} :: ${BACKOFF.options[0].description}" -o "${BACKOFF.options[1].label} :: ${BACKOFF.options[1].description}" --context - <<'EOF'\n${BACKOFF_CONTEXT}\nEOF`,
      }),
    ],
    tool_results: [result("hero-rt-tc3", "Queued decision sd-4101")],
    timestamp: t(now, 4),
  },
];

/** Dead-letter queue: still working while its retention question waits on Alex. */
export const DEAD_LETTER_TRANSCRIPT = (now: number) => [
  { _id: "hero-dl-m1", role: "user", content: "Add a dead-letter queue: an event that fails every retry lands there with its last response, and support can replay it.", timestamp: t(now, 16) },
  {
    _id: "hero-dl-m2",
    role: "assistant",
    content: "Adding the dead_letters table next to the retry queue and a replay endpoint for support. I'm going ahead with 30 days of retention; I asked whether 7 is enough and will change it if you say so.",
    tool_calls: [
      call("hero-dl-tc1", "Write", { file_path: "src/billing/deadLetters.ts", content: "export const RETENTION_DAYS = 30;" }),
      call("hero-dl-tc2", "Bash", { command: "bun test src/billing/deadLetters.test.ts" }),
    ],
    tool_results: [result("hero-dl-tc1", "File created successfully at: src/billing/deadLetters.ts"), result("hero-dl-tc2", "6 pass\n0 fail\nRan 6 tests across 1 file. [96ms]")],
    timestamp: t(now, 8),
  },
  { _id: "hero-dl-m3", role: "assistant", content: "Dead letters are stored and replayable. Wiring the replay button into the support dashboard next.", timestamp: t(now, 1) },
];

const sessions = (now: number) => [
  session(now, S.deadLetters, {
    ago: 50_000,
    waiting: "working",
    project: "~/src/billing",
    messages: 9,
    state: "Dead letters stored with their last response\nStatus: wiring replay into the support dashboard",
  }),
  session(now, S.retries, {
    ago: 4 * MIN,
    waiting: "blocked",
    project: "~/src/billing",
    messages: 14,
    state: `Workers reported: we drop every failed webhook on the first try\nBlocked: ${BACKOFF.question}`,
    preview: BACKOFF.question,
  }),
  session(now, S.research, {
    ago: 31 * MIN,
    waiting: "done",
    project: "~/src/billing",
    messages: 22,
    state: "Stripe, GitHub and Shopify retry policies compared\nStatus: reported to Webhook retries",
    extra: { parent_conversation_id: S.retries._id, is_subagent: true },
  }),
  session(now, S.tests, {
    ago: 18 * MIN,
    waiting: "done",
    project: "~/src/billing",
    messages: 31,
    state: "9 delivery tests written\nStatus: reported to Webhook retries",
    extra: { parent_conversation_id: S.retries._id, is_subagent: true },
  }),
  session(now, S.reviewer, {
    ago: 30_000,
    waiting: "working",
    project: "~/src/billing",
    messages: 12,
    state: "Reviewing the retry schedule against the replay\nStatus: 3 of 5 files read",
    extra: { parent_conversation_id: S.retries._id, is_subagent: true },
  }),
];

/** Alex's answer and the agent's next turn: the transcript after the backoff decision is answered. */
export const ANSWERED_TAIL = (now: number) => [
  {
    _id: "hero-rt-m8",
    role: "user",
    content: formatDecisionAnswer({ id: "sd-4101", question: BACKOFF.question, answer: BACKOFF.options[0].label }),
    timestamp: now - 40_000,
  },
  {
    _id: "hero-rt-m9",
    role: "assistant",
    content: "Exponential it is. Building the retry queue: attempts wait 2s, 4s, 8s and double from there up to an hour, with jitter, and an event that fails its eighth attempt goes to dead letters. Writing the schedule tests first.",
    tool_calls: [call("hero-rt-tc4", "Write", { file_path: "src/billing/retrySchedule.test.ts", content: "describe(\"backoff\", () => { /* 2s, 4s, 8s … capped at 1h */ })" })],
    tool_results: [result("hero-rt-tc4", "File created successfully at: src/billing/retrySchedule.test.ts")],
    timestamp: now - 20_000,
  },
];

/** Sessions a shot opens that are not inbox cards, by id: what conversations:getConversation answers. */
const OPENABLE = new Map<string, Record<string, any>>();

/** A session a shot opens that is not an inbox card: its conversation record
 *  (machineSessions.ts resolves the address), and the conversation the pane
 *  asks for to seed a session it does not hold (useMissingSessionLookup),
 *  the way it opens a teammate's session. */
export function openableOnly(s: any, rows: Record<string, any>[]) {
  for (const row of rows) {
    OPENABLE.set(row._id, row);
    s.syncRecord("conversations", row._id, row);
  }
}

/** Scenes a docs shot moves the world into from a step (`__acmeScene.answered()`): real store writes, the same ones a live answer makes. */
function installScenes(s: any) {
  const st = () => (globalThis as any).__inboxStore?.getState?.() ?? s;
  (globalThis as any).__acmeScene = {
    ...(globalThis as any).__acmeScene,
    /** The backoff decision answered with its first option, the answer in the transcript and the agent at work. */
    answered() {
      const now = Date.now();
      const row = DECISIONS(now)[0];
      st().syncRecord("sessionDecisions", row._id, { ...row, status: "answered", answer_index: 0, resolved_at: now - 40_000, answered_by: { kind: "user", id: PEOPLE.me._id } });
      const msgs = [...RETRIES_TRANSCRIPT(now), ...ANSWERED_TAIL(now)].map((m) => ({ ...m, message_uuid: m._id }));
      st().applyTailMessages(S.retries._id, 0, msgs as any, null);
      const live = session(now, S.retries, { ago: 20_000, waiting: "working", project: "~/src/billing", messages: 16, state: "Building the retry queue with exponential backoff\nStatus: writing the schedule tests" });
      st().syncRecord("sessions", S.retries._id, live);
      st().syncRecord("conversations", S.retries._id, live);
    },
    /** Webhook retries parked on its workers (dormant), the question not yet asked. */
    nest() {
      const now = Date.now();
      const row = DECISIONS(now)[0];
      st().syncRecord("sessionDecisions", row._id, { ...row, status: "withdrawn" });
      const parked = session(now, S.retries, { ago: 3 * MIN, waiting: "dormant" as any, project: "~/src/billing", messages: 3, state: "Waiting on two workers: provider research and delivery tests\nNext: combine their results" });
      st().syncRecord("sessions", S.retries._id, parked);
      st().syncRecord("conversations", S.retries._id, parked);
    },
  };
}

/** A decision's page payload (sessionDecisions getWithDoc): the row and its context. None of these has a doc, task or stack. */
function detailOf(id: string) {
  const row = DECISIONS(Date.now()).find((d) => d._id === id || d.short_id === id);
  if (!row) return null;
  const me = { _id: PEOPLE.me._id, name: PEOPLE.me.name, image: PEOPLE.me.image };
  return { decision: row, doc: null, task: null, stack: null, ladder: [], asked_users: [me], holder_role: null, grant_offer: null, grant: null, superseded: null };
}

export const DECISIONS_PART: AcmePart = {
  name: "decisions",
  sessions,
  answers: {
    "sessionDecisions:listForUser": () => DECISIONS(Date.now()),
    "conversations:getConversation": (a) => {
      const row = OPENABLE.get(String(a?.conversation_id));
      return row ? { ...row, user: { name: row.author_name } } : undefined;
    },
    // The Decisions page's Team view: the same open questions, stamped with the workspace they were read from.
    "sessionDecisions:getWithDoc": (a) => detailOf(String(a?.decision_id ?? "")),
    "sessionDecisions:getWithDocMany": (a) => ((a?.decision_ids ?? []) as string[]).map(detailOf).filter(Boolean),
    "decisionTeamList:listForTeam": () => DECISIONS(Date.now()).map((d) => ({ ...d, team_workspace: WORKSPACE })),
  },
  seed: (s, now) => {
    installScenes(s);
    // Held in the store as the queue feed leaves them, so a client that mounts no global feeder (the phone's store shots) has them too.
    s.syncTable("sessionDecisions", DECISIONS(now), { isDelta: true });
    // message_uuid: the fork point its branches (./forks) name.
    s.applyTailMessages(S.retries._id, 0, RETRIES_TRANSCRIPT(now).map((m) => ({ ...m, message_uuid: m._id })) as any, null);
    s.applyTailMessages(S.deadLetters._id, 0, DEAD_LETTER_TRANSCRIPT(now) as any, null);
  },
};

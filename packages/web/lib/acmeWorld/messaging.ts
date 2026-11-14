// Two Acme sessions on different agents trading messages with `cast send`:
// the Retry queue worker (Claude Code) asks the Webhook retries API session
// (Codex) to review its schedule, the API session answers, and the worker
// revises. Each side shows the Message to card it sent and the Message from
// card it received. Mobile's Metro reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { DECISION_SESSIONS, openableOnly } from "./decisions";
import { MIN, session } from "./world";

const QUEUE = DECISION_SESSIONS.queue;
const API = DECISION_SESSIONS.hooksApi;

const t = (now: number, minsAgo: number) => now - minsAgo * MIN;
const call = (id: string, name: string, input: unknown) => ({ id, name, input: JSON.stringify(input) });
const result = (id: string, content: string) => ({ tool_use_id: id, content });
const from = (s: { short_id: string; title: string }, body: string) => `<session-message from="${s.short_id}" name="${s.title}">\n${body}\n</session-message>`;

const ASK_REVIEW = "The retry worker is in: src/billing/retryWorker.ts. It backs off 2s, 4s, 8s, 16s and gives up after 5 attempts. Does that match what POST /v2/hooks/retry promises callers?";
const REVIEW = "Close, but the endpoint promises callers an Idempotency-Key on every attempt, and the worker builds a new key per retry. Reuse the event's key, or a receiver will process the same event twice.";
const THANKS = "Fixed: every attempt now sends the event's own Idempotency-Key. 18 tests green, including a new one for two attempts of the same event.";

export const QUEUE_TRANSCRIPT = (now: number) => [
  { _id: "hero-q-m1", role: "user", content: "Build the worker that drains the retry queue. Check it against the API session's endpoint before you call it done.", timestamp: t(now, 26) },
  {
    _id: "hero-q-m2",
    role: "assistant",
    content: "The worker drains the queue and backs off with jitter. Asking the API session whether the schedule matches what its endpoint promises.",
    tool_calls: [call("hero-q-tc1", "Bash", { command: `cast send ${API.short_id} "${ASK_REVIEW}"` })],
    tool_results: [result("hero-q-tc1", `sent to ${API.short_id}`)],
    timestamp: t(now, 14),
  },
  { _id: "hero-q-m3", role: "user", content: from(API, REVIEW), timestamp: t(now, 9) },
  {
    _id: "hero-q-m4",
    role: "assistant",
    content: "Good catch. A retry has to carry the same Idempotency-Key as the first attempt, so the receiver can drop duplicates. Switching the worker to the event's own key.",
    tool_calls: [
      call("hero-q-tc2", "Edit", { file_path: "src/billing/retryWorker.ts", old_string: "headers: { \"Idempotency-Key\": crypto.randomUUID() }", new_string: "headers: { \"Idempotency-Key\": event.idempotency_key }" }),
      call("hero-q-tc3", "Bash", { command: "bun test src/billing/retryWorker.test.ts" }),
    ],
    tool_results: [result("hero-q-tc2", "The file src/billing/retryWorker.ts has been updated."), result("hero-q-tc3", "18 pass\n0 fail\nRan 18 tests across 1 file. [143ms]")],
    timestamp: t(now, 6),
  },
  {
    _id: "hero-q-m5",
    role: "assistant",
    content: "18 tests green. Telling the API session it's fixed.",
    tool_calls: [call("hero-q-tc4", "Bash", { command: `cast send ${API.short_id} "${THANKS}"` })],
    tool_results: [result("hero-q-tc4", `sent to ${API.short_id}`)],
    timestamp: t(now, 5),
  },
];

export const API_REVIEW_TRANSCRIPT = (now: number) => [
  { _id: "hero-wa-m1", role: "user", content: "Own POST /v2/hooks/retry. Other sessions will ask you about its contract; answer them.", timestamp: t(now, 40) },
  { _id: "hero-wa-m2", role: "user", content: from(QUEUE, ASK_REVIEW), timestamp: t(now, 14) },
  {
    _id: "hero-wa-m3",
    role: "assistant",
    content: "Checking the worker against the endpoint's contract.",
    tool_calls: [call("hero-wa-tc1", "Grep", { pattern: "Idempotency-Key", path: "src/billing" })],
    tool_results: [result("hero-wa-tc1", "src/billing/retryWorker.ts:31: headers: { \"Idempotency-Key\": crypto.randomUUID() }\nsrc/api/hooks.ts:22: requireIdempotencyKey(req)")],
    timestamp: t(now, 11),
  },
  {
    _id: "hero-wa-m4",
    role: "assistant",
    content: "The schedule matches, but the key does not.",
    tool_calls: [call("hero-wa-tc2", "Bash", { command: `cast send ${QUEUE.short_id} "${REVIEW}"` })],
    tool_results: [result("hero-wa-tc2", `sent to ${QUEUE.short_id}`)],
    timestamp: t(now, 9),
  },
  { _id: "hero-wa-m5", role: "user", content: from(QUEUE, THANKS), timestamp: t(now, 5) },
  { _id: "hero-wa-m6", role: "assistant", content: "Confirmed against the endpoint: retries now reuse the event's key. Nothing else to change on my side.", timestamp: t(now, 4) },
];

const sessions = (now: number) => [
  session(now, QUEUE, {
    ago: 5 * MIN,
    waiting: "done",
    project: "~/src/billing",
    messages: 11,
    state: "Retry worker drains the queue with one key per event\nStatus: 18 tests green",
  }),
  session(now, API, {
    ago: 4 * MIN,
    waiting: "done",
    project: "~/src/billing",
    messages: 8,
    state: "Reviewed the retry worker against the endpoint\nStatus: retries reuse the event's key",
  }),
];

export const MESSAGING_PART: AcmePart = {
  name: "messaging",
  // Opened by their shots, never inbox cards of their own.
  seed: (s, now) => {
    openableOnly(s, sessions(now));
    s.applyTailMessages(QUEUE._id, 0, QUEUE_TRANSCRIPT(now) as any, null);
    s.applyTailMessages(API._id, 0, API_REVIEW_TRANSCRIPT(now) as any, null);
  },
};

// Three of Alex's conversations on the backoff half of the webhook work, for
// the conversation screen's docs: one waiting on a staging key (the pinned
// state, sharing a session), one run in OpenCode with a follow-up sent from
// codecast, one started in T3 Code on Claude. Also the message Maya shared
// from her backoff session, for the public message page. Mobile's
// Metro reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { TEAM_SESSIONS } from "./teamSessions";
import { HOUR, MIN, PEOPLE, cid, session } from "./world";

export const CONVERSATIONS = {
  backoff: { _id: cid("sbackoff"), short_id: "jx7b5kf", title: "Webhook retry backoff", agent_type: "claude_code" },
  opencode: { _id: cid("sopencode"), short_id: "jx7o3cd", title: "Add retry backoff to the webhook sender", agent_type: "opencode" },
  t3: { _id: cid("stthree"), short_id: "jx7t3cl", title: "Retry backoff for the webhook sender", agent_type: "claude_code" },
} as const;

/** When each finished session last moved. */
const OPENCODE_AGO = 5 * HOUR;
const T3_AGO = 6 * HOUR;

export const SHARED_MESSAGE_TOKEN = "acme-backoff-answer";

const BACKOFF_STATE = [
  "Backoff is in; the staging run waits on a key",
  "You: add STAGING_API_KEY to .env.staging",
  "Done: backoff schedule · 18 tests green · PR #484 open",
  "Next: run the retry suite against staging",
].join("\n");

const call = (id: string, name: string, input: unknown) => ({ id, name, input: JSON.stringify(input) });
const result = (id: string, content: string) => ({ tool_use_id: id, content });

const SENDER_OLD = "export async function send(event: WebhookEvent) {\n  return deliver(event);\n}";
const SENDER_NEW =
  "export async function send(event: WebhookEvent) {\n  for (let attempt = 1; ; attempt++) {\n    const status = await deliver(event);\n    if (status < 500 && status !== 429) return status;\n    if (attempt === MAX_ATTEMPTS) return deadLetter(event, status);\n    await sleep(backoff(attempt));\n  }\n}";

const BACKOFF_TRANSCRIPT = (now: number) => {
  const t = (m: number) => now - m * MIN;
  return [
    { _id: "hero-bk-m1", role: "user", content: "Give the webhook sender exponential backoff: 2s, 4s, 8s, 16s with jitter, 5 attempts at most. Then run the retry suite against staging.", timestamp: t(26) },
    {
      _id: "hero-bk-m2",
      role: "assistant",
      content: "Reading the sender and its tests first.",
      tool_calls: [call("hero-bk-t1", "Read", { file_path: "src/webhooks/sender.ts" }), call("hero-bk-t2", "Read", { file_path: "src/webhooks/sender.test.ts" })],
      tool_results: [result("hero-bk-t1", SENDER_OLD), result("hero-bk-t2", "describe(\"send\", () => { /* 12 cases */ })")],
      timestamp: t(24),
    },
    {
      _id: "hero-bk-m3",
      role: "assistant",
      content: "send() makes one attempt and gives up. Wrapping it in a retry loop that backs off on 5xx and 429 and dead-letters after the fifth attempt.",
      tool_calls: [
        call("hero-bk-t3", "Edit", { file_path: "src/webhooks/sender.ts", old_string: SENDER_OLD, new_string: SENDER_NEW }),
        call("hero-bk-t4", "Bash", { command: "bun test src/webhooks" }),
      ],
      tool_results: [result("hero-bk-t3", "The file src/webhooks/sender.ts has been updated."), result("hero-bk-t4", "18 pass\n0 fail\nRan 18 tests across 2 files. [212ms]")],
      timestamp: t(12),
    },
    {
      _id: "hero-bk-m4",
      role: "assistant",
      content: "The backoff is in and all 18 tests pass. PR #484 is open.\n\nThe staging run needs `STAGING_API_KEY`, and `.env.staging` doesn't have it. Add the key and I'll run the retry suite against staging.",
      timestamp: t(4),
    },
  ];
};

const OPENCODE_TRANSCRIPT = (now: number) => {
  const t = (m: number) => now - OPENCODE_AGO - (m - 2) * MIN;
  const model = "big-pickle";
  return [
    { _id: "hero-oc-m1", role: "user", content: "The webhook sender gives up after one failed delivery. Add retry backoff: 2s, 4s, 8s, 16s with jitter, 5 attempts at most, and run the tests.", timestamp: t(9) },
    {
      _id: "hero-oc-m2",
      role: "assistant",
      model,
      content: "",
      tool_calls: [
        call("hero-oc-t1", "Read", { file_path: "src/webhooks/sender.ts" }),
        call("hero-oc-t2", "Edit", { file_path: "src/webhooks/sender.ts", old_string: SENDER_OLD, new_string: SENDER_NEW }),
        call("hero-oc-t3", "Bash", { command: "bun test src/webhooks" }),
        call("hero-oc-t4", "Bash", { command: "git diff --stat" }),
      ],
      tool_results: [
        result("hero-oc-t1", SENDER_OLD),
        result("hero-oc-t2", "Edit applied successfully."),
        result("hero-oc-t3", "14 pass\n0 fail\nRan 14 tests across 2 files. [198ms]"),
        result("hero-oc-t4", " src/webhooks/sender.ts | 8 +++++++-\n 1 file changed, 7 insertions(+), 1 deletion(-)"),
      ],
      timestamp: t(8),
    },
    { _id: "hero-oc-m3", role: "assistant", model, content: "Done. `send()` now retries a failed delivery on 5xx and 429, waiting 2s, 4s, 8s and 16s with jitter, and dead-letters the event after the fifth attempt. All 14 tests pass.", timestamp: t(7) },
    { _id: "hero-oc-m4", role: "user", content: "Also cap the backoff at 5 minutes.", timestamp: t(3) },
    {
      _id: "hero-oc-m5",
      role: "assistant",
      model,
      content: "",
      tool_calls: [
        call("hero-oc-t5", "Edit", { file_path: "src/webhooks/backoff.ts", old_string: "return base * 2 ** (attempt - 1) + jitter();", new_string: "return Math.min(base * 2 ** (attempt - 1), MAX_DELAY_MS) + jitter();" }),
        call("hero-oc-t6", "Bash", { command: "bun test src/webhooks" }),
      ],
      tool_results: [result("hero-oc-t5", "Edit applied successfully."), result("hero-oc-t6", "15 pass\n0 fail\nRan 15 tests across 2 files. [203ms]")],
      timestamp: t(2),
    },
    { _id: "hero-oc-m6", role: "assistant", model, content: "Capped. `backoff()` never waits more than `MAX_DELAY_MS` (5 minutes), and a new test covers a delivery that keeps failing. 15 tests pass.", timestamp: t(2) },
  ];
};

const T3_TRANSCRIPT = (now: number) => {
  const t = (m: number) => now - T3_AGO - (m - 1) * MIN;
  return [
    { _id: "hero-t3-m1", role: "user", content: "Add retry backoff to the webhook sender: 2s, 4s, 8s, 16s with jitter, at most 5 attempts. Cover it with a test.", timestamp: t(6) },
    {
      _id: "hero-t3-m2",
      role: "assistant",
      content: "Reading the sender and its tests.",
      tool_calls: [call("hero-t3-t1", "Read", { file_path: "src/webhooks/sender.ts" }), call("hero-t3-t2", "Grep", { pattern: "describe\\(", path: "src/webhooks" })],
      tool_results: [result("hero-t3-t1", SENDER_OLD), result("hero-t3-t2", "src/webhooks/sender.test.ts:4: describe(\"send\", () => {")],
      timestamp: t(5),
    },
    {
      _id: "hero-t3-m3",
      role: "assistant",
      content: "Adding the retry loop and a test that fails the first four deliveries.",
      tool_calls: [
        call("hero-t3-t3", "Edit", { file_path: "src/webhooks/sender.ts", old_string: SENDER_OLD, new_string: SENDER_NEW }),
        call("hero-t3-t4", "Edit", { file_path: "src/webhooks/sender.test.ts", old_string: "describe(\"send\", () => {", new_string: "describe(\"send\", () => {\n  test(\"retries with backoff until the fifth attempt\", async () => {\n    failNext(4);\n    expect(await send(event)).toBe(200);\n    expect(delays()).toEqual([2000, 4000, 8000, 16000]);\n  });" }),
        call("hero-t3-t5", "Bash", { command: "bun test src/webhooks" }),
      ],
      tool_results: [
        result("hero-t3-t3", "The file src/webhooks/sender.ts has been updated."),
        result("hero-t3-t4", "The file src/webhooks/sender.test.ts has been updated."),
        result("hero-t3-t5", "13 pass\n0 fail\nRan 13 tests across 2 files. [190ms]"),
      ],
      timestamp: t(2),
    },
    { _id: "hero-t3-m4", role: "assistant", content: "Done. `send()` retries 5xx and 429 responses with 2s, 4s, 8s and 16s waits plus jitter, and dead-letters an event after its fifth attempt. The new test fails four deliveries and checks the waits; all 13 tests pass.", timestamp: t(1) },
  ];
};

const SHARED_MESSAGE = (now: number) => {
  const conv = TEAM_SESSIONS.backoff;
  const at = now - TEAM_SESSIONS.backoff.ago;
  const question = { _id: cid("shmsgq"), conversation_id: conv._id, role: "user", content: "How long should a failed webhook keep retrying before we give up on it?", timestamp: at - 3 * MIN };
  const answer = {
    _id: cid("shmsga"),
    conversation_id: conv._id,
    role: "assistant",
    content:
      "Five attempts over about half an hour. Wait 2s, 4s, 8s, then 16s, each with up to 20% jitter so retries from one outage don't arrive together. That rides out the ledger's restarts, which last a few minutes, and a delivery that still fails after the fifth attempt goes to the dead-letter queue with its last response.\n\nRetry 5xx, 429 and timeouts. Don't retry a 4xx other than 429: the request itself is wrong, and sending it again can't fix it.",
    timestamp: at,
  };
  return {
    message: answer,
    contextMessages: [question, answer],
    conversation: { _id: conv._id, title: conv.title, project_path: conv.project, agent_type: conv.agent_type },
    conversationShareToken: "acme-backoff-maya",
    user: { name: PEOPLE.maya.name, image: PEOPLE.maya.image },
    note: undefined,
    sharedAt: now - 2 * HOUR,
  };
};

export const CONVERSATIONS_PART: AcmePart = {
  name: "conversations",
  sessions: (now) => [
    session(now, CONVERSATIONS.backoff, {
      ago: 4 * MIN,
      waiting: "blocked",
      project: "~/src/billing",
      messages: 4,
      state: BACKOFF_STATE,
      preview: "add STAGING_API_KEY to .env.staging",
      extra: { is_private: false, team_visibility: "full" },
    }),
    // Finished this morning: they sit at the bottom of Done.
    ...[
      [CONVERSATIONS.opencode, OPENCODE_AGO, 6, "Backoff in the webhook sender, capped at 5 minutes\nStatus: 15 tests green"],
      [CONVERSATIONS.t3, T3_AGO, 4, "Backoff in the webhook sender with a test\nStatus: 13 tests green"],
    ].map(([c, ago, messages, state]: any) =>
      session(now, c, { ago, waiting: "done", project: "~/src/billing", messages, state, extra: { is_private: false, team_visibility: "full" } }),
    ),
  ],
  seed: (s, now) => {
    s.applyTailMessages(CONVERSATIONS.backoff._id, 0, BACKOFF_TRANSCRIPT(now) as any, null);
    s.applyTailMessages(CONVERSATIONS.opencode._id, 0, OPENCODE_TRANSCRIPT(now) as any, null);
    s.applyTailMessages(CONVERSATIONS.t3._id, 0, T3_TRANSCRIPT(now) as any, null);
  },
  answers: {
    "messages:getSharedMessage": (args) => (args?.share_token === SHARED_MESSAGE_TOKEN ? SHARED_MESSAGE(Date.now()) : null),
  },
};

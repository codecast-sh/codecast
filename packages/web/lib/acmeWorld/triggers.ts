// Acme's triggers: the follow-ups and standing duties the webhook retries work
// set. Three recurring (a dead-letter check every 4h, a daily PR summary that
// spawns a fresh run, a paused hourly queue alert), one one-time re-run of
// the integration tests, and an event trigger on review comments for the
// retries PR in Maya's session. The daily one has six runs, each its own
// session. Answered to the trigger feeds (agentTasks.*), whose feeders write
// the store the way server rows do. Mobile's Metro reaches this file, so
// imports stay relative.

import type { AcmePart } from "./parts";
import { DAY, HOUR, MIN, PEOPLE, SESSIONS, cid, session } from "./world";

/** Maya's session on the retries PR review; the event trigger answers in it. */
export const MAYA_REVIEW = { _id: cid("smayareview"), short_id: "jx7p2rv", title: "Review webhook retries PR", agent_type: "claude_code" } as const;

export const TRIGGER_IDS = {
  deadLetter: cid("trdeadletter"),
  summary: cid("trprsummary"),
  retests: cid("trretests"),
  prComments: cid("trprcomments"),
  backlog: cid("trbacklog"),
};

const SUMMARY_PROMPT =
  "Summarize open webhook PRs and what merged yesterday. For each open PR: its checks, review state and what blocks it. Post the summary in #eng.";

/** The daily summary's runs, newest first: each a session it spawned. */
const RUN_DAYS = [0, 1, 2, 3, 4, 5];
export const SUMMARY_RUNS = RUN_DAYS.map((d) => ({
  _id: cid(`srun${d}summary`),
  short_id: `jx7r${d}sm`,
  title: "Summarize open webhook PRs",
  agent_type: "claude_code",
}));

const RUN_SUMMARIES = [
  "2 open PRs, 1 merged yesterday. #482 Retry failed webhooks with backoff is approved and green. #485 Sign webhook payloads with HMAC has integration red and changes requested. #479 Upgrade Stripe SDK to v14 merged.",
  "2 open PRs, none merged. #482 waits on Maya's review; #479 is green.",
  "1 open PR, 2 merged yesterday.",
  "1 open PR, 1 merged yesterday.",
  "No open webhook PRs; 1 merged yesterday.",
  "1 open PR, none merged.",
];

/** 9:00 today, the daily trigger's wall time; tomorrow's when it has passed. */
const nineAm = (now: number) => {
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
};

export const TRIGGERS = (now: number): Array<Record<string, any>> => {
  const lastSummary = nineAm(now) <= now ? nineAm(now) : nineAm(now) - DAY;
  const base = { mode: "apply", agent_type: "claude_code", run_count: 0, project_path: "~/src/billing" };
  return [
    {
      ...base,
      _id: TRIGGER_IDS.deadLetter,
      short_id: "tr-4812",
      title: "Check webhook retry dead-letter queue",
      prompt: "Check the webhook retry dead-letter queue. If anything landed there since the last check, say which endpoints and why, and retry the ones that failed on a 5xx.",
      status: "scheduled",
      schedule_type: "recurring",
      interval_ms: 4 * HOUR,
      run_at: now + 2 * HOUR + 40 * MIN,
      run_count: 9,
      created_at: now - 2 * DAY,
      last_run_at: now - HOUR - 20 * MIN,
      last_run_summary: "Dead-letter queue empty; 3 deliveries retried on attempt 2, all landed.",
      originating_conversation_id: SESSIONS.lead._id,
      originating_conversation_title: SESSIONS.lead.title,
      created_by_conversation_id: SESSIONS.lead._id,
      created_by_conversation_title: SESSIONS.lead.title,
    },
    {
      ...base,
      _id: TRIGGER_IDS.summary,
      short_id: "tr-4815",
      title: "Summarize open webhook PRs",
      prompt: SUMMARY_PROMPT,
      display_summary: "Every morning, lists the open webhook PRs with their checks and reviews, and what merged the day before, and posts it in #eng.",
      mode: "propose",
      status: "scheduled",
      schedule_type: "recurring",
      interval_ms: DAY,
      run_at: lastSummary + DAY,
      run_count: 6,
      project_path: "~/src/acme-api",
      created_at: lastSummary - 6 * DAY + HOUR,
      last_run_at: lastSummary,
      last_run_summary: RUN_SUMMARIES[0],
      last_run_conversation_id: SUMMARY_RUNS[0]._id,
      last_run_conversation_title: SUMMARY_RUNS[0].title,
      created_by_conversation_id: SESSIONS.lead._id,
      created_by_conversation_title: SESSIONS.lead.title,
    },
    {
      ...base,
      _id: TRIGGER_IDS.retests,
      short_id: "tr-4820",
      title: "Re-run retry integration tests",
      prompt: "Re-run the retry integration tests against the real queue and report whether the backoff schedule held.",
      status: "scheduled",
      schedule_type: "once",
      run_at: now + 30 * MIN,
      created_at: now - 2 * MIN,
      originating_conversation_id: SESSIONS.lead._id,
      originating_conversation_title: SESSIONS.lead.title,
      created_by_conversation_id: SESSIONS.lead._id,
      created_by_conversation_title: SESSIONS.lead.title,
    },
    {
      ...base,
      _id: TRIGGER_IDS.prComments,
      short_id: "tr-4817",
      title: "Answer review comments on the webhook retries PR",
      prompt: "A review comment landed on acme/api#482. Read it, make the change if it is right, push, and reply on the thread.",
      status: "scheduled",
      schedule_type: "event",
      event_filter: { event_type: "pull_request_review_comment", action: "created" },
      run_count: 2,
      created_at: now - 3 * HOUR,
      last_run_at: now - 15 * MIN,
      last_run_summary: "Replied on retry.ts:24: a 410 is final and never retries.",
      originating_conversation_id: MAYA_REVIEW._id,
      originating_conversation_title: MAYA_REVIEW.title,
      created_by_conversation_id: MAYA_REVIEW._id,
      created_by_conversation_title: MAYA_REVIEW.title,
      is_own: false,
      owner_name: PEOPLE.maya.name,
    },
    {
      ...base,
      _id: TRIGGER_IDS.backlog,
      short_id: "tr-4809",
      title: "Alert when the retry queue backs up",
      prompt: "Check the retry queue depth. If more than 500 deliveries are waiting, post in #billing-alerts with the top failing endpoints.",
      status: "paused",
      schedule_type: "recurring",
      interval_ms: HOUR,
      run_at: now + 25 * MIN,
      run_count: 14,
      created_at: now - 3 * DAY,
      last_run_at: now - 5 * HOUR,
      last_run_summary: "Queue depth 12; nothing to report.",
      originating_conversation_id: MAYA_REVIEW._id,
      originating_conversation_title: MAYA_REVIEW.title,
      created_by_conversation_id: MAYA_REVIEW._id,
      created_by_conversation_title: MAYA_REVIEW.title,
      is_own: false,
      owner_name: PEOPLE.maya.name,
    },
  ];
};

/** The daily summary's history, newest first, in webListRuns' shape. */
export const SUMMARY_RUN_ROWS = (now: number) => {
  const first = TRIGGERS(now).find((t) => t._id === TRIGGER_IDS.summary)!.last_run_at!;
  return SUMMARY_RUNS.map((r, i) => ({
    _id: r._id,
    run_key: r._id,
    kind: "spawn" as const,
    short_id: r.short_id,
    title: r.title,
    created_at: first - i * DAY,
    status: "completed",
    idle_summary: RUN_SUMMARIES[i],
  }));
};

/** Maya's review session and the daily summary's newest run, nested under the lead. */
export const TRIGGER_SESSIONS = (now: number) => {
  const runs = SUMMARY_RUN_ROWS(now);
  return [
    session(now, MAYA_REVIEW, {
      ago: 15 * MIN,
      waiting: "done",
      project: "~/src/billing",
      messages: 22,
      owner: PEOPLE.maya,
      state: "Reviewed #482: approved\nStatus: one open question on 410s",
    }),
    // Only the newest run is a conversation the docs open. A spawned run is a
    // worker of the session that set the trigger, so it nests there.
    ...SUMMARY_RUNS.slice(0, 1).map((r, i) =>
      session(now, r, {
        ago: now - runs[i].created_at - 4 * MIN,
        waiting: "done",
        project: "~/src/acme-api",
        messages: 9,
        state: `${RUN_SUMMARIES[i].split(".")[0]}\nStatus: posted in #eng`,
        preview: RUN_SUMMARIES[i],
        extra: { agent_task_id: TRIGGER_IDS.summary, is_subagent: true, parent_conversation_id: SESSIONS.lead._id, started_at: runs[i].created_at },
      }),
    ),
  ];
};

/** The newest run's transcript: the trigger's brief, the reads, the summary. */
export const SUMMARY_RUN_TRANSCRIPT = (now: number) => {
  const at = SUMMARY_RUN_ROWS(now)[0].created_at;
  const call = (id: string, name: string, input: unknown) => ({ id, name, input: JSON.stringify(input) });
  const result = (id: string, content: string) => ({ tool_use_id: id, content });
  return [
    { _id: "hero-run-m1", role: "user", content: SUMMARY_PROMPT, timestamp: at },
    {
      _id: "hero-run-m2",
      role: "assistant",
      content: "Reading the open and recently merged PRs on acme/api.",
      tool_calls: [
        call("hero-run-tc1", "Bash", { command: "cast pr list --repo acme/api --label webhooks --state open" }),
        call("hero-run-tc2", "Bash", { command: "cast pr list --repo acme/api --merged-since 1d" }),
      ],
      tool_results: [
        result("hero-run-tc1", "#482  Retry failed webhooks with backoff  approved  checks 10/10\n#485  Sign webhook payloads with HMAC    changes requested  checks 9/10 (integration failed)"),
        result("hero-run-tc2", "#479  Upgrade Stripe SDK to v14  merged 18h ago by Alex Rivera"),
      ],
      timestamp: at + MIN,
    },
    {
      _id: "hero-run-m3",
      role: "assistant",
      content:
        "**Webhook PRs, this morning**\n\nOpen:\n- **#482 Retry failed webhooks with backoff**: approved by Maya, all 10 checks green, ready to merge.\n- **#485 Sign webhook payloads with HMAC**: integration failed, and Maya asked for a constant-time compare.\n\nMerged yesterday:\n- **#479 Upgrade Stripe SDK to v14**.\n\nPosted in #eng.",
      timestamp: at + 3 * MIN,
    },
  ];
};

const byId = (a: any) => {
  const id = a?.id ?? a?.short_id;
  return TRIGGERS(Date.now()).find((t) => t._id === id || t.short_id === String(id ?? "").toLowerCase()) ?? null;
};

export const TRIGGER_ANSWERS: Record<string, (args: any) => unknown> = {
  "agentTasks:webList": () => TRIGGERS(Date.now()),
  "agentTasks:webGet": byId,
  "agentTasks:webListRuns": (a) => (a?.task_id === TRIGGER_IDS.summary ? SUMMARY_RUN_ROWS(Date.now()) : []),
  "agentTasks:webListForConversation": (a) => TRIGGERS(Date.now()).filter((t) => t.originating_conversation_id === a?.conversation_id || t.created_by_conversation_id === a?.conversation_id),
  "agentTasks:webListForConversations": (a) => TRIGGERS(Date.now()).filter((t) => (a?.conversation_ids ?? []).includes(t.originating_conversation_id)),
};

export function seedAcmeTriggers(s: any, now: number) {
  s.syncTable("agentTasks", TRIGGERS(now));
  s.applyTailMessages(SUMMARY_RUNS[0]._id, 0, SUMMARY_RUN_TRANSCRIPT(now) as any, null);
}

export const TRIGGERS_PART: AcmePart = { name: "triggers", sessions: TRIGGER_SESSIONS, seed: seedAcmeTriggers, answers: TRIGGER_ANSWERS };

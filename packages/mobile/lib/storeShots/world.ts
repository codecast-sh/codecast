// The Acme workspace the App Store screenshots show: the same story, people
// and words as the homepage film (packages/web heroFly fixtures/story.ts,
// team.ts, work.ts, phone.ts), laid out for the phone's screens. Mirrored
// here rather than imported: those files sit under a web route, which the
// native bundle may never reach (lib/bundleGraph.guard.test.ts).
//
// Every id is `hero-*`, never Convex-shaped, so nothing here can resolve to
// a real row. Times are offsets from `now`, taken when the world is seeded.

import { FACES } from "./faces";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const TEAM_ID = "hero-team-acme";
export const WORKSPACE = `team:${TEAM_ID}`;

export const PEOPLE = {
  me: { _id: "hero-u-me", name: "Alex Rivera", handle: "alex", email: "alex@acme.dev", image: FACES.me },
  sarah: { _id: "hero-u-sarah", name: "Sarah Chen", handle: "sarah", email: "sarah@acme.dev", image: FACES.sarah },
  maya: { _id: "hero-u-maya", name: "Maya Ortiz", handle: "maya", email: "maya@acme.dev", image: FACES.maya },
  jordan: { _id: "hero-u-jordan", name: "Jordan Lee", handle: "jordan", email: "jordan@acme.dev", image: FACES.jordan },
  priya: { _id: "hero-u-priya", name: "Priya Nair", handle: "priya", email: "priya@acme.dev", image: FACES.priya },
} as const;
type Person = (typeof PEOPLE)[keyof typeof PEOPLE];

const PRESENCE: Record<string, "active" | "idle" | "away" | "offline"> = {
  "hero-u-me": "active",
  "hero-u-sarah": "active",
  "hero-u-maya": "active",
  "hero-u-jordan": "idle",
  "hero-u-priya": "away",
};

export const CURRENT_USER = (now: number) => ({
  _id: PEOPLE.me._id,
  _creationTime: now - 120 * DAY,
  name: PEOPLE.me.name,
  email: PEOPLE.me.email,
  image: PEOPLE.me.image,
  github_username: "alexrivera",
  github_avatar_url: PEOPLE.me.image,
  team_id: TEAM_ID,
  active_team_id: TEAM_ID,
  status: "available",
});

export const TEAMS = [{ _id: TEAM_ID, name: "Acme", features: { chat: true, calls: true }, role: "admin" }];

export const TEAM_MEMBERS = (now: number) =>
  Object.values(PEOPLE).map((p: Person) => ({
    _id: p._id,
    user_id: p._id,
    name: p.name,
    email: p.email,
    image: p.image,
    github_avatar_url: p.image,
    github_username: p.handle,
    role: p._id === PEOPLE.me._id ? "admin" : "member",
    presence_state: PRESENCE[p._id],
    presence_input_at: now - (PRESENCE[p._id] === "active" ? MIN : 40 * MIN),
    is_bot: false,
  }));

/* ── Sessions ──────────────────────────────────────────────────────────── */

/** A Convex-shaped id (32 lowercase letters and digits). Session ids need the
 *  shape: the inbox treats any other id as a create it is still waiting on and
 *  shows it as working (store/inboxOverlays.ts). Safe here, with no server. */
const cid = (name: string) => `hero${name.replace(/[^a-z0-9]/g, "")}`.padEnd(32, "0").slice(0, 32);

export const SESSIONS = {
  api: { _id: cid("sapi"), short_id: "jx7d2wk", title: "Webhook API half", agent_type: "codex" },
  e2e: { _id: cid("se2e"), short_id: "jx7e8hb", title: "Fix flaky checkout e2e", agent_type: "cursor" },
  lead: { _id: cid("slead"), short_id: "jx7c4mq", title: "Retry failed webhooks", agent_type: "claude_code" },
  ui: { _id: cid("sui"), short_id: "jx7f9np", title: "Dashboard retry UI", agent_type: "cursor" },
  rate: { _id: cid("srate"), short_id: "jx7h3vd", title: "Rate limiter for the public API", agent_type: "pi" },
  stripe: { _id: cid("sstripe"), short_id: "jx7k6ra", title: "Upgrade Stripe SDK to v14", agent_type: "claude_code" },
  audit: { _id: cid("saudit"), short_id: "jx7m1zq", title: "Audit log export to S3", agent_type: "opencode" },
  pg: { _id: cid("spg"), short_id: "jx7n5tc", title: "Migrate invoices to Postgres 16", agent_type: "codex" },
} as const;

/** The question the API worker stops on, answered from the phone in the film. */
export const ASK = {
  question: "Should a 410 Gone count as a failed delivery?",
  header: "410 Gone",
  options: [
    { label: "Log it once, never retry (Recommended)", description: "The endpoint is gone, so a retry can never succeed." },
    { label: "Retry like any 5xx", description: "Up to 5 attempts with exponential backoff." },
    { label: "Pause the endpoint", description: "Stop delivering until someone re-enables it." },
  ],
};

type Waiting = "asking" | "blocked" | "working" | "done";

function session(
  now: number,
  s: { _id: string; short_id: string; title: string; agent_type: string },
  o: {
    ago: number;
    waiting: Waiting;
    project: string;
    messages: number;
    state?: string;
    preview?: string;
    extra?: Record<string, unknown>;
  },
) {
  const live = o.waiting === "working";
  const statusAt = now - o.ago;
  return {
    _id: s._id,
    session_id: `${s._id}-sess`,
    short_id: s.short_id,
    title: s.title,
    agent_type: s.agent_type,
    user_id: PEOPLE.me._id,
    author_name: PEOPLE.me.name,
    is_own: true,
    status: "active",
    team_id: TEAM_ID,
    workspace: WORKSPACE,
    project_path: o.project,
    git_root: o.project,
    git_branch: "main",
    message_count: o.messages,
    started_at: statusAt - 40 * MIN,
    updated_at: statusAt,
    last_message_at: statusAt,
    is_connected: true,
    daemon_alive_until: now + 10 * MIN,
    last_heartbeat: now - 5_000,
    // The inbox's placement rules (shared/contracts/inboxProjection.ts):
    // a blocked declaration on an idle agent is the person's move, an agent
    // that declared done is done.
    agent_status: live ? "working" : o.waiting === "done" ? "done" : "idle",
    agent_status_at: statusAt,
    is_idle: !live,
    awaiting_input: o.waiting === "asking" || o.waiting === "blocked",
    has_pending: false,
    thread_state: o.state,
    thread_state_status: o.waiting === "asking" ? "blocked" : o.waiting,
    thread_state_at: statusAt,
    thread_state_msg_count: o.messages,
    idle_summary: o.preview,
    subtitle: o.preview,
    ...o.extra,
  };
}

export const INBOX = (now: number) => [
  session(now, SESSIONS.api, {
    ago: 1 * MIN,
    waiting: "asking",
    project: "~/src/billing",
    messages: 12,
    state: `Retry endpoint is in, 16 tests green\nBlocked: ${ASK.question}`,
    preview: ASK.question,
    extra: { worktree_name: "webhook-api", worktree_branch: "feat/webhook-retry-api" },
  }),
  session(now, SESSIONS.e2e, {
    ago: 6 * MIN,
    waiting: "blocked",
    project: "~/src/web",
    messages: 28,
    state: "Which card should the e2e use?\nBlocked: the 4242 test card is rate limited in CI",
  }),
  session(now, SESSIONS.lead, {
    ago: 20_000,
    waiting: "working",
    project: "~/src/billing",
    messages: 64,
    state: "Retry queue is in, workers on the API and the dashboard\nStatus: 14 of 16 tests green",
  }),
  session(now, SESSIONS.ui, {
    ago: 40_000,
    waiting: "working",
    project: "~/src/billing",
    messages: 18,
    state: "Retry button and attempt history on each failed webhook\nStatus: wiring the endpoint's states",
  }),
  session(now, SESSIONS.rate, {
    ago: 4 * MIN,
    waiting: "working",
    project: "~/src/gateway",
    messages: 63,
    state: "Token bucket is in, load test next\nStatus: 4,000 req/s holds on one node",
  }),
  session(now, SESSIONS.stripe, {
    ago: 25 * MIN,
    waiting: "done",
    project: "~/src/billing",
    messages: 87,
    state: "Stripe SDK on v14, 38 call sites migrated\nStatus: tests green, PR #479 open for review",
  }),
  session(now, SESSIONS.audit, {
    ago: 47 * MIN,
    waiting: "done",
    project: "~/src/infra",
    messages: 34,
    state: "Export runs nightly and writes a manifest per day\nStatus: shipped",
  }),
  session(now, SESSIONS.pg, {
    ago: 2 * HOUR,
    waiting: "done",
    project: "~/src/billing",
    messages: 41,
    state: "Invoices on Postgres 16, staging verified\nStatus: migration ran clean, 0 rows lost",
  }),
];

/** The API worker's transcript, oldest first, ending on its question. */
export const API_TRANSCRIPT = (now: number) => {
  const t = (minsAgo: number) => now - minsAgo * MIN;
  const call = (id: string, name: string, input: unknown) => ({ id, name, input: JSON.stringify(input) });
  const result = (id: string, content: string) => ({ tool_use_id: id, content });
  return [
    {
      _id: "hero-api-m1",
      role: "user",
      content: "Build the retry endpoint for failed webhooks: POST /v2/hooks/retry, idempotent, 5 attempts max. Reuse deliver() for each attempt.",
      timestamp: t(14),
    },
    {
      _id: "hero-api-m2",
      role: "assistant",
      content: "Reading the webhook handlers and the delivery path before I change anything.",
      tool_calls: [
        call("hero-tc-1", "Glob", { pattern: "src/api/**/*.ts" }),
        call("hero-tc-2", "Read", { file_path: "src/billing/retry.ts" }),
        call("hero-tc-3", "Grep", { pattern: "router.post", path: "src/api" }),
      ],
      tool_results: [
        result("hero-tc-1", "src/api/hooks.ts\nsrc/api/router.ts\nsrc/api/billing.ts\nsrc/api/health.ts"),
        result("hero-tc-2", "export async function deliver(event: WebhookEvent) {\n  const res = await fetch(event.endpoint, signed(event));\n  return res.status;\n}"),
        result("hero-tc-3", "src/api/hooks.ts:18: router.post(\"/v2/hooks\", receive)\nsrc/api/billing.ts:41: router.post(\"/v2/refunds\", refund)"),
      ],
      timestamp: t(12),
    },
    {
      _id: "hero-api-m2b",
      role: "assistant",
      content: "deliver() already signs and sends one attempt, so the retry route only needs a schedule and a stop rule. Writing the tests first so those rules are pinned down.",
      tool_calls: [
        call("hero-tc-6", "Write", { file_path: "src/api/hooks.test.ts", content: "describe(\"POST /v2/hooks/retry\", () => { /* 16 cases */ })" }),
        call("hero-tc-7", "Bash", { command: "bun test src/api/hooks.test.ts" }),
      ],
      tool_results: [
        result("hero-tc-6", "File created successfully at: src/api/hooks.test.ts"),
        result("hero-tc-7", "4 pass\n12 fail\nRan 16 tests across 1 file. [201ms]"),
      ],
      timestamp: t(9),
    },
    {
      _id: "hero-api-m3",
      role: "assistant",
      content: "Adding the retry route next to the webhook handlers, reusing deliver() for each attempt. Attempts back off 2s, 4s, 8s, 16s with jitter, capped at 5.",
      tool_calls: [
        call("hero-tc-4", "Edit", { file_path: "src/api/hooks.ts", old_string: "router.post(\"/v2/hooks\", receive)", new_string: "router.post(\"/v2/hooks\", receive)\nrouter.post(\"/v2/hooks/retry\", idempotent(retry))" }),
        call("hero-tc-5", "Bash", { command: "bun test src/api/hooks.test.ts" }),
      ],
      tool_results: [
        result("hero-tc-4", "The file src/api/hooks.ts has been updated."),
        result("hero-tc-5", "16 pass\n0 fail\nRan 16 tests across 1 file. [184ms]"),
      ],
      timestamp: t(4),
    },
    {
      _id: "hero-api-m3b",
      role: "assistant",
      content: "All 16 tests pass: 5xx, 429 and timeouts retry with backoff, and a delivery stops after its fifth attempt. One case is a product call, not mine to make.",
      timestamp: t(2),
    },
    {
      _id: "hero-api-m4",
      role: "assistant",
      content: "",
      tool_calls: [call("hero-tc-ask", "AskUserQuestion", { questions: [{ question: ASK.question, header: ASK.header, multiSelect: false, options: ASK.options }] })],
      timestamp: t(1),
    },
  ];
};

/* ── Team chat ─────────────────────────────────────────────────────────── */

export const CHANNELS = [
  { _id: "hero-ch-eng", name: "eng", topic: "Billing and payments engineering", is_default: true },
  { _id: "hero-ch-billing", name: "billing-alerts", unread: 3 },
  { _id: "hero-ch-agents", name: "agents", kind: "agents" as const, unread: 7 },
  { _id: "hero-ch-incidents", name: "incidents" },
  { _id: "hero-ch-design", name: "design", unread: 1 },
  { _id: "hero-ch-random", name: "random" },
  { _id: "hero-dm-sarah", name: "", kind: "dm" as const, dm_key: `${TEAM_ID}:hero-u-me:hero-u-sarah`, unread: 1 },
  { _id: "hero-dm-maya", name: "", kind: "dm" as const, dm_key: `${TEAM_ID}:hero-u-jordan:hero-u-maya:hero-u-me` },
];

// A line a session typed: named for the session, crediting its human (web lib/chatViews
// sessionAuthorFor). author_kind "agent" is a role seat's mark, never a session's.
const LEAD_AUTHOR = { origin: "agent" as const, origin_session_id: SESSIONS.lead._id, origin_session_title: SESSIONS.lead.title, origin_agent_type: SESSIONS.lead.agent_type };

/** #eng, oldest first: the team's day, then the lead session answering for its work. */
export const ENG_MESSAGES = (now: number) =>
  [
    { id: "hero-m-1", who: PEOPLE.me, ago: 7 * HOUR, content: "Billing deploy freeze lifts at noon. Queue anything that touches payouts for after." },
    { id: "hero-m-2", who: PEOPLE.maya, ago: 5 * HOUR, content: "The ledger restarts for the Postgres upgrade tonight. Expect a few minutes of 502s around 2am." },
    { id: "hero-m-3", who: PEOPLE.sarah, ago: 3 * HOUR, content: "Refund webhooks are idempotent now, so replaying one is safe." },
    { id: "hero-m-4", who: PEOPLE.me, ago: 12 * MIN, content: "Heads up, agents are on webhook retries now. Ask the lead session here if anything looks off." },
    { id: "hero-m-5", who: PEOPLE.sarah, ago: 3 * MIN, content: "Support has two tickets about Stripe events dropped overnight. Would the retry queue have caught them?" },
    {
      id: "hero-m-6",
      who: PEOPLE.me,
      agent: true,
      ago: 2 * MIN,
      content: "Yes. Both failed on a 502 from the ledger, and a failed delivery now goes to a retry queue with exponential backoff, at most 5 attempts. Both would have landed on the second try. PR #482 is up and its checks are running.",
    },
    { id: "hero-m-7", who: PEOPLE.maya, ago: 40_000, content: "I'll point support at the retry queue once it ships." },
  ].map((m) => ({
    _id: m.id,
    team_id: TEAM_ID,
    channel_id: "hero-ch-eng",
    user_id: m.who._id,
    content: m.content,
    created_at: now - m.ago,
    updated_at: now - m.ago,
    ...("agent" in m && m.agent ? LEAD_AUTHOR : { author_kind: "user" as const }),
  }));

export const ENG_REACTIONS = (now: number) => [
  { _id: "hero-r-1", message_id: "hero-m-6", channel_id: "hero-ch-eng", user_id: PEOPLE.sarah._id, emoji: "🎉", created_at: now - 90_000 },
  { _id: "hero-r-2", message_id: "hero-m-6", channel_id: "hero-ch-eng", user_id: PEOPLE.maya._id, emoji: "🙌", created_at: now - 80_000 },
  { _id: "hero-r-3", message_id: "hero-m-6", channel_id: "hero-ch-eng", user_id: PEOPLE.jordan._id, emoji: "🎉", created_at: now - 70_000 },
];

const RAIL_PREVIEWS: Record<string, { who: string; preview: string; ago: number; agent?: boolean }> = {
  "hero-ch-eng": { who: PEOPLE.maya._id, preview: "I'll point support at the retry queue once it ships.", ago: 40_000 },
  "hero-ch-billing": { who: PEOPLE.me._id, preview: "3 webhooks retried, all delivered on attempt 2", ago: 9 * MIN, agent: true },
  "hero-ch-agents": { who: PEOPLE.me._id, preview: "Rate limiter load test: 4,000 req/s holds on one node", ago: 4 * MIN, agent: true },
  "hero-ch-incidents": { who: PEOPLE.maya._id, preview: "Ledger restart done, 502s cleared at 2:04am", ago: 9 * HOUR },
  "hero-ch-design": { who: PEOPLE.priya._id, preview: "New retry history mock is in Figma", ago: 2 * HOUR },
  "hero-ch-random": { who: PEOPLE.jordan._id, preview: "Lunch order closes at 11:45", ago: 5 * HOUR },
  "hero-dm-sarah": { who: PEOPLE.sarah._id, preview: "Can you look at the HMAC PR before standup?", ago: 18 * MIN },
  "hero-dm-maya": { who: PEOPLE.jordan._id, preview: "Load test numbers are in, sharing in #agents", ago: 50 * MIN },
};

export const CHAT_RAIL = (now: number) =>
  CHANNELS.map((c) => {
    const p = RAIL_PREVIEWS[c._id];
    return {
      channel_id: c._id,
      last_message: {
        _id: `${c._id}-last`,
        user_id: p.who,
        created_at: now - p.ago,
        preview: p.preview,
        ...(p.agent ? { origin: "agent" as const, origin_session_id: SESSIONS.lead._id, origin_session_title: SESSIONS.lead.title, origin_agent_type: SESSIONS.lead.agent_type } : {}),
      },
      sort_at: now - p.ago,
      unread: c.unread ?? 0,
      unread_mentions: 0,
      notify_level: "all" as const,
      joined: true,
    };
  });

/* ── The huddle in #eng ────────────────────────────────────────────────── */

export const HUDDLE_ROOM = "channel:hero-ch-eng";

export const LIVE_ROOMS = [
  {
    room_key: HUDDLE_ROOM,
    team_id: TEAM_ID,
    can_join: true,
    redacted: false,
    title: "#eng",
    members: [PEOPLE.sarah, PEOPLE.maya].map((p) => ({ user_id: p._id, user_name: p.name, user_image: p.image })),
  },
];

/** The call screen's participants: Alex (this phone) joins Sarah and Maya. */
export const HUDDLE_PARTICIPANTS = [
  { identity: PEOPLE.sarah._id, name: PEOPLE.sarah.name, image: PEOPLE.sarah.image, isLocal: false, micMuted: false, hasCamera: false, hasScreen: false },
  { identity: PEOPLE.me._id, name: PEOPLE.me.name, image: PEOPLE.me.image, isLocal: true, micMuted: false, hasCamera: false, hasScreen: false },
  { identity: PEOPLE.maya._id, name: PEOPLE.maya.name, image: PEOPLE.maya.image, isLocal: false, micMuted: true, hasCamera: false, hasScreen: false },
];

/** Live captions: the last turns of the huddle, written seconds ago. */
export const CAPTIONS = (now: number) => ({
  started_by: PEOPLE.sarah._id,
  tail: [
    { seq: 1, speaker_id: PEOPLE.sarah._id, speaker_name: PEOPLE.sarah.name, text: "Five attempts over how long, worst case?", at: now - 14_000 },
    { seq: 2, speaker_id: PEOPLE.me._id, speaker_name: PEOPLE.me.name, text: "About thirty minutes. Two, four, eight, then sixteen, with jitter.", at: now - 8_000 },
    { seq: 3, speaker_id: PEOPLE.sarah._id, speaker_name: PEOPLE.sarah.name, text: "That covers the ledger restarts. Ship it once the checks are green.", at: now - 2_000 },
  ],
});

/* ── Tasks ─────────────────────────────────────────────────────────────── */

const PLAN = { _id: "hero-plan-1", short_id: "pl-312", title: "Webhook reliability" };
const info = (p: Person) => ({ _id: p._id, name: p.name, image: p.image, github_avatar_url: p.image });

export const PLANS = (now: number) => [
  { _id: PLAN._id, short_id: PLAN.short_id, title: PLAN.title, status: "active", goal: "No webhook is ever dropped", workspace: WORKSPACE, team_id: TEAM_ID, created_at: now - 3 * DAY, updated_at: now - 10 * MIN },
];

export const TASKS = (now: number) => {
  const task = (t: Record<string, unknown> & { _id: string; short_id: string; title: string; status: string; priority: string }, ago: number) => ({
    task_type: "task",
    source: "human",
    plan: PLAN,
    plan_id: PLAN._id,
    workspace: WORKSPACE,
    team_id: TEAM_ID,
    creator: info(PEOPLE.me),
    created_at: now - ago - DAY,
    updated_at: now - ago,
    ...t,
  });
  return [
    task({ _id: "hero-t1", short_id: "ct-4182", title: "Retry queue for failed webhooks", status: "in_progress", priority: "high", labels: ["webhooks"], assignee: PEOPLE.me._id, assignee_info: info(PEOPLE.me), source: "agent", source_agent_type: "claude_code" }, MIN),
    task({ _id: "hero-t2", short_id: "ct-4183", title: "Sign webhook payloads with HMAC", status: "in_progress", priority: "medium", labels: ["webhooks", "security"], assignee: PEOPLE.sarah._id, assignee_info: info(PEOPLE.sarah) }, 3 * HOUR),
    task({ _id: "hero-t3", short_id: "ct-4184", title: "Dead-letter queue for poisoned events", status: "in_review", priority: "high", labels: ["webhooks"], assignee: PEOPLE.maya._id, assignee_info: info(PEOPLE.maya), source: "agent", source_agent_type: "cursor" }, 5 * HOUR),
    task({ _id: "hero-t4", short_id: "ct-4185", title: "Page on-call when retries run out", status: "open", priority: "medium", labels: ["ops"], assignee: PEOPLE.sarah._id, assignee_info: info(PEOPLE.sarah) }, DAY),
    task({ _id: "hero-t5", short_id: "ct-4186", title: "Backfill events Stripe sent while we were down", status: "open", priority: "low", labels: ["data"] }, 2 * DAY),
    task({ _id: "hero-t6", short_id: "ct-4187", title: "Idempotency keys on webhook handlers", status: "done", priority: "high", labels: ["webhooks"], assignee: PEOPLE.sarah._id, assignee_info: info(PEOPLE.sarah) }, 2 * DAY),
    task({ _id: "hero-t7", short_id: "ct-4179", title: "Rate limit the public API", status: "in_progress", priority: "high", labels: ["gateway"], assignee: PEOPLE.jordan._id, assignee_info: info(PEOPLE.jordan), plan: undefined, plan_id: undefined, source: "agent", source_agent_type: "pi" }, 4 * MIN),
    task({ _id: "hero-t9", short_id: "ct-4188", title: "Retry button and attempt history", status: "in_progress", priority: "high", labels: ["dashboard"], assignee: PEOPLE.maya._id, assignee_info: info(PEOPLE.maya), source: "agent", source_agent_type: "cursor" }, 40_000),
    task({ _id: "hero-t10", short_id: "ct-4175", title: "Upgrade Stripe SDK to v14", status: "in_review", priority: "high", labels: ["billing"], assignee: PEOPLE.me._id, assignee_info: info(PEOPLE.me), plan: undefined, plan_id: undefined, source: "agent", source_agent_type: "claude_code" }, 25 * MIN),
    task({ _id: "hero-t11", short_id: "ct-4189", title: "Alert when the retry queue backs up", status: "open", priority: "medium", labels: ["ops"] }, 3 * HOUR),
    task({ _id: "hero-t12", short_id: "ct-4190", title: "Document the retry policy for support", status: "open", priority: "low", labels: ["docs"], assignee: PEOPLE.priya._id, assignee_info: info(PEOPLE.priya) }, 5 * HOUR),
    task({ _id: "hero-t8", short_id: "ct-4171", title: "Audit log export to S3", status: "done", priority: "medium", labels: ["infra"], assignee: PEOPLE.priya._id, assignee_info: info(PEOPLE.priya), plan: undefined, plan_id: undefined }, 47 * MIN),
  ];
};

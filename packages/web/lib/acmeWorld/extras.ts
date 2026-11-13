// The parts of the Acme world the phone's docs shots need beyond the inbox,
// chat and tasks: Alex's machines, the team's org, recent folders, a pending
// permission and two more transcripts (one with a canvas). Answered through
// the stub's query answers where a feeder reads a query (so the rows reach the
// store the way server rows do), seeded straight into the store otherwise.
// Mobile's Metro reaches this file, so imports stay relative.

import { applyLiveRoomsPush } from "../calls/liveRoomsPush";
import { HOUR, LIVE_ROOMS, MIN, PEOPLE, SESSIONS, TEAM_ID, cid } from "./world";

/* ── Machines ──────────────────────────────────────────────────────────── */

const LAPTOP = "acme-mbp-alex";

export const MACHINES = (now: number) => [
  {
    device_id: LAPTOP,
    label: "Alex's MacBook Pro",
    platform: "darwin",
    last_seen: now - 20_000,
    is_remote: false,
    online: true,
    local_project_roots: ["~/src"],
  },
  {
    device_id: "acme-linux",
    label: "acme-linux",
    platform: "linux",
    last_seen: now - 30_000,
    is_remote: true,
    online: true,
    local_project_roots: ["~/src"],
    cloud_host: { managed_by: LAPTOP, instance_id: "i-0acme7linux", name: "acme-linux", provider: "aws", region: "us-east-1", instance_type: "m7i.xlarge", state: "running" },
  },
];

export const RECENT_PROJECTS = (now: number) =>
  [
    ["~/src/billing", 42, 2 * MIN],
    ["~/src/web", 18, 6 * MIN],
    ["~/src/gateway", 9, 4 * MIN],
    ["~/src/infra", 6, 47 * MIN],
  ].map(([path, count, ago]) => ({ path: path as string, count: count as number, lastActive: now - (ago as number), team_id: TEAM_ID, team_name: "Acme" }));

/* ── Org ───────────────────────────────────────────────────────────────── */

const counts = (c: Partial<Record<"working" | "needs_input" | "done" | "dormant" | "idle", number>>) => ({ working: 0, needs_input: 0, done: 0, dormant: 0, idle: 0, ...c });

const orgSession = (s: { _id: string; short_id: string; title: string; agent_type: string }, state: string, ago: number, now: number, extra: Record<string, unknown> = {}) => ({
  _id: s._id,
  short_id: s.short_id,
  title: s.title,
  agent_type: s.agent_type,
  state,
  updated_at: now - ago,
  owner_user_id: PEOPLE.me._id,
  subagent_count: 0,
  is_anchor: false,
  project_path: "~/src/billing",
  git_branch: "main",
  ...extra,
});

const ROLE_PEOPLE = cid("rolepeople");
const ROLE_HOOKS = cid("rolewebhooks");

export const ORG_TREE = (now: number) => {
  const role = (o: { _id: string; short_id: string; name: string; handle: string; reports_to: string; sessions: any[]; c: ReturnType<typeof counts>; line: string }) => ({
    _id: o._id,
    short_id: o.short_id,
    scope_type: "team" as const,
    team_id: TEAM_ID,
    host_user_id: o.reports_to,
    name: o.name,
    handle: o.handle,
    scope: { project_ids: [], plan_ids: [] },
    reports_to: { kind: "user" as const, user_id: o.reports_to },
    status: "active" as const,
    created_by: PEOPLE.me._id,
    created_at: now - 30 * 24 * HOUR,
    updated_at: now - HOUR,
    counts: o.c,
    sessions: o.sessions,
    total: o.sessions.length,
    standing: { state: "working" as const, state_line: o.line, state_at: now - 3 * MIN },
    scope_names: { projects: [], plans: [] },
  });
  return {
    workspace: { kind: "team" as const, id: TEAM_ID, name: "Acme" },
    generated_at: now,
    anchors: [],
    people: [
      { user_id: PEOPLE.sarah._id, name: PEOPLE.sarah.name, image: PEOPLE.sarah.image, role: "owner" as const, is_me: false, presence: "online" as const, counts: counts({}), sessions: [], total: 0 },
      {
        user_id: PEOPLE.me._id,
        name: PEOPLE.me.name,
        image: PEOPLE.me.image,
        role: "admin" as const,
        is_me: true,
        reports_to_user_id: PEOPLE.sarah._id,
        presence: "online" as const,
        counts: counts({ needs_input: 2, working: 1 }),
        sessions: [
          orgSession(SESSIONS.api, "needs_input", MIN, now),
          orgSession(SESSIONS.e2e, "needs_input", 6 * MIN, now, { project_path: "~/src/web" }),
          orgSession(SESSIONS.rate, "working", 4 * MIN, now, { project_path: "~/src/gateway" }),
        ],
        total: 3,
      },
      { user_id: PEOPLE.maya._id, name: PEOPLE.maya.name, image: PEOPLE.maya.image, role: "member" as const, is_me: false, reports_to_user_id: PEOPLE.sarah._id, presence: "online" as const, counts: counts({}), sessions: [], total: 0 },
    ],
    roles: [
      role({
        _id: ROLE_PEOPLE,
        short_id: "rl-people",
        name: "Head of People",
        handle: "head-of-people",
        reports_to: PEOPLE.sarah._id,
        sessions: [],
        c: counts({}),
        line: "Onboarding plan for the two new hires",
      }),
      role({
        _id: ROLE_HOOKS,
        short_id: "rl-hooks",
        name: "Webhooks lead",
        handle: "webhooks",
        reports_to: PEOPLE.me._id,
        sessions: [
          orgSession(SESSIONS.lead, "working", 0, now, { org_role_id: ROLE_HOOKS }),
          orgSession(SESSIONS.ui, "working", 0, now, { org_role_id: ROLE_HOOKS }),
        ],
        c: counts({ working: 2 }),
        line: "Retry queue in review, dashboard next",
      }),
    ],
  };
};

/* ── Sessions ──────────────────────────────────────────────────────────── */

/** The lead stops before running the retry tests: the permission the phone approves. */
export const PERMISSIONS = (now: number) => [
  {
    _id: cid("permretrytests"),
    conversation_id: SESSIONS.lead._id,
    session_id: `${SESSIONS.lead._id}-sess`,
    tool_name: "Bash",
    arguments_preview: "bun test src/billing/retry.test.ts --timeout 20000",
    status: "pending" as const,
    created_at: now - 40_000,
  },
];

const call = (id: string, name: string, input: unknown) => ({ id, name, input: JSON.stringify(input) });
const result = (id: string, content: string) => ({ tool_use_id: id, content });

const RETRY_TS = `const DELAYS_MS = [2_000, 4_000, 8_000, 16_000];
export const MAX_ATTEMPTS = 5;

/** 5xx, 429 and timeouts are worth another try; a 410 means the endpoint is gone. */
export function isRetryable(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/** The delay before attempt \`n\`, with up to 20% jitter so retries never arrive together. */
export function backoff(attempt: number): number {
  const base = DELAYS_MS[Math.min(attempt - 1, DELAYS_MS.length - 1)];
  return base + Math.round(base * 0.2 * Math.random());
}

export async function scheduleRetry(event: WebhookEvent, attempt: number) {
  if (attempt >= MAX_ATTEMPTS) return deadLetter(event);
  await queue.add(event, { delay: backoff(attempt), attempt: attempt + 1 });
}
`;

const RETRY_TEST_TS = `import { describe, expect, test } from "bun:test";
import { backoff, isRetryable, MAX_ATTEMPTS } from "./retry";

describe("webhook retries", () => {
  test("retries 5xx, 429 and timeouts", () => {
    for (const s of [500, 502, 503, 429, 408]) expect(isRetryable(s)).toBe(true);
  });
  test("never retries a 410", () => expect(isRetryable(410)).toBe(false));
  test("backs off 2s, 4s, 8s, 16s", () => {
    expect(backoff(1)).toBeGreaterThanOrEqual(2_000);
    expect(backoff(4)).toBeLessThan(16_000 * 1.21);
  });
  test("stops after five attempts", () => expect(MAX_ATTEMPTS).toBe(5));
});
`;

export const LEAD_TRANSCRIPT = (now: number) => {
  const t = (minsAgo: number) => now - minsAgo * MIN;
  return [
    { _id: "hero-lead-m1", role: "user", content: "Failed Stripe webhooks should retry instead of dropping. Split the API and the dashboard across workers and keep me posted.", timestamp: t(40) },
    { _id: "hero-lead-m2", role: "assistant", content: "Two workers are on it: the API half builds POST /v2/hooks/retry, the dashboard half adds a Retry button and attempt history.", timestamp: t(38) },
    // The queue itself, built here: folded tool lines, an edit the diff panel
    // shows, and the retry suite running in the background.
    {
      _id: "hero-lead-m2a",
      role: "assistant",
      content: "Reading how a delivery fails today before adding the queue.",
      tool_calls: [
        call("hero-lead-tc1", "Read", { file_path: "webhooks/deliver.ts" }),
        call("hero-lead-tc2", "Grep", { pattern: "deliver\\(", path: "webhooks" }),
        call("hero-lead-tc3", "Read", { file_path: "webhooks/queue.ts" }),
      ],
      tool_results: [
        result("hero-lead-tc1", "export async function deliver(event: WebhookEvent): Promise<number> {\n  const res = await fetch(event.endpoint, signed(event));\n  return res.status;\n}"),
        result("hero-lead-tc2", "webhooks/receive.ts:22:  await deliver(event)\nwebhooks/replay.ts:9:  return deliver(event)"),
        result("hero-lead-tc3", "export const queue = createQueue<WebhookEvent>(\"webhooks\");"),
      ],
      timestamp: t(30),
    },
    {
      _id: "hero-lead-m2b",
      role: "assistant",
      content: "A failed delivery goes back on the queue with a growing delay. The schedule lives in one function so the dashboard can show the next attempt.",
      tool_calls: [
        call("hero-lead-tc4", "Write", { file_path: "webhooks/retry.ts", content: RETRY_TS }),
        call("hero-lead-tc5", "Edit", { file_path: "webhooks/receive.ts", old_string: "  await deliver(event)", new_string: "  const status = await deliver(event)\n  if (isRetryable(status)) await scheduleRetry(event, 1)" }),
        call("hero-lead-tc6", "Write", { file_path: "webhooks/retry.test.ts", content: RETRY_TEST_TS }),
      ],
      tool_results: [
        result("hero-lead-tc4", "File created successfully at: webhooks/retry.ts"),
        result("hero-lead-tc5", "The file webhooks/receive.ts has been updated."),
        result("hero-lead-tc6", "File created successfully at: webhooks/retry.test.ts"),
      ],
      timestamp: t(18),
    },
    {
      _id: "hero-lead-m2c",
      role: "assistant",
      content: "Running the retry suite against the real queue in the background; it replays 200 failed deliveries.",
      tool_calls: [
        call("hero-lead-tc7", "Bash", { command: "bun test webhooks/retry.test.ts", description: "Run the webhook retry tests", run_in_background: true }),
        call("hero-lead-tc8", "Bash", { command: "bun run typecheck", description: "Typecheck the billing service" }),
      ],
      tool_results: [
        result("hero-lead-tc7", "Command running in background with ID: b7r2k9. Output is being written to: /tmp/retry-tests.log"),
        result("hero-lead-tc8", "Checked 214 files, 0 errors. [3.1s]"),
      ],
      timestamp: t(6),
    },
    {
      _id: "hero-lead-m3",
      role: "assistant",
      content:
        "The retry queue is in. A failed delivery now waits 2s, 4s, 8s, 16s with jitter and stops after the fifth attempt. Both tickets Sarah raised would have landed on the second try.\n\nThe retry suite is still running in the background against the real queue; I will post the result when it finishes.",
      timestamp: t(1),
    },
  ];
};

const CANVAS = `\`\`\`cast-canvas
<div data-canvas-title="Backoff strategies for webhook retries" style="font-family:system-ui;padding:12px;color:var(--sol-text)">
  <div style="font-size:14px;margin-bottom:6px">Exponential backoff with jitter recovers 96% of failed deliveries by the fifth attempt.</div>
  <div style="font-size:12px;color:var(--sol-text-muted);margin-bottom:10px">Recovered, by attempt</div>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr style="color:var(--sol-text-dim)"><td></td><td>1</td><td>2</td><td>3</td><td>5</td></tr>
    <tr><td>Fixed 5s</td><td>41%</td><td>58%</td><td>66%</td><td>71%</td></tr>
    <tr><td>Linear</td><td>41%</td><td>63%</td><td>74%</td><td>82%</td></tr>
    <tr style="font-weight:600;color:var(--sol-green)"><td>Exponential + jitter</td><td>41%</td><td>77%</td><td>89%</td><td>96%</td></tr>
  </table>
</div>
\`\`\``;

export const UI_TRANSCRIPT = (now: number) => {
  const t = (minsAgo: number) => now - minsAgo * MIN;
  return [
    { _id: "hero-ui-m1", role: "user", content: "Which backoff should the dashboard's Retry button use? Compare the options on last week's failures.", timestamp: t(9) },
    {
      _id: "hero-ui-m2",
      role: "assistant",
      content: `I replayed last week's 1,284 failed deliveries under each schedule.\n\n${CANVAS}\n\nThe Retry button will use the queue's schedule: 2s, 4s, 8s, 16s with jitter, five attempts at most.`,
      timestamp: t(2),
    },
  ];
};

/* ── Search ────────────────────────────────────────────────────────────── */

/** Sessions across the team whose title or messages match: Alex's own and
 *  two teammates', the way a team search reads. */
const SEARCH_HITS = (now: number) => [
  { s: SESSIONS.lead, who: PEOPLE.me, ago: 0, project: "~/src/billing", msgs: 64, hit: "a failed delivery now goes to a retry queue with exponential backoff" },
  { s: { _id: cid("smayahooks"), title: "Webhook signature rotation", agent_type: "claude_code" }, who: PEOPLE.maya, ago: 3 * HOUR, project: "~/src/billing", msgs: 41, hit: "rotate the webhook signing secret without dropping in-flight events" },
  { s: SESSIONS.api, who: PEOPLE.me, ago: MIN, project: "~/src/billing", msgs: 22, hit: "Should a 410 Gone count as a failed webhook delivery?" },
  { s: { _id: cid("ssarahreplay"), title: "Replay dropped Stripe webhooks", agent_type: "codex" }, who: PEOPLE.sarah, ago: 26 * HOUR, project: "~/src/support-tools", msgs: 18, hit: "replayed 212 webhook events from the Stripe dashboard export" },
].map(({ s, who, ago, project, msgs, hit }, i) => ({
  conversationId: s._id,
  title: s.title,
  matchCount: 1,
  matches: [{ messageId: `${s._id}-hit`, content: hit, role: "assistant", timestamp: now - ago - MIN }],
  updatedAt: now - ago,
  authorName: who.name,
  authorAvatar: who.image,
  isOwn: who._id === PEOPLE.me._id,
  messageCount: msgs,
  relevance: 10 - i,
  workerCount: 0,
  titleMatch: /webhook/i.test(s.title),
  projectPath: project,
  agentType: s.agent_type,
  workspace: `team:${TEAM_ID}`,
  teamName: "Acme",
}));

const search = (args: any) => {
  const q = String(args?.query ?? args?.q ?? "").toLowerCase();
  const results = q.length >= 2 ? SEARCH_HITS(Date.now()).filter((r) => (r.title + " " + r.matches[0].content).toLowerCase().includes(q)) : [];
  return { results, totalMatches: results.length, totalSessions: results.length };
};

/* ── Wiring ────────────────────────────────────────────────────────────── */

/** Query answers for the stub (convexStub ACME_ANSWERS). */
export const EXTRA_ANSWERS: Record<string, (args: any) => unknown> = {
  "devices:listDevices": () => MACHINES(Date.now()),
  "users:getRecentProjectPaths": () => RECENT_PROJECTS(Date.now()),
  "org:tree": () => ORG_TREE(Date.now()),
  // No links yet, and the viewer may make one: the call screen offers "Invite a guest".
  "callGuests:listGuestLinks": () => [],
  "conversations:searchConversations": search,
  "conversations:searchConversationTitles": (args) => ({ ...search(args), results: search(args).results.filter((r) => r.titleMatch) }),
  "chat:searchMessages": () => ({ results: [] }),
};

/** Rows no query feeds on these screens, written through the store's sync writers. */
export function seedAcmeExtras(s: any, now: number) {
  // The #eng huddle with recording set up, so the call screen offers Record.
  applyLiveRoomsPush(LIVE_ROOMS.map((r) => ({ ...r, recording_configured: true })));
  s.syncTable("pendingPermissions", PERMISSIONS(now));
  s.applyTailMessages(SESSIONS.lead._id, 0, LEAD_TRANSCRIPT(now) as any, null);
  s.applyTailMessages(SESSIONS.ui._id, 0, UI_TRANSCRIPT(now) as any, null);
}

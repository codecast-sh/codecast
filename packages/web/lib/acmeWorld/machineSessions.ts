// The sessions the machine docs open (browser, computer, typecheck, skills,
// Vault, usage limits, Codex Cloud, cloud machines), the Vault they read and
// write, each laptop's Claude and Codex accounts, and the skills catalog.
// The sessions are conversation records a shot opens by address, not inbox
// cards, so every other screen's inbox stays as it was. Scenes a shot moves
// the world into from a step live on `__acmeScene` (machines: a sleeping
// acme-linux, a fresh account). Mobile's Metro reaches this file, so imports
// stay relative.

import { LIMIT_BANNER_PREFIX, agentSetupMarker } from "@codecast/shared/contracts";
import { inboxCrawlWsKey, syncMetaKey } from "../../hooks/syncMetaKeys";
import { useInboxStore } from "../../store/inboxStore";
import type { AcmePart } from "./parts";
import { LAPTOP_ID, LINUX_ID, MACHINE_ROSTER } from "./machines";
import { DAY, HOUR, MIN, PEOPLE, SESSIONS, TEAM_ID, WORKSPACE, cid, session } from "./world";

export const MS = {
  browser: { _id: cid("mbrowser"), short_id: "jx7b2rw", title: "Check staging webhook settings", agent_type: "claude_code" },
  browserSetup: { _id: cid("mbrowsersetup"), short_id: "jx7b5sc", title: "Webhook deliveries on staging", agent_type: "claude_code" },
  watch: { _id: cid("mbrowserwatch"), short_id: "jx7b8wl", title: "Replay a failed delivery on staging", agent_type: "claude_code" },
  computer: { _id: cid("mcomputer"), short_id: "jx7c3mp", title: "Calculator and System Settings check", agent_type: "claude_code" },
  skills: { _id: cid("msecondopinion"), short_id: "jx7s2op", title: "Second opinion on retry backoff", agent_type: "claude_code" },
  check: { _id: cid("mtypecheck"), short_id: "jx7t5ck", title: "Typecheck the webhook service", agent_type: "claude_code" },
  vault: { _id: cid("mvaultrequest"), short_id: "jx7v3rq", title: "Webhook retry tests", agent_type: "claude_code" },
  limit: { _id: cid("mlimit"), short_id: "jx7l6mt", title: "Webhook retry backoff", agent_type: "claude_code" },
  codexNew: { _id: cid("mcodexnew"), short_id: "jx7n2cx", title: "", agent_type: "codex" },
  codexCloud: { _id: cid("mcodexcloud"), short_id: "jx7x4cc", title: "Add jitter to webhook retries", agent_type: "codex" },
  cloud: { _id: cid("mcloudworker"), short_id: "jx7w9cl", title: "Webhook retries on the cloud machine", agent_type: "codex" },
  placeNew: { _id: cid("mplacenew"), short_id: "jx7p3nw", title: "", agent_type: "claude_code" },
} as const;

type Msg = Record<string, unknown>;
const call = (id: string, name: string, input: unknown) => ({ id, name, input: JSON.stringify(input) });
const sh = (id: string, command: string) => call(id, "Bash", { command });
const result = (id: string, content: string, is_error = false) => ({ tool_use_id: id, content, ...(is_error ? { is_error } : {}) });

/* ── Pictures the agent took ─────────────────────────────────────────────── */

/** A window the agent read, drawn small: a title bar, a heading and a few rows. */
function windowPicture(title: string, heading: string, rows: [string, string][], accent = "#2f8f83") {
  const lines = rows
    .map(([k, v], i) => `<text x="28" y="${118 + i * 34}" font-size="15" fill="#5b6770">${k}</text><text x="572" y="${118 + i * 34}" font-size="15" fill="#1f2a30" text-anchor="end">${v}</text><line x1="28" x2="572" y1="${130 + i * 34}" y2="${130 + i * 34}" stroke="#e3e7e8"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" font-family="Helvetica, Arial, sans-serif"><rect width="600" height="400" fill="#ffffff"/><rect width="600" height="34" fill="#eef1f2"/><circle cx="18" cy="17" r="5" fill="#ff5f57"/><circle cx="34" cy="17" r="5" fill="#febc2e"/><circle cx="50" cy="17" r="5" fill="#28c840"/><text x="300" y="22" font-size="13" fill="#5b6770" text-anchor="middle">${title}</text><text x="28" y="78" font-size="22" font-weight="bold" fill="#1f2a30">${heading}</text><rect x="28" y="88" width="60" height="4" fill="${accent}"/>${lines}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const picture = (tool_use_id: string, url: string) => ({ tool_use_id, media_type: "image/svg+xml", preview_url: url });

const SETTINGS_PAGE = windowPicture("staging.acme.dev/settings/webhooks", "Webhook endpoints", [
  ["Stripe events", "Retries on"],
  ["Ledger sync", "Retries on"],
  ["Support Slack", "Retries off"],
]);
const STRIPE_ENDPOINT = windowPicture("staging.acme.dev/settings/webhooks/stripe", "Stripe events", [
  ["Retry policy", "Exponential"],
  ["Max attempts", "5"],
  ["First retry after", "2s"],
  ["Signing secret", "whsec_••••41be"],
]);
const DELIVERIES_PAGE = windowPicture("staging.acme.dev/webhooks/deliveries", "Deliveries", [
  ["evt_1Q8 invoice.paid", "200 · attempt 2"],
  ["evt_1Q7 charge.refunded", "200"],
  ["evt_1Q6 invoice.paid", "502 → retrying"],
]);
const CALCULATOR = windowPicture("Calculator", "1,232.64", [["Expression", "1284 × 0.96"]], "#f19a37");
const BLUETOOTH = windowPicture("System Settings", "Bluetooth", [["Bluetooth", "On"], ["Magic Keyboard", "Connected"]], "#3478f6");
const SOUND = windowPicture("System Settings", "Sound", [["Output", "MacBook Pro Speakers"], ["Output volume", "62%"]], "#3478f6");

/* ── Transcripts ─────────────────────────────────────────────────────────── */

const at = (now: number) => (minsAgo: number) => now - minsAgo * MIN;

const BROWSER = (now: number): Msg[] => {
  const t = at(now);
  return [
    { _id: "hero-mb-1", role: "user", content: "Check the webhook settings page on staging. Is the retry policy on for the Stripe endpoint, and what does it do?", timestamp: t(6) },
    {
      _id: "hero-mb-2",
      role: "assistant",
      content: "Opening staging's webhook settings in my tab.",
      tool_calls: [sh("hero-mb-tc1", "cast browser open https://staging.acme.dev/settings/webhooks && cast browser shot")],
      tool_results: [result("hero-mb-tc1", "tab 4A2CDC7E https://staging.acme.dev/settings/webhooks\nWebhook endpoints · Acme staging")],
      images: [picture("hero-mb-tc1", SETTINGS_PAGE)],
      timestamp: t(5),
    },
    {
      _id: "hero-mb-3",
      role: "assistant",
      content: "",
      tool_calls: [sh("hero-mb-tc2", 'cast browser click "a[href$=\\"/stripe\\"]" && cast browser shot')],
      tool_results: [result("hero-mb-tc2", "tab 4A2CDC7E https://staging.acme.dev/settings/webhooks/stripe\nStripe events · Acme staging")],
      images: [picture("hero-mb-tc2", STRIPE_ENDPOINT)],
      timestamp: t(4),
    },
    {
      _id: "hero-mb-4",
      role: "assistant",
      content:
        "Retries are on for the Stripe endpoint. A failed delivery is retried with exponential backoff, first after 2s, at most 5 attempts, which matches the queue we built. Ledger sync has retries on too; Support Slack has them off, which is fine for a notification channel.",
      timestamp: t(3),
    },
  ];
};

const BROWSER_SETUP = (now: number): Msg[] => {
  const t = at(now);
  return [
    { _id: "hero-ms-1", role: "user", content: "Open the webhook deliveries page on staging and tell me which deliveries are still failing.", timestamp: t(3) },
    {
      _id: "hero-ms-2",
      role: "assistant",
      content: "Opening the deliveries page.",
      tool_calls: [sh("hero-ms-tc1", "cast browser open https://staging.acme.dev/webhooks/deliveries")],
      tool_results: [
        result(
          "hero-ms-tc1",
          `Chrome extension not connected on this machine.\nIn a codecast session the human now sees a setup card under this command: ask them to finish it there, then retry.\n${agentSetupMarker("browser")}`,
          true,
        ),
      ],
      timestamp: t(2),
    },
    { _id: "hero-ms-3", role: "assistant", content: "My browser isn't set up on this machine yet. The card under that step has the two steps; I'll retry once they're done.", timestamp: t(2) },
  ];
};

const WATCH = (now: number): Msg[] => {
  const t = at(now);
  return [
    { _id: "hero-mw-1", role: "user", content: "Retry the failed invoice.paid delivery from the staging dashboard and confirm it lands.", timestamp: t(4) },
    {
      _id: "hero-mw-2",
      role: "assistant",
      content: "Opening the deliveries page and retrying evt_1Q8.",
      tool_calls: [sh("hero-mw-tc1", 'cast browser open https://staging.acme.dev/webhooks/deliveries && cast browser click "button[data-retry=evt_1Q8]" && cast browser shot')],
      tool_results: [result("hero-mw-tc1", "tab 7C1E90B2 https://staging.acme.dev/webhooks/deliveries\nDeliveries · Acme staging")],
      images: [picture("hero-mw-tc1", DELIVERIES_PAGE)],
      timestamp: t(2),
    },
    { _id: "hero-mw-3", role: "assistant", content: "evt_1Q8 landed on its second attempt with a 200. evt_1Q6 is still retrying against the ledger's 502; its next attempt is in 8s.", timestamp: t(1) },
  ];
};

const COMPUTER = (now: number): Msg[] => {
  const t = at(now);
  return [
    { _id: "hero-mc-1", role: "user", content: "In Calculator, work out 1,284 × 0.96. Then check in System Settings whether Bluetooth is on and which sound output is selected.", timestamp: t(5) },
    {
      _id: "hero-mc-2",
      role: "assistant",
      content: "Using Calculator first.",
      tool_calls: [sh("hero-mc-tc1", 'cast computer type-text --app com.apple.calculator "1284*0.96="')],
      tool_results: [result("hero-mc-tc1", "verified: the display reads 1,232.64")],
      images: [picture("hero-mc-tc1", CALCULATOR)],
      timestamp: t(4),
    },
    {
      _id: "hero-mc-3",
      role: "assistant",
      content: "Now reading System Settings without changing anything.",
      tool_calls: [
        sh("hero-mc-tc2", 'cast computer find --app com.apple.systempreferences "Bluetooth"'),
        sh("hero-mc-tc3", 'cast computer find --app com.apple.systempreferences "Output"'),
      ],
      tool_results: [result("hero-mc-tc2", "[14] switch Bluetooth: on"), result("hero-mc-tc3", "[22] row MacBook Pro Speakers: selected")],
      images: [picture("hero-mc-tc2", BLUETOOTH), picture("hero-mc-tc3", SOUND)],
      timestamp: t(3),
    },
    {
      _id: "hero-mc-4",
      role: "assistant",
      content: "1,284 × 0.96 = **1,232.64**.\n\nBluetooth is **on**, and the sound output is **MacBook Pro Speakers**. I only read System Settings; nothing else was changed.",
      timestamp: t(2),
    },
  ];
};

const SKILLS = (now: number): Msg[] => {
  const t = at(now);
  return [
    { _id: "hero-mo-1", role: "user", content: "<command-message>cast-second-opinion</command-message>\n<command-name>/cast-second-opinion</command-name>\n<command-args>the retry backoff change</command-args>", timestamp: t(9) },
    {
      _id: "hero-mo-2",
      role: "user",
      content: "Base directory for this skill: /Users/sarah/.claude/skills/cast-second-opinion\n\n# Second opinion\n\nSend the current change to a different model in a fresh context, verify each finding against the code, and fix the real ones.",
      timestamp: t(9),
    },
    {
      _id: "hero-mo-3",
      role: "assistant",
      content: "Sending the diff to Codex for an independent review.",
      tool_calls: [sh("hero-mo-tc1", 'git diff | cast exec --agent codex "review this diff for bugs"')],
      tool_results: [
        result(
          "hero-mo-tc1",
          "1. retry.ts:31 jitter can push the delay past maxDelay\n2. retry.ts:48 attempt counter is read before it is incremented, so a delivery gets 6 tries\n3. queue.ts:12 consider a priority queue for retries\n4. retry.ts:20 name `backoffMs` could be clearer",
        ),
      ],
      timestamp: t(7),
    },
    {
      _id: "hero-mo-4",
      role: "assistant",
      content: "Checking each finding against the code before touching anything.",
      tool_calls: [
        call("hero-mo-tc2", "Read", { file_path: "src/billing/retry.ts" }),
        call("hero-mo-tc3", "Edit", { file_path: "src/billing/retry.ts", old_string: "return base + jitter", new_string: "return Math.min(base + jitter, maxDelay)" }),
        call("hero-mo-tc4", "Edit", { file_path: "src/billing/retry.ts", old_string: "if (event.attempts > MAX_ATTEMPTS)", new_string: "if (++event.attempts > MAX_ATTEMPTS)" }),
        sh("hero-mo-tc5", "bun test src/billing/retry.test.ts"),
      ],
      tool_results: [
        result("hero-mo-tc2", "export function nextDelay(attempt: number) { … }"),
        result("hero-mo-tc3", "The file src/billing/retry.ts has been updated."),
        result("hero-mo-tc4", "The file src/billing/retry.ts has been updated."),
        result("hero-mo-tc5", "18 pass\n0 fail\nRan 18 tests across 1 file. [192ms]"),
      ],
      timestamp: t(4),
    },
    {
      _id: "hero-mo-5",
      role: "assistant",
      content:
        "Codex found four things. Two were real bugs, both fixed and covered by a test:\n\n1. **Jitter could exceed the cap.** `nextDelay` added jitter after clamping, so a delay could pass `maxDelay`. It now clamps last.\n2. **One attempt too many.** The counter was checked before it was incremented, so a delivery got 6 tries instead of 5.\n\nTwo are judgment calls I left for you:\n\n- A priority queue for retries. Nothing today needs ordering beyond time.\n- Renaming `backoffMs`. It matches the config key, so I kept it.\n\nAll 18 retry tests pass.",
      timestamp: t(2),
    },
  ];
};

const CHECK = (now: number): Msg[] => {
  const t = at(now);
  return [
    { _id: "hero-mk-1", role: "user", content: "Typecheck the webhook service and fix what's red.", timestamp: t(8) },
    {
      _id: "hero-mk-2",
      role: "assistant",
      content: "",
      tool_calls: [sh("hero-mk-tc1", "cast check webhooks")],
      tool_results: [
        result(
          "hero-mk-tc1",
          "webhooks  ✗ 3 errors\nsrc/retry.ts:14:7  TS2322  Type 'string' is not assignable to type 'number'.\nsrc/retry.ts:31:18 TS2345  Argument of type 'WebhookEvent | undefined' is not assignable to parameter of type 'WebhookEvent'.\nsrc/retry.ts:52:3  TS2741  Property 'attempt' is missing in type '{ endpoint: string; }'.",
          true,
        ),
      ],
      timestamp: t(7),
    },
    {
      _id: "hero-mk-3",
      role: "assistant",
      content: "Three errors, all in retry.ts. Fixing each where it is.",
      tool_calls: [
        call("hero-mk-tc2", "Edit", { file_path: "src/retry.ts", old_string: 'const maxDelay = process.env.RETRY_MAX_MS ?? "3600000"', new_string: "const maxDelay = Number(process.env.RETRY_MAX_MS ?? 3_600_000)" }),
        call("hero-mk-tc3", "Edit", { file_path: "src/retry.ts", old_string: "deliver(queue.shift())", new_string: "const next = queue.shift()\n  if (next) deliver(next)" }),
        call("hero-mk-tc4", "Edit", { file_path: "src/retry.ts", old_string: "schedule({ endpoint })", new_string: "schedule({ endpoint, attempt: 1 })" }),
      ],
      tool_results: [
        result("hero-mk-tc2", "The file src/retry.ts has been updated."),
        result("hero-mk-tc3", "The file src/retry.ts has been updated."),
        result("hero-mk-tc4", "The file src/retry.ts has been updated."),
      ],
      timestamp: t(5),
    },
    {
      _id: "hero-mk-4",
      role: "assistant",
      content: "Checking again.",
      tool_calls: [sh("hero-mk-tc5", "cast check webhooks")],
      tool_results: [result("hero-mk-tc5", "webhooks  ✓ typecheck passed, 0 errors (1.8s)")],
      timestamp: t(4),
    },
    {
      _id: "hero-mk-5",
      role: "assistant",
      content: "The webhook service typechecks clean now. The three errors were all in `src/retry.ts`: the max delay was read as a string, the queue's next event could be undefined, and a new retry was scheduled without its attempt number.",
      timestamp: t(3),
    },
  ];
};

const VAULT_REQUEST_SHORT = "sec-990";

const VAULT = (now: number): Msg[] => {
  const t = at(now);
  return [
    { _id: "hero-mv-1", role: "user", content: "Run the webhook retry tests against Stripe's test mode.", timestamp: t(5) },
    {
      _id: "hero-mv-2",
      role: "assistant",
      content: "The tests need a Stripe test key and the team Vault has none. Asking for one; the value goes straight into the Vault, never into this conversation.",
      tool_calls: [sh("hero-mv-tc1", 'cast vault request stripe-test --kind key --env STRIPE_SECRET_KEY --why "run webhook retry tests"')],
      tool_results: [result("hero-mv-tc1", `requested ${VAULT_REQUEST_SHORT} stripe-test in Acme`)],
      timestamp: t(4),
    },
  ];
};

const LIVE_LIMIT_AGO = 2 * MIN;
const LIMIT = (now: number): Msg[] => {
  const t = at(now);
  return [
    { _id: "hero-ml-1", role: "user", content: "Tune the retry backoff so a ledger restart never exhausts all five attempts.", timestamp: t(240) },
    { _id: "hero-ml-2", role: "assistant", content: `${LIMIT_BANNER_PREFIX} · resets 2pm (UTC)`, timestamp: t(200) },
    { _id: "hero-ml-3", role: "assistant", content: "Continuing on the personal account. The ledger restart takes about 40s, so the schedule now waits 2s, 4s, 8s, 16s and 32s: the fifth attempt lands after it is back.", timestamp: t(150) },
    { _id: "hero-ml-4", role: "user", content: "Run the full replay of last week's failures with the new schedule.", timestamp: t(20) },
    { _id: "hero-ml-5", role: "assistant", content: "Replaying 1,284 failed deliveries under the new schedule.", timestamp: t(18) },
    { _id: "hero-ml-6", role: "assistant", content: "You've hit your session limit · resets 11:30pm (UTC)", timestamp: now - LIVE_LIMIT_AGO },
  ];
};

const CODEX_CLOUD = (now: number): Msg[] => {
  const t = at(now);
  return [
    { _id: "hero-mx-1", role: "user", content: "Add jitter to webhook retries in acme/webhooks so a burst of failures doesn't retry in lockstep.", timestamp: t(30) },
    { _id: "hero-mx-2", role: "assistant", content: "Added full jitter to `nextDelay` in src/retry.ts: each delay is now a random value between half and all of the exponential step. Tests cover the bounds, and 3 of 3 attempts agree on the change.", timestamp: t(12) },
  ];
};

const CLOUD = (now: number): Msg[] => {
  const t = at(now);
  return [
    { _id: "hero-mn-1", role: "user", content: "On the cloud machine: run the retry replay against a copy of production's failed deliveries and report the recovery rate per attempt.", timestamp: t(25) },
    {
      _id: "hero-mn-2",
      role: "assistant",
      content: "Replaying in this worktree so the main checkout stays untouched.",
      tool_calls: [sh("hero-mn-tc1", "bun run replay --from fixtures/failed-deliveries.jsonl")],
      tool_results: [result("hero-mn-tc1", "replayed 1,284 deliveries\nattempt 1  41%\nattempt 2  77%\nattempt 3  89%\nattempt 5  96%")],
      timestamp: t(10),
    },
    { _id: "hero-mn-3", role: "assistant", content: "96% of failed deliveries land by the fifth attempt. The 4% left all point at endpoints that answer 410 Gone, which the dead-letter queue now catches.", timestamp: t(1) },
  ];
};

/* ── The conversation records ────────────────────────────────────────────── */

const onLaptop = { owner_device_id: LAPTOP_ID };
const onLinux = { owner_device_id: LINUX_ID, worktree_name: "webhook-replay", worktree_branch: "codecast/webhook-replay", git_branch: "codecast/webhook-replay" };

/** The laptop copy of Maya's cloud session, in step 12s ago. */
const mirror = (now: number) => ({
  device_id: LAPTOP_ID,
  status: "live",
  mode: "two_way",
  path: "/Users/alex/src/billing/.codecast/worktrees/webhook-replay",
  last_landed_at: now - 12_000,
  to_laptop: 3,
  at: now - 12_000,
});

/** A teammate's session names its person on their messages; Alex's own read "You". */
const withOwner = (row: Record<string, any>) => {
  const p = Object.values(PEOPLE).find((x) => x._id === row.user_id);
  return p && p._id !== PEOPLE.me._id ? { ...row, user: { name: p.name, email: p.email, avatar_url: p.image } } : row;
};

export const MACHINE_SESSION_ROWS = (now: number) => MACHINE_SESSIONS_RAW(now).map(withOwner);

const MACHINE_SESSIONS_RAW = (now: number) => [
  session(now, MS.browser, { ago: 3 * MIN, waiting: "done", project: "~/src/billing", messages: 4, state: "Stripe endpoint retries are on, 5 attempts\nStatus: reported", extra: onLaptop }),
  session(now, MS.browserSetup, { ago: 2 * MIN, waiting: "blocked", project: "~/src/billing", messages: 3, owner: PEOPLE.maya, state: "Needs the browser set up\nBlocked: Chrome extension not paired" }),
  session(now, MS.watch, { ago: 20_000, waiting: "working", project: "~/src/billing", messages: 3, owner: PEOPLE.maya, state: "Retrying a failed delivery on staging" }),
  session(now, MS.computer, { ago: 2 * MIN, waiting: "done", project: "~", messages: 4, owner: PEOPLE.sarah, state: "Calculator and System Settings read\nStatus: nothing changed" }),
  session(now, MS.skills, { ago: 2 * MIN, waiting: "done", project: "~/src/billing", messages: 5, owner: PEOPLE.sarah, state: "Second opinion: 2 bugs fixed, 2 calls left to you" }),
  session(now, MS.check, { ago: 3 * MIN, waiting: "done", project: "~/src/webhooks", messages: 5, state: "Typecheck passes\nStatus: 3 errors fixed in retry.ts", extra: onLaptop }),
  session(now, MS.vault, { ago: 4 * MIN, waiting: "blocked", project: "~/src/billing", messages: 2, owner: PEOPLE.maya, state: "Waiting on stripe-test from the Vault\nBlocked: needs a Stripe test key" }),
  session(now, MS.limit, {
    ago: LIVE_LIMIT_AGO,
    waiting: "blocked",
    project: "~/src/billing",
    messages: 6,
    state: "Parked on the session limit\nNext: resumes when the window resets",
    extra: { ...onLaptop, cc_account: "work", pending_api_error: true, pending_api_error_at: now - LIVE_LIMIT_AGO },
  }),
  session(now, MS.codexNew, { ago: 0, waiting: "done", project: "~/src/webhooks", messages: 0, extra: { ...onLaptop, model: "cloud:x3" } }),
  session(now, MS.codexCloud, { ago: 12 * MIN, waiting: "done", project: "~/src/webhooks", messages: 2, state: "Jitter added to webhook retries\nStatus: 3 of 3 attempts agree", extra: { ...onLaptop, session_id: "task_e_68a1acme7jitter", model: "cloud:x3" } }),
  session(now, MS.cloud, { ago: 40_000, waiting: "working", project: "~/src/billing", messages: 3, owner: PEOPLE.maya, state: "Replaying failed deliveries on acme-linux\nStatus: 96% land by attempt 5", extra: { ...onLinux, local_mirror: mirror(now) } }),
  session(now, MS.placeNew, { ago: 0, waiting: "done", project: "~/src/billing", messages: 0, extra: { owner_device_id: LINUX_ID } }),
];

const TRANSCRIPTS: [string, (now: number) => Msg[]][] = [
  [MS.browser._id, BROWSER],
  [MS.browserSetup._id, BROWSER_SETUP],
  [MS.watch._id, WATCH],
  [MS.computer._id, COMPUTER],
  [MS.skills._id, SKILLS],
  [MS.check._id, CHECK],
  [MS.vault._id, VAULT],
  [MS.limit._id, LIMIT],
  [MS.codexCloud._id, CODEX_CLOUD],
  [MS.cloud._id, CLOUD],
];

/* ── The Vault ───────────────────────────────────────────────────────────── */

const SECRET = {
  request: cid("secstripetest"),
  stagingDb: cid("secstagingdb"),
  githubApp: cid("secgithubapp"),
  vercel: cid("secvercel"),
  openai: cid("secopenaialex"),
  prodDb: cid("secproddb"),
};

export const SECRETS = (now: number) => {
  const base = { workspace: WORKSPACE, team_id: TEAM_ID, created_by: PEOPLE.me._id, created_by_name: PEOPLE.me.name, created_at: now - 30 * DAY, updated_at: now - DAY, value_updated_at: now - 2 * DAY };
  return [
    { ...base, _id: SECRET.request, short_id: VAULT_REQUEST_SHORT, name: "stripe-test", kind: "key", status: "requested", env: ["STRIPE_SECRET_KEY"], requested_by_name: MS.vault.title, requested_from_conversation: MS.vault._id, request_why: "run webhook retry tests", created_by: PEOPLE.maya._id, created_by_name: PEOPLE.maya.name, created_at: now - 4 * MIN, updated_at: now - 4 * MIN },
    { ...base, _id: SECRET.stagingDb, short_id: "sec-412", name: "staging-db", kind: "key", status: "ready", env: ["DATABASE_URL"], fingerprint: "postg…c9a1", use_count: 41, last_used_at: now - 2 * HOUR, last_used_by_conversation: SESSIONS.lead._id, version_count: 1 },
    { ...base, _id: SECRET.prodDb, short_id: "sec-413", name: "prod-db", kind: "key", status: "ready", env: ["DATABASE_URL"], fingerprint: "postg…7e02", ask_first: true, use_count: 4, last_used_at: now - 3 * DAY, last_used_by_conversation: SESSIONS.api._id },
    { ...base, _id: SECRET.githubApp, short_id: "sec-415", name: "github-app", kind: "key", status: "ready", env: ["GITHUB_APP_PRIVATE_KEY"], fingerprint: "-----…KEY-", ask_first: true, use_count: 7, last_used_at: now - DAY, last_used_by_conversation: SESSIONS.stripe._id },
    { ...base, _id: SECRET.vercel, short_id: "sec-418", name: "vercel.com", kind: "signin", status: "ready", sites: ["vercel.com"], signin_expires_at: now + 2 * DAY, use_count: 12, last_used_at: now - 3 * HOUR, last_used_by_conversation: SESSIONS.ui._id },
    { ...base, workspace: `user:${PEOPLE.me._id}`, team_id: undefined, _id: SECRET.openai, short_id: "sec-421", name: "openai-alex", kind: "key", status: "ready", env: ["OPENAI_API_KEY"], fingerprint: "sk-pr…x7Qa", use_count: 9, last_used_at: now - 5 * HOUR, last_used_by_conversation: SESSIONS.rate._id },
  ];
};

const event = (id: string, kind: string, ago: number, now: number, who: { name: string }, s?: { _id: string; short_id: string; title: string }, purpose?: string) => ({
  _id: cid(`ev${id}`),
  kind,
  at: now - ago,
  actor_name: who.name,
  purpose,
  ...(s ? { conversation_id: s._id, session_short_id: s.short_id, session_title: s.title } : {}),
});

const SECRET_EVENTS = (ref: string, now: number) =>
  ref === SECRET.stagingDb
    ? [
        event("sdb1", "injected", 2 * HOUR, now, PEOPLE.me, SESSIONS.lead, "cast vault run"),
        event("sdb2", "read", 5 * HOUR, now, PEOPLE.maya, SESSIONS.ui, "cast vault get"),
        event("sdb3", "injected", 26 * HOUR, now, PEOPLE.me, SESSIONS.api, "cast vault run"),
        event("sdb4", "rotated", 2 * DAY, now, PEOPLE.sarah),
        event("sdb5", "created", 30 * DAY, now, PEOPLE.me),
      ]
    : [];

const SECRET_VERSIONS = (ref: string, now: number) =>
  ref === SECRET.stagingDb ? [{ _id: cid("verstagingdb1"), rotated_at: now - 2 * DAY, rotated_by_name: PEOPLE.sarah.name, fingerprint: "postg…41be", expires_at: now + 5 * DAY }] : [];

/* ── Accounts, skills, decisions ─────────────────────────────────────────── */

const ACCOUNT_PROFILES = (now: number) => ({
  devices: [
    {
      device_id: LAPTOP_ID,
      label: "Alex's MacBook Pro",
      is_remote: false,
      online: true,
      active_email: "alex@acme.dev",
      session_tokens: true,
      auto_continue: true,
      auto_switch: false,
      ask_first: false,
      profiles: [
        { name: "work", email: "alex@acme.dev", subscription: "max", tier: "default_claude_max_20x", usage: { fetched_at: now - MIN, session: { percent: 92, resets_at: now + 2 * HOUR }, weekly: { percent: 40, resets_at: now + 3 * DAY } } },
        { name: "personal", email: "alex.rivera@hey.example", subscription: "pro", usage: { fetched_at: now - MIN, session: { percent: 10, resets_at: now + 4 * HOUR }, weekly: { percent: 22, resets_at: now + 5 * DAY } } },
      ],
      codex_accounts: { active_email: "alex@acme.dev", active_expires_at: now + 30 * DAY, profiles: [{ name: "codex", email: "alex@acme.dev", subscription: "plus" }] },
    },
  ],
});

const SKILL_CATALOG = JSON.stringify({
  global: [
    { name: "cast-pickup", description: "Rehydrate before working: the bound task, pinned state and recent team work, then the next three actions" },
    { name: "cast-handoff", description: "Package the current work so the next session or a teammate can continue without reading this thread" },
    { name: "cast-second-opinion", description: "Get an independent review from a different model, verify its findings and fold the real ones in" },
    { name: "cast-ship", description: "Take finished work through to merge: topical commits, the pull request, and its review comments" },
    { name: "cast-verify", description: "Check the change does what it claims, end to end, before calling it done" },
  ],
});

/** The Ask first read Maya's session waits on, as the server words it (convex secrets.ts). */
const ASK_FIRST_DECISION = (now: number) => ({
  _id: cid("decaskfirstproddb"),
  short_id: "sd-4120",
  conversation_id: MS.vault._id,
  session_id: `${MS.vault._id}-sess`,
  user_id: PEOPLE.me._id,
  question: `${MS.vault.title} asks to use prod-db`,
  context_md: "Why: count the webhooks stuck in the production retry queue\n\nprod-db (sec-413) is Ask first in the Vault. Approve lets this session read it until the session ends, for 12 hours at most, and a new value asks again.",
  options: [{ label: "Approve for this session" }, { label: "Deny" }],
  kind: "single",
  category: "access",
  blocking: true,
  status: "pending",
  holder: { kind: "user", id: PEOPLE.me._id },
  holder_key: `user:${PEOPLE.me._id}`,
  asked_user_ids: [PEOPLE.me._id],
  passed_to: null,
  in_queue: true,
  team_id: TEAM_ID,
  workspace: WORKSPACE,
  session_title: MS.vault.title,
  project_path: "~/src/billing",
  created_at: now - MIN,
  updated_at: now - MIN,
  asked_message_count: 2,
  problem_severity: null,
});

/* ── Scenes ──────────────────────────────────────────────────────────────── */

function installScenes() {
  // The live app store: a hot update re-evaluates this module, and its import could be a stale copy.
  const st = () => ((globalThis as any).__inboxStore ?? useInboxStore).getState() as any;
  (globalThis as any).__acmeScene = {
    ...(globalThis as any).__acmeScene,
    /** acme-linux stopped: Settings > Devices reads it Asleep with its cost. */
    linuxAsleep() {
      const now = Date.now();
      st().setMachineRoster(
        MACHINE_ROSTER(now).map((d: any) =>
          d.device_id === LINUX_ID ? { ...d, online: false, last_seen: now - 3 * HOUR, cloud_host: { ...d.cloud_host, state: "stopped", at: now - MIN } } : d,
        ),
      );
    },
    /** Every machine as the world has them. */
    machinesAwake() {
      st().setMachineRoster(MACHINE_ROSTER(Date.now()));
    },
    /** The Ask first decision on prod-db in the queue. */
    askFirst() {
      const row = ASK_FIRST_DECISION(Date.now());
      st().syncRecord("sessionDecisions", row._id, row);
    },
    /** A fresh account in the desktop app: no session synced yet, nothing on this
     *  machine set up. Empties the inbox through the store's own writers, marks the
     *  sessions floor as cut (the server answered: none), and stands in for the
     *  Mac app's shell, which reports a daemon not yet installed. */
    fresh() {
      (globalThis as any).__acmeHoldSessions = true;
      const s = st();
      s.dropRows("sessions", Object.keys(s.sessions));
      s.recordSyncMeta(syncMetaKey("sessions", inboxCrawlWsKey(PEOPLE.me._id)), { backfilledAt: Date.now() });
      const w = globalThis as any;
      w.__CODECAST_ELECTRON__ = {
        ...w.__CODECAST_ELECTRON__,
        getDaemonSetup: async () => ({ supported: true, installed: false, linked: false, running: false }),
        runDaemonSetup: async () => ({ ok: true }),
      };
    },
    /** One of these sessions as an inbox row: the conversation pane draws a
     *  transcript only for a session the inbox holds. */
    open(id: string) {
      const row = MACHINE_SESSION_ROWS(Date.now()).find((r) => r._id === id);
      if (row) st().syncRecord("sessions", row._id, row);
    },
  };
}

export const MACHINE_SESSIONS_PART: AcmePart = {
  name: "machine-sessions",
  answers: {
    // A session the world holds only as a conversation record (no inbox card) opens by
    // address the way a teammate's session does: the server resolves it, then the inbox shows it.
    "conversations:resolveConversation": (args) => {
      const row = (useInboxStore.getState() as any).conversations?.[String(args?.id)];
      return row ? { access_level: row.user_id === PEOPLE.me._id ? "owner" : "team", conversation_id: row._id } : undefined;
    },
    "secrets:list": () => SECRETS(Date.now()),
    "secrets:events": (args) => SECRET_EVENTS(String(args?.ref), Date.now()),
    "secrets:versions": (args) => SECRET_VERSIONS(String(args?.ref), Date.now()),
    "accountSwitch:listAccountProfiles": () => ACCOUNT_PROFILES(Date.now()),
    "accountPool:listPool": () => [],
    "users:getMySkills": () => ({ skills: SKILL_CATALOG }),
  },
  seed: (s, now) => {
    installScenes();
    // This window runs on Alex's laptop, the way the desktop app's local daemon reports it.
    useInboxStore.setState({ localDevice: { viewer: PEOPLE.me._id, deviceId: LAPTOP_ID } });
    for (const row of MACHINE_SESSION_ROWS(now)) s.syncRecord("conversations", row._id, row);
    for (const [id, messages] of TRANSCRIPTS) s.applyTailMessages(id, 0, messages(now) as any, null);
  },
};

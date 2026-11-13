// Teammates' sessions on the webhook retry work that the recall surfaces name
// (search hits, the stable context feed, session blame, the memory answer)
// without each being an inbox row of Alex's. One list, so every surface names
// the same sessions with the same titles. Mobile's Metro reaches this file, so
// imports stay relative.

import { DAY, HOUR, MIN, PEOPLE, SESSIONS, cid, type Person } from "./world";

export type TeamSession = {
  _id: string;
  short_id: string;
  title: string;
  agent_type: string;
  who: Person;
  ago: number;
  project: string;
  messages: number;
  state: "working" | "needs_input" | "done";
};

// Ids start with distinct letters: the stable context's exclude list matches
// a session by its 7-character prefix, which for cid() is "hero" + 3 letters.
export const TEAM_SESSIONS = {
  backoff: { _id: cid("bckoffmaya"), short_id: "jx7p2mb", title: "Backoff schedule for webhook retries", agent_type: "claude_code", who: PEOPLE.maya, ago: 2 * DAY, project: "~/src/billing", messages: 58, state: "done" },
  replay: { _id: cid("rplysarah"), short_id: "jx7q8sr", title: "Replay dropped Stripe webhooks", agent_type: "codex", who: PEOPLE.sarah, ago: 26 * HOUR, project: "~/src/support-tools", messages: 18, state: "done" },
  dlq: { _id: cid("dlqmaya"), short_id: "jx7r4dl", title: "Dead-letter queue for poisoned events", agent_type: "cursor", who: PEOPLE.maya, ago: 5 * HOUR, project: "~/src/billing", messages: 37, state: "needs_input" },
  hmac: { _id: cid("hmcsarah"), short_id: "jx7s1hm", title: "Sign webhook payloads with HMAC", agent_type: "claude_code", who: PEOPLE.sarah, ago: 3 * HOUR, project: "~/src/billing", messages: 44, state: "working" },
  sigrot: { _id: cid("sgnmaya"), short_id: "jx7t6sg", title: "Webhook signature rotation", agent_type: "claude_code", who: PEOPLE.maya, ago: 9 * HOUR, project: "~/src/billing", messages: 41, state: "done" },
  oncall: { _id: cid("pgrsarah"), short_id: "jx7u3pg", title: "Page on-call when retries run out", agent_type: "codex", who: PEOPLE.sarah, ago: DAY, project: "~/src/infra", messages: 12, state: "done" },
  ledger: { _id: cid("ldgmaya"), short_id: "jx7v9lg", title: "Ledger restart drops webhooks", agent_type: "claude_code", who: PEOPLE.maya, ago: 3 * DAY, project: "~/src/billing", messages: 26, state: "done" },
  idem: { _id: cid("idmsarah"), short_id: "jx7w2id", title: "Idempotency keys on webhook handlers", agent_type: "claude_code", who: PEOPLE.sarah, ago: 2 * DAY + 4 * HOUR, project: "~/src/billing", messages: 33, state: "done" },
  loadtest: { _id: cid("lodjordan"), short_id: "jx7x5ld", title: "Load test the retry queue", agent_type: "pi", who: PEOPLE.jordan, ago: 7 * HOUR, project: "~/src/gateway", messages: 21, state: "done" },
  docs: { _id: cid("docpriya"), short_id: "jx7y7dc", title: "Retry policy page for support", agent_type: "cursor", who: PEOPLE.priya, ago: 4 * HOUR, project: "~/src/docs", messages: 15, state: "working" },
} satisfies Record<string, TeamSession>;

/** Alex's own sessions on the same work, in the same shape. */
export const OWN_SESSIONS: TeamSession[] = [
  { ...SESSIONS.lead, who: PEOPLE.me, ago: 0, project: "~/src/billing", messages: 64, state: "working" },
  { ...SESSIONS.api, who: PEOPLE.me, ago: MIN, project: "~/src/billing", messages: 12, state: "needs_input" },
  { ...SESSIONS.ui, who: PEOPLE.me, ago: 40_000, project: "~/src/billing", messages: 18, state: "working" },
  { ...SESSIONS.stripe, who: PEOPLE.me, ago: 25 * MIN, project: "~/src/billing", messages: 87, state: "done" },
  { ...SESSIONS.pg, who: PEOPLE.me, ago: 2 * HOUR, project: "~/src/billing", messages: 41, state: "done" },
];

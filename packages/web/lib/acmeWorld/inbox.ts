// The rest of the team's webhook work in the inbox: Maya's and Sarah's
// sessions beside Alex's, one session parked on a wake (Dormant) and one Alex
// pinned. Agents across the fleet: Claude Code, Codex, Cursor and Gemini.

import type { AcmePart } from "./parts";
import { HOUR, MIN, PEOPLE, cid, session } from "./world";

export const TEAM_SESSIONS = {
  dlq: { _id: cid("sdlq"), short_id: "jx7p2dl", title: "Dead-letter queue for poisoned events", agent_type: "cursor" },
  hmac: { _id: cid("shmac"), short_id: "jx7q8hm", title: "Sign webhook payloads with HMAC", agent_type: "gemini" },
  rerun: { _id: cid("srerun"), short_id: "jx7r4rt", title: "Re-run retry tests after the ledger restart", agent_type: "claude_code" },
  policy: { _id: cid("spolicy"), short_id: "jx7s6bp", title: "Retry backoff policy", agent_type: "codex" },
} as const;

/** Shared with the team: a teammate's session the team can read. */
const SHARED = { is_private: false, team_visibility: "full" };

const sessions = (now: number) => [
  session(now, TEAM_SESSIONS.dlq, {
    ago: 50_000,
    waiting: "working",
    project: "~/src/billing",
    messages: 41,
    owner: PEOPLE.maya,
    extra: SHARED,
    state: "Poisoned events park in a dead-letter table after the fifth attempt\nStatus: replaying last week's 31 poisoned events",
  }),
  session(now, TEAM_SESSIONS.hmac, {
    ago: 9 * MIN,
    waiting: "blocked",
    project: "~/src/billing",
    messages: 22,
    owner: PEOPLE.sarah,
    extra: SHARED,
    state: "Signatures are in, rotation is not\nBlocked: rotate secrets per endpoint or per account?",
  }),
  session(now, TEAM_SESSIONS.rerun, {
    ago: 35 * MIN,
    waiting: "done",
    project: "~/src/billing",
    messages: 16,
    state: "Waiting on the ledger restart at 2:00\nStatus: a trigger re-runs the retry suite at 2:15",
    // The daemon carries the declaration as the agent status while the session is live.
    extra: { agent_status: "dormant", thread_state_status: "dormant" },
  }),
  session(now, TEAM_SESSIONS.policy, {
    ago: 3 * HOUR,
    waiting: "done",
    project: "~/src/billing",
    messages: 29,
    state: "Backoff policy written up: 2s, 4s, 8s, 16s with jitter, 5 attempts\nStatus: doc shared in #eng",
    extra: { inbox_pinned_at: now - 2 * HOUR },
  }),
];

export const INBOX_PART: AcmePart = { name: "inbox", sessions };

/**
 * The desk's shared story: the inbox rows and the lead's transcript that the
 * inbox, conversation and fan-out chapters render, with the film-time cues
 * internal to them. Pure data, so the motion files read the same cues and
 * entry heights the views render from. Timestamps are offsets from the hero's
 * mount-time `now` (see story.ts).
 */

import type { InboxSession } from "@/store/inboxStore";
import type { Device } from "@/components/DeviceBadge";
import { CAMERA, type Beat } from "../world";
import { CUES, HOUR, MIN, OBJECTS, PROMPT, SESSIONS } from "./story";

/** Chapter-internal cues on the desk, in film seconds. Cross-chapter ones are in story.ts. */
export const DESK = {
  /** The agent icons pulse down the inbox column, 90ms apart. */
  iconPulse: 2.8,
  iconStep: 0.09,
  /** The conversation pane fades from the previous session to the lead. */
  paneSwap: CUES.leadSelected,
  thinking: 9.4,
  edit: 10.2,
  bash: 11.0,
  /** The steer: typed into the composer, then sent. */
  steerType: 12.6,
  steerRate: 22,
  steerSent: 13.95,
  ack: 14.5,
} as const;

export const STEER = "keep the max at 5 attempts";

/* ── The inbox ─────────────────────────────────────────────────────────── */

const base = { user_id: "hero-u-ashot", is_idle: false, has_pending: false } as const;

const row = (now: number, r: Partial<InboxSession> & { _id: string; title: string; agent_type: string; ago: number }): InboxSession => {
  const { ago, ...rest } = r;
  return {
    ...base,
    session_id: `${r._id}-sess`,
    message_count: 0,
    started_at: now - ago - 40 * MIN,
    ...rest,
    updated_at: now - ago,
  } as unknown as InboxSession;
};

export const CLOUD_HOST: Device = {
  device_id: "hero-dev-linux",
  label: OBJECTS.hosts.cloud,
  platform: "linux",
  hostname: OBJECTS.hosts.cloud,
  last_seen: 0,
  is_remote: true,
  online: true,
  local_project_roots: [],
};

/** The six sessions already in the inbox when the film opens, five agents between them, in the list's order. */
export function inboxRows(now: number): { session: InboxSession; isLive: boolean; isUnread?: boolean; runHost?: Device }[] {
  return [
    {
      isLive: true,
      session: row(now, {
        _id: "hero-s-pg", title: "Migrate invoices to Postgres 16", agent_type: "codex", ago: 2 * MIN,
        project_path: "/u/src/billing", git_root: "/u/src/billing", message_count: 41,
        last_user_message: "run the migration against staging first",
      }),
    },
    {
      isLive: false,
      session: row(now, {
        _id: "hero-s-e2e", title: "Fix flaky checkout e2e", agent_type: "cursor", ago: 6 * MIN,
        project_path: "/u/src/web", git_root: "/u/src/web", message_count: 28,
        thread_state: "Which card should the e2e use?\nBlocked: the 4242 test card is rate limited in CI",
        thread_state_status: "blocked", thread_state_at: now - 6 * MIN, thread_state_msg_count: 28,
      }),
    },
    {
      isLive: true,
      runHost: CLOUD_HOST,
      session: row(now, {
        _id: "hero-s-rate", title: "Rate limiter for the public API", agent_type: "pi", ago: 4 * MIN,
        project_path: "/u/src/gateway", git_root: "/u/src/gateway", message_count: 63,
        worktree_name: "rate-limit", worktree_branch: "feat/rate-limit",
        thread_state: "Token bucket is in, load test next\nStatus: 4,000 req/s holds on one node",
        thread_state_status: "working", thread_state_at: now - 4 * MIN, thread_state_msg_count: 63,
      }),
    },
    {
      isLive: false,
      session: row(now, {
        _id: "hero-s-stripe", title: "Upgrade Stripe SDK to v14", agent_type: "gemini", ago: 25 * MIN,
        project_path: "/u/src/billing", git_root: "/u/src/billing", message_count: 87,
        thread_state: "Stripe SDK on v14, 38 call sites migrated\nStatus: tests green, PR open for review",
        thread_state_status: "done", thread_state_at: now - 25 * MIN, thread_state_msg_count: 87,
        pr_status: { pr_id: "hero-pr-stripe", repository: OBJECTS.pr.repository, number: 479, state: "open", at: now - 26 * MIN },
      }),
    },
    {
      isLive: false,
      isUnread: true,
      session: row(now, {
        _id: "hero-s-audit", title: "Audit log export to S3", agent_type: "codex", ago: 47 * MIN,
        project_path: "/u/src/infra", git_root: "/u/src/infra", message_count: 34,
        idle_summary: "Export runs nightly and writes a manifest per day",
      }),
    },
    {
      isLive: false,
      session: row(now, {
        _id: "hero-s-email", title: "Onboarding email copy", agent_type: "claude_code", ago: 3 * HOUR,
        project_path: "/u/src/web", git_root: "/u/src/web", message_count: 19,
        idle_summary: "Drafted three welcome emails with plain text fallbacks",
      }),
    },
  ];
}

/** The lead's message count as the film moves: its row and its header read it. */
export const leadMessages = (t: number) =>
  t < CUES.prompt ? 0 : t < DESK.thinking ? 1 : t < DESK.edit ? 2 : t < DESK.bash ? 3 : t < CUES.testsPass ? 4 : t < DESK.steerSent ? 5 : t < DESK.ack ? 6 : t < CUES.spawnA ? 7 : t < CUES.spawnB ? 8 : 9;

/** The lead's row at a stage of the film. */
export function leadRow(now: number, messages: number, steered: boolean): InboxSession {
  return row(now, {
    _id: SESSIONS.lead.id, title: SESSIONS.lead.title, agent_type: SESSIONS.lead.agent, ago: 0,
    project_path: "/u/src/billing", git_root: "/u/src/billing", message_count: messages,
    started_at: now - 20_000,
    last_user_message: steered ? STEER : PROMPT,
  });
}

/** The worker's state on its row: booting, then (for the API worker) asking and approved. */
export type WorkerPhase = "working" | "asking" | "approved";

export const apiWorkerPhase = (t: number): WorkerPhase =>
  t >= CUES.permissionApproved ? "approved" : t >= CUES.permissionAsk ? "asking" : "working";

export function workerRow(now: number, which: "api" | "ui", phase: WorkerPhase): InboxSession {
  const s = SESSIONS[which];
  const asking = phase === "asking";
  return row(now, {
    _id: s.id, title: s.title, agent_type: s.agent, ago: 0,
    project_path: "/u/src/billing", git_root: "/u/src/billing",
    message_count: which === "api" ? (phase === "approved" ? 14 : 9) : 6,
    is_subagent: true,
    parent_conversation_id: SESSIONS.lead.id,
    started_at: now - 15_000,
    ...(asking
      ? {
          thread_state: "Needs approval: npm test --workspace packages/api",
          thread_state_status: "blocked", thread_state_at: now, thread_state_msg_count: 9,
        }
      : phase === "approved"
        ? {
            thread_state: "212 passed\nStatus: retry endpoint is green",
            thread_state_status: "working", thread_state_at: now, thread_state_msg_count: 14,
          }
        : {}),
  });
}

/** The camera hold the film is in or last passed: local interaction state is keyed on it, so it resets when the camera moves on. */
export const holdIndex = (t: number) => {
  let i = 0;
  CAMERA.forEach((h, k) => {
    if (t >= h.t0) i = k;
  });
  return i;
};

/** Rows in the inbox before the lead lands, and the measured heights of the rows that land (px). */
export const INBOX_ROWS = 6;
export const LIST_ROW_H = { lead: 70, worker: 23 };

/**
 * Glide a stack by `h` px when an entry of that height mounts into it at
 * `cue` (React mounts it then, so the stack's resting layout never depends on
 * `h`). Two pushes: one holds the stack `h` away and eases it home from the
 * cue, the other cancels it exactly until the cue. So the stack sits still
 * before the cue, appears where it was at the cue, and settles into its new
 * place; a wrong `h` only shortens or lengthens the glide.
 */
export function glideOver(id: string, cue: number, h: number, dur = 0.65): Beat[] {
  return [
    { id, cue, dur, preset: "push", y: h },
    { id, cue, dur: 0.0001, preset: "push", y: -h },
  ];
}

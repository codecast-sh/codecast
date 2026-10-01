/**
 * Chapter 4, Approve: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * The API worker (codex) asks to run its package's tests. The same ask is the
 * desk's permission stack, the daemon's push (its title is the daemon's,
 * cli/src/daemon.ts "codecast - Permission needed", its body the command),
 * the app's notification row and the phone's permission card.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { PermissionViewItem } from "@/components/PermissionCard";
import { MIN, SESSIONS } from "./story";

export const entities: Record<string, EntityFixture> = {};

export const PERMISSION: PermissionViewItem = {
  _id: "hero-p1",
  tool_name: "Bash",
  arguments_preview: "npm test --workspace packages/api",
  status: "pending",
};

export const PUSH = { title: "codecast - Permission needed", body: PERMISSION.arguments_preview! };

const apiConversation = { _id: SESSIONS.api.id, short_id: SESSIONS.api.shortId, title: SESSIONS.api.title, agent_type: SESSIONS.api.agent, project_path: SESSIONS.api.project };

/** The app's notification rows, as the notifications query returns them; `ago` is ms before mount. */
export const NOTIFICATIONS = {
  ask: { _id: "hero-n-ask", type: "permission_request", title: PUSH.title, message: PUSH.body, conversation: apiConversation, ago: 4_000 },
  done: {
    _id: "hero-n-done",
    type: "session_idle",
    title: "codecast - Session ready",
    message: "212 passed in packages/api. The retry endpoint is ready for the dashboard.",
    conversation: apiConversation,
    ago: 0,
  },
};

const conv = (_id: string, title: string, agent_type: string) => ({ _id, title, agent_type, project_path: "~/src/billing" });

/** What was already in the app's notifications, read, under the new rows: the inbox's other sessions (fixtures/desk.ts). */
export const EARLIER = [
  { _id: "hero-n-stripe", type: "session_idle", title: "codecast - Session ready", message: "Tests green on Stripe v14. PR #479 is open for review.", conversation: conv("hero-s-stripe", "Upgrade Stripe SDK to v14", "gemini"), ago: 25 * MIN },
  { _id: "hero-n-mention", type: "mention", title: "Sarah mentioned you", message: "can you look at the 4242 card limit on checkout e2e?", conversation: conv("hero-s-e2e", "Fix flaky checkout e2e", "cursor"), ago: 38 * MIN },
  { _id: "hero-n-audit", type: "session_idle", title: "codecast - Session ready", message: "Export runs nightly and writes a manifest per day.", conversation: conv("hero-s-audit", "Audit log export to S3", "codex"), ago: 47 * MIN },
];

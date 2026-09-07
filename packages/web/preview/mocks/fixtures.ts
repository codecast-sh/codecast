/**
 * Fixture world for the migration-panel preview (preview/migrate.html): three
 * machines, a spread of sessions on each, and two batches — one mid-flight,
 * one finished with a failure — so every state the panel can render is on
 * screen at once.
 */

const NOW = Date.now();
const min = (n: number) => n * 60_000;

export const LAPTOP = "1f2e3d4c5b6a7980";
export const DESK = "9a8b7c6d5e4f3a2b";
export const BOX = "c0ffee00c0ffee00";

export const devices = [
  { device_id: LAPTOP, label: "Ashot's MacBook Pro", platform: "darwin", hostname: "MacBook-Pro-168", last_seen: NOW - 20_000, is_remote: false, local_project_roots: ["/Users/ashot/src/codecast", "/Users/ashot/src/platform"], online: true },
  { device_id: DESK, label: "Studio desk", platform: "darwin", hostname: "studio", last_seen: NOW - min(190), is_remote: false, local_project_roots: ["/Users/ashot/src/codecast"], online: false },
  { device_id: BOX, label: "Linux - ip-172-31-40-243", platform: "linux", hostname: "ip-172-31-40-243", last_seen: NOW - min(42), is_remote: true, local_project_roots: ["/home/ubuntu/work/codecast"], online: false },
];

const c = (over: Record<string, unknown>) => ({
  short_id: "jx7xxxx", title: null, owner_device_id: LAPTOP, agent_type: "claude_code", project_path: "/Users/ashot/src/codecast",
  worktree_name: null, worktree_branch: null, updated_at: NOW - min(5), has_pending_messages: false, migration: null,
  cloud_placement: null, inbox_stashed_at: null, inbox_dismissed_at: null, ...over,
});

export const candidates = [
  c({ _id: "conv01", short_id: "jx7dhfh", title: "Bulk local↔cloud session migration UI", worktree_name: "cloud-f2ba4c", worktree_branch: "codecast/cloud-f2ba4c", updated_at: NOW - 40_000 }),
  c({ _id: "conv02", short_id: "jx72r2p", title: "Agent switching rollout", worktree_name: "agent-switch", worktree_branch: "feat/agent-switch", updated_at: NOW - min(3), has_pending_messages: true }),
  c({ _id: "conv03", short_id: "jx79b85", title: "Cold nudge budget cap implementation", project_path: "/Users/ashot/src/platform", updated_at: NOW - min(12) }),
  c({ _id: "conv04", short_id: "jx7fb8w", title: "Fly deploy for the matching worker", project_path: "/Users/ashot/src/platform", worktree_name: "deploy-fix", worktree_branch: "fix/deploy", updated_at: NOW - min(25) }),
  c({ _id: "conv05", short_id: "jx7c6ra", title: "Daemon hardening: watcher pre-registration race", worktree_name: "cloud-3a91ff", worktree_branch: "codecast/cloud-3a91ff", owner_device_id: BOX, project_path: "/home/ubuntu/work/codecast/.codecast/worktrees/cloud-3a91ff", updated_at: NOW - min(50) }),
  c({ _id: "conv06", short_id: "jx7b7mx", title: "Codecast infrastructure cost transfer", owner_device_id: BOX, project_path: "/home/ubuntu/work/codecast/.codecast/worktrees/cloud-77d1e0", worktree_name: "cloud-77d1e0", worktree_branch: "codecast/cloud-77d1e0", updated_at: NOW - min(140) }),
  c({ _id: "conv07", short_id: "jx711jh", title: "Orca codebase analysis", agent_type: "codex", updated_at: NOW - min(60) }),
  c({ _id: "conv08", short_id: "jx78we4", title: "Daemon scaling architecture", owner_device_id: DESK, updated_at: NOW - min(200) }),
  c({ _id: "conv09", short_id: "jx7ds0f", title: "Eaiden codebase orientation", migration: { batch_id: "mg-k2p9q1xz", migration_id: "mig_09" }, updated_at: NOW - min(2) }),
  c({ _id: "conv10", short_id: "jx7cknz", title: null, project_path: "/Users/ashot/src/union-mobile/outreach", updated_at: NOW - min(400) }),
];

/** Live agent status per conversation, as the inbox store would hold it. */
export const liveStatus: Record<string, string> = {
  conv01: "working",
  conv02: "permission_blocked",
  conv03: "idle",
  conv04: "thinking",
  conv05: "idle",
  conv06: "hibernated",
  conv07: "idle",
  conv09: "working",
};

const row = (over: Record<string, unknown>) => ({
  conversation_id: "x", title: null, short_id: null, direction: "to_cloud", from_device_id: LAPTOP, to_device_id: BOX, executor_device_id: LAPTOP,
  status: "queued", stage: null, error: null, attempt: 1, started_at: null, finished_at: null, updated_at: NOW, destination_path: null, verification: null, ...over,
});

export const batches = [
  {
    batch_id: "mg-k2p9q1xz", to_device_id: BOX, created_at: NOW - min(9), updated_at: NOW - 5_000, cancelled_at: null,
    wait_for_idle_ms: min(10), concurrency: 2, executor_device_ids: [LAPTOP],
    total: 6, done: 2, failed: 0, cancelled: 0, active: 2, queued: 2, state: "running",
    rows: [
      row({ migration_id: "mig_a", conversation_id: "conv11", short_id: "jx7a1b2", title: "Search index rebuild", status: "done", started_at: NOW - min(9), finished_at: NOW - min(6), stage: "running on Linux - ip-172-31-40-243", verification: "branch feat/search at 3f9a1c02, destination HEAD matches, clean working tree" }),
      row({ migration_id: "mig_b", conversation_id: "conv12", short_id: "jx7c3d4", title: "Inbox digest compare", status: "done", started_at: NOW - min(8), finished_at: NOW - min(5), stage: "running on Linux - ip-172-31-40-243 (its turn was interrupted to move it)", verification: "branch feat/digest at 77b0e9d1, destination HEAD matches, clean working tree" }),
      row({ migration_id: "mig_09", conversation_id: "conv09", short_id: "jx7ds0f", title: "Eaiden codebase orientation", status: "waiting_idle", started_at: NOW - min(4), stage: "waiting for the current turn to finish (working; up to 6m more)" }),
      row({ migration_id: "mig_c", conversation_id: "conv13", short_id: "jx7e5f6", title: "Provider key rotation", status: "transferring", started_at: NOW - min(2), stage: "pushing worktree + transcript" }),
      row({ migration_id: "mig_d", conversation_id: "conv14", short_id: "jx7g7h8", title: "Walkie ring focus", status: "queued" }),
      row({ migration_id: "mig_e", conversation_id: "conv15", short_id: "jx7i9j0", title: null, status: "queued" }),
    ],
  },
  {
    batch_id: "mg-7h3m2ab0", to_device_id: LAPTOP, created_at: NOW - min(180), updated_at: NOW - min(160), cancelled_at: null,
    wait_for_idle_ms: 0, concurrency: 1, executor_device_ids: [LAPTOP],
    total: 3, done: 2, failed: 1, cancelled: 0, active: 0, queued: 0, state: "partial",
    rows: [
      row({ migration_id: "mig_f", conversation_id: "conv16", short_id: "jx7k1l2", title: "Cloud waker rollout", direction: "to_local", from_device_id: BOX, to_device_id: LAPTOP, status: "done", started_at: NOW - min(180), finished_at: NOW - min(176), stage: "running on Ashot's MacBook Pro", verification: "branch codecast/cloud-9ab3 at 0c4d7e22, matching the host, with its uncommitted work restored here as uncommitted" }),
      row({ migration_id: "mig_g", conversation_id: "conv17", short_id: "jx7m3n4", title: "Trigger history panel", direction: "to_local", from_device_id: BOX, to_device_id: LAPTOP, status: "done", started_at: NOW - min(175), finished_at: NOW - min(171), stage: "running on Ashot's MacBook Pro" }),
      row({ migration_id: "mig_h", conversation_id: "conv18", short_id: "jx7o5p6", title: "Anchor decommission sweep", direction: "to_local", from_device_id: BOX, to_device_id: LAPTOP, status: "failed", attempt: 2, started_at: NOW - min(170), finished_at: NOW - min(160), error: "CONFLICT: local and remote diverged; not fast-forwardable. Resolve manually." }),
    ],
  },
];

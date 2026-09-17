/**
 * Cloud workspace mode: does a cloud session get its own worktree on the host
 * (isolated, the default) or the host's main checkout (shared)?
 *
 * One checkout holds one session. The occupancy rule below is the ONE place
 * that says who holds it: the Convex claim (cloud.claimSharedCheckout), the
 * placement re-check (cloud.placeConversation), the CLI's up-front park
 * (spawn.createSessionFromCli), both move paths (devices.ts) and the laptop's
 * own pre-flight (cloud/prepare.ts fetchRootOccupant) all call it, so the
 * server, the CLI and `cast hosts ls` cannot drift on what "in use" means.
 * Pure data in, verdict out; no runtime imports.
 */

export const CLOUD_WORKSPACE_MODES = ["isolated", "shared"] as const;
export type CloudWorkspaceMode = (typeof CLOUD_WORKSPACE_MODES)[number];

/** "shared" is shared; anything else (absent, garbage, an old client) is isolated. */
export function normalizeCloudWorkspace(v: unknown): CloudWorkspaceMode {
  return v === "shared" ? "shared" : "isolated";
}

/**
 * Where a cloud worktree starts: the laptop checkout that prepares the host
 * (its branch, HEAD and uncommitted changes, the default) or a clean
 * origin/main. A shared checkout never seeds from a laptop tree.
 */
export const CLOUD_START_FROM = ["checkout", "origin_main"] as const;
export type CloudStartFrom = (typeof CLOUD_START_FROM)[number];

/** "origin_main" is origin/main; anything else (absent, garbage, an old client) is the checkout. */
export function normalizeCloudStartFrom(v: unknown): CloudStartFrom {
  return v === "origin_main" ? "origin_main" : "checkout";
}

/**
 * What a placed cloud session started from (conversations.cloud_seed): the
 * source, the commit the worktree started at, the laptop branch when it
 * came from a checkout, whether that tree was dirty, the preparing device
 * and why an automatic downgrade to origin/main happened. Projected into
 * inbox rows, the header pill, the worktree chip and `cast hosts ls`.
 */
export interface CloudSeedRecord {
  source: CloudStartFrom;
  base: string;
  branch?: string | null;
  dirty?: boolean | null;
  laptop_root?: string | null;
  device_id?: string | null;
  reason?: string | null;
  at: number;
}

/** `feat/x@abc1234+`: branch (or origin/main), the short base, `+` when the laptop tree was dirty. */
export function cloudSeedLabel(seed: Pick<CloudSeedRecord, "source" | "base" | "branch" | "dirty">): string {
  const name = seed.source === "checkout" ? (seed.branch || "detached HEAD") : "origin/main";
  return `${name}@${seed.base.slice(0, 7)}${seed.dirty ? "+" : ""}`;
}

/** The one-line "Started from …" the header tooltip and the chip title carry. */
export function cloudSeedTitle(seed: Pick<CloudSeedRecord, "source" | "base" | "branch" | "dirty" | "laptop_root" | "reason">, deviceLabel?: string | null): string {
  const base7 = seed.base.slice(0, 7);
  if (seed.source === "checkout") {
    return `Started from ${seed.branch || "detached HEAD"} @ ${base7}${seed.dirty ? " + uncommitted changes" : ""}${seed.laptop_root ? ` (${seed.laptop_root})` : ""}${deviceLabel ? ` on ${deviceLabel}` : ""}`;
  }
  return `Started from origin/main @ ${base7}${seed.reason ? ` — ${seed.reason}` : ""}`;
}

export interface CheckoutOccupantRow {
  conversation_id: string;
  short_id?: string | null;
  title?: string | null;
  status?: string | null;
  inbox_killed_at?: number | null;
  cloud_workspace?: string | null;
  cloud_placement?: string | null;
  cloud_checkout_path?: string | null;
  project_path?: string | null;
  /** The message, or just whether one is set (cloud.hostSessions returns a boolean). */
  session_error?: string | boolean | null;
}

export interface CheckoutMatch {
  /** The host's main checkout path, matched exactly. */
  projectPath?: string;
  /** The repo's basename, for callers that only know the laptop path (a web create). */
  repoBasename?: string;
  /** The row being claimed or placed: it never occupies against itself. */
  excludeId?: string;
}

/** The last path segment (trailing slashes ignored): the repo name a checkout is keyed by. */
export function posixRepoBasename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * The first alive row holding the checkout, or null. A row is alive unless
 * killed or completed. It holds path P when
 *   (a) it is a SHARED row whose checkout (`cloud_checkout_path`, or its
 *       `project_path` while unclaimed) matches P — exactly, or by basename
 *       when the caller passes one — and, if still pending, it carries no
 *       session_error (a failed preparation frees the checkout without a new
 *       mutation: the daemon already writes that field), or
 *   (b) legacy: any other alive row whose `project_path` is exactly P — a
 *       session moved onto the root, or a row placed there before the stamp
 *       existed. A shared row is judged by (a) alone, so a failed pending
 *       one cannot re-occupy the root through its path.
 */
export function sharedCheckoutOccupant(
  rows: CheckoutOccupantRow[],
  match: CheckoutMatch,
): CheckoutOccupantRow | null {
  for (const row of rows) {
    if (match.excludeId && row.conversation_id === match.excludeId) continue;
    if (row.inbox_killed_at || row.status === "completed") continue;
    if (row.cloud_workspace === "shared") {
      const held = row.cloud_checkout_path ?? row.project_path ?? null;
      const counts = row.cloud_placement !== "pending" || !row.session_error;
      if (held && counts) {
        if (match.projectPath && held === match.projectPath) return row;
        if (match.repoBasename && posixRepoBasename(held) === match.repoBasename) return row;
      }
      continue;
    }
    if (match.projectPath && row.project_path === match.projectPath) return row;
  }
  return null;
}

/** The refusal every surface prints for a checkout somebody else holds. */
export function checkoutInUseMessage(path: string, occupant: CheckoutOccupantRow): string {
  const id = occupant.short_id ?? occupant.conversation_id.slice(0, 7);
  const title = (occupant.title ?? "").trim() || "untitled";
  return `the host checkout ${path} is in use by session ${id} (${title}) — run this session isolated, or finish/kill that one`;
}

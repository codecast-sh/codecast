// Team machines (docs/architecture/team-machines.md): the rows teamHosts.list
// returns, and what a surface derives from them. One home: the teamMachines
// store key; nothing here keeps a second copy.
import { TEAM_HOST_JOIN_STEPS, TEAM_HOST_JOIN_STEP_LABELS, type TeamHostJoinStep, type TeamHostMemberStatus } from "@codecast/shared/contracts/teamHosts";

export type TeamMachineMember = {
  _id: string;
  user_id: string;
  name: string;
  image?: string;
  linux_user: string;
  status: TeamHostMemberStatus;
  step?: string;
  error?: string;
  stalled?: boolean;
  device_id?: string;
  online: boolean;
  claude_signed_in: boolean;
  claude_email?: string;
  login_flow?: { status: "pending" | "confirmed" | "rejected"; url?: string; started_at: number; reason?: string };
  usage: { sessions: number; cpu: number; mem_gb: number } | null;
  is_admin: boolean;
};

export type TeamMachine = {
  _id: string;
  team_id: string;
  team_name: string;
  name: string;
  address?: string;
  platform: string;
  admin_name: string;
  admin_linux_user: string;
  admin_online: boolean;
  can_manage: boolean;
  load: { cpus: number; cpu_pct?: number; mem_free_gb: number; mem_total_gb: number; busy: boolean } | null;
  members: TeamMachineMember[];
  created_at: number;
};

/** The row a join paints before the server answers; the next push replaces it. */
export function pendingJoinRow(userId: string, name: string): TeamMachineMember {
  return {
    _id: `pending-join:${userId}`, user_id: userId, name, linux_user: "…", status: "joining", step: "queued",
    online: false, claude_signed_in: false, usage: null, is_admin: false,
  };
}

/** The viewer's own place on a machine: their member row (their non-admin row first). */
export function myMembership(m: TeamMachine, userId: string | undefined): TeamMachineMember | undefined {
  if (!userId) return undefined;
  return m.members.find((r) => r.user_id === userId && !r.is_admin) ?? m.members.find((r) => r.user_id === userId);
}

/** The team machine one of the viewer's devices belongs to, if any. */
export function teamMachineOfDevice(all: TeamMachine[], deviceId: string, userId: string | undefined): TeamMachine | undefined {
  return all.find((m) => m.members.some((r) => r.device_id === deviceId && r.user_id === userId));
}

export type MembershipPhase =
  | { kind: "none" }
  | { kind: "joining"; step: number; total: number; label: string; stalled: boolean }
  | { kind: "failed"; error: string }
  | { kind: "removing" }
  | { kind: "offline" }
  | { kind: "sign-in" }
  | { kind: "ready" };

/** Where the viewer stands on a machine, as one state a control can show. */
export function membershipPhase(r: TeamMachineMember | undefined): MembershipPhase {
  if (!r) return { kind: "none" };
  if (r.status === "joining") {
    const i = Math.max(0, (TEAM_HOST_JOIN_STEPS as readonly string[]).indexOf(r.step ?? "queued"));
    return { kind: "joining", step: i + 1, total: TEAM_HOST_JOIN_STEPS.length, label: TEAM_HOST_JOIN_STEP_LABELS[TEAM_HOST_JOIN_STEPS[i] as TeamHostJoinStep], stalled: !!r.stalled };
  }
  if (r.status === "failed") return { kind: "failed", error: r.error ?? "The join stopped" };
  if (r.status === "removing") return { kind: "removing" };
  if (!r.online) return { kind: "offline" };
  if (!r.claude_signed_in) return { kind: "sign-in" };
  return { kind: "ready" };
}

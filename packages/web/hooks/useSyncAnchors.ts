// Every standing agent the viewer can see, their personal workspace's and
// one per team, store-fed from anchors.listAnchors. One feeder (mounted once
// in the shell), many readers: the shell's chip and slide-over, the sidebar's
// entry, the inbox's marking, and chat's DM naming for personal bots. A row
// is the seat of the workspace's root role (org-staffing.md S22): `role` is
// that role's identity, and every surface draws the role, never the row.
import { CHIEF_OF_STAFF_HANDLE } from "../components/org/orgStaffingTypes";
import { useMemo } from "react";
import { registerKnownAgentMembers } from "../lib/chatViews";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useCollectionRows } from "./useCollectionRows";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

import { useWatchEffect } from "./useWatchEffect";
const api = _api as any;

export type AnchorRow = {
  _id: string;
  /** The workspace's root: the chief of staff's seat (S22). Set by listAnchors. */
  is_root?: boolean;
  scope_type: "team" | "user";
  team_id?: string | null;
  scope_user_id?: string | null;
  bot_user_id: string;
  host_user_id: string;
  conversation_id?: string | null;
  conversation_short_id?: string | null;
  name: string;
  bot_name: string;
  bot_avatar: string | null;
  team_name: string | null;
  persona?: string | null;
  project_path?: string | null;
  status: "provisioning" | "active" | "paused" | "decommissioned";
  /** The root role this row is the seat of; null until the workspace's agent
   *  is seated (the S22 migration seats every live one). */
  role?: { _id: string; short_id: string; name: string; handle: string; avatar: string | null; status: string } | null;
  is_host: boolean;
  in_my_team: boolean;
  conv_status?: string | null;
  agent_status?: string | null;
  awaiting_input?: boolean;
  has_pending_messages?: boolean;
  conv_updated_at?: number;
};

/** Mount once (the dashboard shell) — subscribes the collection, and keeps
 *  chat's fallback identity registry in step so a personal anchor's DM room
 *  is named after it (its bot is on no team roster). */
export function useSyncAnchors(): { ready: boolean } {
  const result = useSyncCollection("anchors", api.anchors.listAnchors, {});
  const botsSig = useInboxStore((s) => {
    let out = "";
    const anchors = (s as any).anchors ?? {};
    for (const id in anchors) {
      const a = anchors[id];
      out += `${a?.bot_user_id ?? ""}|${a?.bot_name ?? ""}|${a?.bot_avatar ?? ""}|${a?.status ?? ""}\n`;
    }
    return out;
  });
  useWatchEffect(() => {
    const anchors = (useInboxStore.getState() as any).anchors ?? {};
    const list: any[] = [];
    for (const id in anchors) {
      const a = anchors[id];
      if (!a?.bot_user_id || a.status === "decommissioned") continue;
      list.push({ _id: String(a.bot_user_id), name: agentName(a), image: a.bot_avatar ?? null, is_bot: true, anchor_id: String(a._id) } as any);
    }
    registerKnownAgentMembers(list);
  }, [botsSig]);
  return result;
}

/** The name a person reads for a standing agent: its role's, else what the
 *  row was called. Never the word anchor. */
export function agentName(a: Partial<AnchorRow> | null | undefined): string {
  return a?.role?.name || a?.bot_name || a?.name || "Workspace agent";
}

const SIG = (a: any) =>
  `${a._id}|${a.scope_type}|${a.team_id ?? ""}|${a.bot_name}|${a.bot_avatar ?? ""}|${a.team_name ?? ""}|${a.status}|${a.role ? `${a.role._id}:${a.role.short_id}:${a.role.name}:${a.role.handle}:${a.role.avatar ?? ""}:${a.role.status}` : ""}|${a.conversation_id ?? ""}|${a.conv_status ?? ""}|${a.agent_status ?? ""}|${a.awaiting_input ? 1 : 0}|${a.has_pending_messages ? 1 : 0}|${Math.floor((a.conv_updated_at ?? 0) / 60_000)}`;

/** Reader: all visible anchors, personal first, then teams by name. */
export function useAnchors(): AnchorRow[] {
  const rows = useCollectionRows("anchors" as any, { sig: SIG }) as unknown as AnchorRow[];
  return useMemo(
    () => [...rows]
      .filter((a) => a.status !== "decommissioned")
      .sort((a, b) =>
        (a.scope_type === "user" ? 0 : 1) - (b.scope_type === "user" ? 0 : 1)
        || (a.team_name ?? "").localeCompare(b.team_name ?? "")),
    [rows],
  );
}

/** One anchor by id (or null). */
export function useAnchor(anchorId: string | null | undefined): AnchorRow | null {
  const rows = useAnchors();
  return useMemo(() => rows.find((a) => a._id === anchorId) ?? null, [rows, anchorId]);
}

/** The active workspace's standing agent (org-staffing.md S22): the team's
 *  when a team is active, else the personal one. Null when the workspace has
 *  none yet, which is the onboarding's cue. */
export function rootAgentOf(anchors: AnchorRow[], activeTeamId: string | null | undefined): AnchorRow | null {
  const inWorkspace = anchors.filter((a) => activeTeamId
    ? a.scope_type === "team" && a.team_id === activeTeamId
    : a.scope_type === "user");
  // Every role's standing session is a row, so the root is the row the server
  // marks (the chief of staff's seat), else a seat that is no role's yet (a
  // workspace still waiting for its root); a lead is never the root.
  return inWorkspace.find((a) => a.is_root)
    ?? inWorkspace.find((a) => a.role?.handle === CHIEF_OF_STAFF_HANDLE)
    ?? inWorkspace.find((a) => !a.role)
    ?? null;
}

export function useRootAgent(): AnchorRow | null {
  const anchors = useAnchors();
  const activeTeamId = useInboxStore((s) => (s.clientState.ui?.active_team_id as string | undefined) ?? null);
  return useMemo(() => rootAgentOf(anchors, activeTeamId), [anchors, activeTeamId]);
}

export type AnchorLiveStatus = { label: string; dot: string; text: string; tone: "off" | "working" | "attention" | "online" | "dormant" };

/** Coarse liveness from the anchor row's session fields. Same rule on every
 *  surface: the drawer's status line, the chip's dot, the /anchor header. */
export function deriveAnchorStatus(a: Partial<AnchorRow> | null | undefined, now = Date.now()): AnchorLiveStatus {
  if (!a || a.status === "decommissioned" || a.conv_status === "completed") {
    return { label: "retired", dot: "bg-sol-text-dim", text: "text-sol-text-dim", tone: "off" };
  }
  if (a.status === "paused") {
    return { label: "paused", dot: "bg-sol-text-dim", text: "text-sol-text-dim", tone: "off" };
  }
  if (a.awaiting_input || a.agent_status === "permission_blocked") {
    return { label: "needs you", dot: "bg-sol-yellow", text: "text-sol-yellow", tone: "attention" };
  }
  if (a.has_pending_messages || a.agent_status === "running" || a.agent_status === "working") {
    return { label: "working", dot: "bg-sol-cyan animate-pulse", text: "text-sol-cyan", tone: "working" };
  }
  const fresh = a.conv_updated_at && now - a.conv_updated_at < 3 * 60 * 1000;
  if (fresh) return { label: "online", dot: "bg-sol-green", text: "text-sol-green", tone: "online" };
  return { label: "dormant · wakes on an event", dot: "bg-sol-text-dim/60", text: "text-sol-text-dim", tone: "dormant" };
}

/** Which anchor the slide-over shows when none was chosen: the active team's,
 *  else the personal one, else the first — with none at all, "new:user" (the
 *  panel's personal-onboarding key). */
export function defaultAnchorKey(anchors: AnchorRow[], activeTeamId: string | null | undefined): string {
  if (activeTeamId) {
    const team = anchors.find((a) => a.scope_type === "team" && a.team_id === activeTeamId);
    if (team) return team._id;
  }
  const personal = anchors.find((a) => a.scope_type === "user");
  if (personal) return personal._id;
  if (anchors[0]) return anchors[0]._id;
  return "new:user";
}

/** The label a person reads to know WHICH workspace's agent: "Personal" or the team's name. */
export function anchorScopeLabel(a: Pick<AnchorRow, "scope_type" | "team_name"> | null | undefined): string {
  if (!a) return "";
  return a.scope_type === "team" ? (a.team_name ?? "Team") : "Personal";
}

/** The identity fields of ONE standing agent, for hot paths (an inbox card): the
 *  subscription is a short string, so a heartbeat elsewhere never re-renders
 *  the row. Returns null when the id is empty or the row is not loaded. */
export function useAnchorIdentity(anchorId: string | null | undefined): AnchorIdentity | null {
  const sig = useInboxStore((s) => anchorIdentitySig((s as any).anchors, anchorId));
  return useMemo(() => anchorIdentityFromSig(sig), [sig]);
}

export type AnchorIdentity = Pick<AnchorRow, "_id" | "bot_name" | "bot_avatar" | "scope_type" | "team_name">;

/** The two halves of useAnchorIdentity as pure functions, so a caller that
 *  already holds one store subscription (an inbox card) reads the row
 *  through it instead of opening a second one (ct-49746). */
export function anchorIdentitySig(anchors: Record<string, any> | undefined, anchorId: string | null | undefined): string | null {
  if (!anchorId) return null;
  const a = anchors?.[anchorId];
  if (!a) return null;
  return JSON.stringify([a._id, a.bot_name ?? "", a.bot_avatar ?? "", a.scope_type, a.team_name ?? ""]);
}

export function anchorIdentityFromSig(sig: string | null): AnchorIdentity | null {
  if (!sig) return null;
  const [_id, bot_name, bot_avatar, scope_type, team_name] = JSON.parse(sig) as string[];
  return { _id, bot_name, bot_avatar: bot_avatar || null, scope_type: scope_type as "team" | "user", team_name: team_name || null };
}

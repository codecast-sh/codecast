// Every anchor the viewer can see — their personal one and one per team —
// store-fed from anchors.listAnchors. One feeder (mounted once in the shell),
// many readers: the global chip and drawer, the inbox's anchor marking, the
// /anchor page's scope switcher, and chat's DM naming for personal bots.
import { useEffect, useMemo } from "react";
import { registerKnownAgentMembers } from "../lib/chatViews";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useCollectionRows } from "./useCollectionRows";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

export type AnchorRow = {
  _id: string;
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
  useEffect(() => {
    const anchors = (useInboxStore.getState() as any).anchors ?? {};
    const list: any[] = [];
    for (const id in anchors) {
      const a = anchors[id];
      if (!a?.bot_user_id || a.status === "decommissioned") continue;
      list.push({ _id: String(a.bot_user_id), name: a.bot_name ?? a.name ?? "Anchor", image: a.bot_avatar ?? null, is_bot: true, anchor_id: String(a._id) } as any);
    }
    registerKnownAgentMembers(list);
  }, [botsSig]);
  return result;
}

const SIG = (a: any) =>
  `${a._id}|${a.scope_type}|${a.team_id ?? ""}|${a.bot_name}|${a.bot_avatar ?? ""}|${a.team_name ?? ""}|${a.status}|${a.conversation_id ?? ""}|${a.conv_status ?? ""}|${a.agent_status ?? ""}|${a.awaiting_input ? 1 : 0}|${a.has_pending_messages ? 1 : 0}|${Math.floor((a.conv_updated_at ?? 0) / 60_000)}`;

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

/** The label a person reads to know WHICH anchor: "Personal" or the team's name. */
export function anchorScopeLabel(a: Pick<AnchorRow, "scope_type" | "team_name"> | null | undefined): string {
  if (!a) return "";
  return a.scope_type === "team" ? (a.team_name ?? "Team") : "Personal";
}

/** The identity fields of ONE anchor, for hot paths (an inbox card): the
 *  subscription is a short string, so a heartbeat elsewhere never re-renders
 *  the row. Returns null when the id is empty or the row is not loaded. */
export function useAnchorIdentity(anchorId: string | null | undefined): Pick<AnchorRow, "_id" | "bot_name" | "bot_avatar" | "scope_type" | "team_name"> | null {
  const sig = useInboxStore((s) => {
    if (!anchorId) return null;
    const a = (s as any).anchors?.[anchorId];
    if (!a) return null;
    return JSON.stringify([a._id, a.bot_name ?? "", a.bot_avatar ?? "", a.scope_type, a.team_name ?? ""]);
  });
  return useMemo(() => {
    if (!sig) return null;
    const [_id, bot_name, bot_avatar, scope_type, team_name] = JSON.parse(sig) as string[];
    return { _id, bot_name, bot_avatar: bot_avatar || null, scope_type: scope_type as "team" | "user", team_name: team_name || null };
  }, [sig]);
}

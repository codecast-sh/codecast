"use client";
// Whether one project's line may start its next cause, and the two controls
// that decide it (line-map.md LX3, LX5; the-line-end-to-end.md LE6). The sweep
// admits for a ROLE: the role whose area holds the project, its switch
// (starts work on its own) and the answering person's card slots (caps.cards).
// The switch and the cap paint from the org tree in the store, so an edit
// shows at once (updateOrgRole is an intent with its own optimism); how many
// slots are busy and how many hands it started today come from the sweep's
// own count (orgLine.queue), an enrichment that may be late or missing.
import { useCallback, useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { DEFAULT_LINE_CARDS_CAP, DEFAULT_ROLE_CAPS } from "@codecast/shared/contracts/orgCapacity";
import { autonomyOn, trustForSwitch } from "@codecast/shared/contracts/roleAutonomy";
import { useInboxStore } from "../../../store/inboxStore";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useSyncOrgTreeFeeder } from "../../../hooks/useSyncOrgTree";
import { rolesOnProject } from "../../../lib/line/lineStations";
import { NO_PROJECT, NO_PROJECT_ADMISSION, type LineAdmission } from "../../../lib/lineFlow";
import type { OrgRole } from "../../org/orgTypes";

/** The role that starts a project's line: of the roles whose area holds it,
 *  an active one with its switch on first, then any active one, then any. */
export function lineRoleOf(roles: OrgRole[], projectId: string): OrgRole | null {
  const on = rolesOnProject(roles, projectId).map((r) => r.role);
  return on.find((r) => r.status === "active" && autonomyOn(r.trust)) ?? on.find((r) => r.status === "active") ?? on[0] ?? null;
}

const roleSig = (r: OrgRole) => {
  const c = r.caps;
  return `${r._id}|${r.handle}|${r.status}|${r.trust ?? ""}|${c?.cards ?? ""}|${c?.hands_per_day ?? ""}|${r.scope.project_ids.join(",")}`;
};

/** `projectId`: a project's id, NO_PROJECT for work filed under none (which
 *  nothing admits), or null when the line shown is no one line. */
export function useLineAdmission(projectId: string | null): {
  /** undefined: unknown here (no project, or the org on hand is another workspace's). */
  admission: LineAdmission | undefined;
  role: OrgRole | null;
  setOn: (on: boolean) => void;
  setSlots: (n: number) => void;
} {
  useSyncOrgTreeFeeder();
  const workspace = useInboxStore((s) => (projectId ? ((s.projects as Record<string, { workspace?: string }>)[projectId]?.workspace ?? null) : null));
  // The fields admission reads, per role: a heartbeat in the tree wakes nothing here.
  const sig = useInboxStore((s) => {
    const t = s.orgTree;
    return t ? `${t.workspace.kind}:${t.workspace.id}\n${t.roles.map(roleSig).join("\n")}` : "";
  });
  const { role, known } = useMemo(() => {
    const tree = useInboxStore.getState().orgTree;
    // The org on hand is the active workspace's; another workspace's project
    // cannot be judged from it, so the map says nothing rather than "no role".
    if (!projectId || !tree || !workspace || `${tree.workspace.kind}:${tree.workspace.id}` !== workspace) return { role: null, known: false };
    return { role: lineRoleOf(tree.roles, projectId), known: true };
  }, [sig, projectId, workspace]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: queue, error: queueError } = useQueryNoThrow(api.orgLine.queue, role ? { role_id: role._id } : "skip");
  const admission = useMemo<LineAdmission | undefined>(() => {
    if (projectId === NO_PROJECT) return NO_PROJECT_ADMISSION;
    if (!known) return undefined;
    if (!role) return { role: null, on: false, slots: DEFAULT_LINE_CARDS_CAP, busy: null, hands: null, handsCap: null };
    // Until the sweep's count arrives, whether starting is off everywhere is
    // unknown: say nothing rather than name the wrong reason. A failed count
    // still paints the role's own switch.
    if (queue === undefined && !queueError) return undefined;
    const caps = role.caps;
    return {
      role: { id: role._id, handle: role.handle, paused: role.status !== "active" },
      on: autonomyOn(role.trust),
      sweepOff: queue?.sweep_on === false,
      // The role's own cap paints first, so an edit shows before the sweep's count echoes it.
      slots: caps?.cards ?? queue?.cards_cap ?? DEFAULT_LINE_CARDS_CAP,
      busy: queue?.open_cards ?? null,
      hands: queue?.hands ?? null,
      handsCap: queue?.hands_cap ?? caps?.hands_per_day ?? DEFAULT_ROLE_CAPS.hands_per_day,
    };
  }, [projectId, known, role, queue, queueError]);

  const setOn = useCallback((on: boolean) => {
    if (role) useInboxStore.getState().updateOrgRole(role._id, { trust: trustForSwitch(on) });
  }, [role]);
  const setSlots = useCallback((n: number) => {
    if (!role) return;
    const caps = { ...DEFAULT_ROLE_CAPS, ...(role.caps ?? {}), cards: n };
    useInboxStore.getState().updateOrgRole(role._id, { caps });
  }, [role]);
  return { admission, role, setOn, setSlots };
}

/** Every project's admission at once, for the overview of all lines: the
 *  role whose area holds each, its switch and pause, and whether starting is
 *  off everywhere (one sweep count says it for all). Slots and hands are left
 *  unknown here: a project's own line reads them. */
export function useLineAdmissions(projects: ReadonlyArray<{ _id: string; workspace?: string | null }>): ReadonlyMap<string, LineAdmission> {
  useSyncOrgTreeFeeder();
  const sig = useInboxStore((s) => {
    const t = s.orgTree;
    return t ? `${t.workspace.kind}:${t.workspace.id}\n${t.roles.map(roleSig).join("\n")}` : "";
  });
  const roles = useMemo(() => {
    const tree = useInboxStore.getState().orgTree;
    if (!tree) return null;
    const ws = `${tree.workspace.kind}:${tree.workspace.id}`;
    const out = new Map<string, OrgRole | null>();
    for (const p of projects) if (p.workspace === ws) out.set(p._id, lineRoleOf(tree.roles, p._id));
    return out;
  }, [sig, projects]); // eslint-disable-line react-hooks/exhaustive-deps
  const any = roles ? [...roles.values()].find((r): r is OrgRole => !!r) : undefined;
  const queue = useQueryNoThrow(api.orgLine.queue, any ? { role_id: any._id } : "skip").data;
  return useMemo(() => {
    const out = new Map<string, LineAdmission>();
    // Until the sweep's count arrives, whether starting is off everywhere is
    // unknown: say nothing rather than name the wrong reason.
    if (any && !queue) return out;
    for (const [id, role] of roles ?? []) {
      out.set(id, role
        ? { role: { id: role._id, handle: role.handle, paused: role.status !== "active" }, on: autonomyOn(role.trust), sweepOff: queue?.sweep_on === false, slots: role.caps?.cards ?? DEFAULT_LINE_CARDS_CAP, busy: null, hands: null, handsCap: null }
        : { role: null, on: false, slots: DEFAULT_LINE_CARDS_CAP, busy: null, hands: null, handsCap: null });
    }
    return out;
  }, [roles, queue]);
}

"use client";
// Whether one project's line may start its next cause, and the two controls
// that decide it (line-map.md LX3, LX5; the-line-end-to-end.md LE6). The sweep
// admits for a ROLE: the role whose area holds the project, the line's start
// switch on it (learning-loop.md LL5: caps.line_on, under the role's own
// switch) and the answering person's card slots (caps.cards).
// The switch and the cap paint from the org tree in the store, so an edit
// shows at once (updateOrgRole is an intent with its own optimism); how many
// slots are busy and how many hands it started today come from the sweep's
// own count (orgLine.queue), an enrichment that may be late or missing.
import { useCallback, useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { DEFAULT_LINE_CARDS_CAP } from "@codecast/shared/contracts/orgCapacity";
import { autonomyOn, lineStartsOn, trustForSwitch } from "@codecast/shared/contracts/roleAutonomy";
import { useInboxStore } from "../../../store/inboxStore";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useSyncOrgTreeFeeder } from "../../../hooks/useSyncOrgTree";
import { rolesOnProject } from "../../../lib/line/lineStations";
import { NO_PROJECT, NO_PROJECT_ADMISSION, type LineAdmission } from "../../../lib/lineFlow";
import type { OrgRole } from "../../org/orgTypes";

/** The role that starts a project's line: of the roles whose area holds it,
 *  an active one whose line is on first, then one whose own switch is on,
 *  then any active one, then any. */
export function lineRoleOf(roles: OrgRole[], projectId: string): OrgRole | null {
  const on = rolesOnProject(roles, projectId).map((r) => r.role);
  const active = on.filter((r) => r.status === "active");
  return active.find(lineStartsOn) ?? active.find((r) => autonomyOn(r.trust)) ?? active[0] ?? on[0] ?? null;
}

/** The role's caps with `patch` over them, keys in the order the server
 *  returns a stored object (sorted), so the echo settles the edit's intent. */
export function capsWith(caps: OrgRole["caps"], patch: Partial<NonNullable<OrgRole["caps"]>>): NonNullable<OrgRole["caps"]> {
  const next: Record<string, unknown> = { ...(caps ?? {}), ...patch };
  return Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]])) as NonNullable<OrgRole["caps"]>;
}

/** What turning the line on or off writes to the role: the start switch in
 *  its caps, and its own switch with it when turning on finds that off, since
 *  a role that starts no work on its own starts no line (lineStartsOn).
 *  Turning off leaves the role's own switch as it was. */
export function lineSwitchFields(role: Pick<OrgRole, "trust" | "caps">, on: boolean): { caps: NonNullable<OrgRole["caps"]>; trust?: OrgRole["trust"] } {
  return { caps: capsWith(role.caps, { line_on: on }), ...(on && !autonomyOn(role.trust) ? { trust: trustForSwitch(true) } : {}) };
}

const roleSig = (r: OrgRole) => {
  const c = r.caps;
  return `${r._id}|${r.handle}|${r.status}|${r.trust ?? ""}|${c?.line_on ? 1 : 0}|${c?.cards ?? ""}|${c?.hands_per_day ?? ""}|${(r.scope?.project_ids ?? []).join(",")}`;
};

/** The org tree's workspace and the fields admission reads, per role: a heartbeat in the tree wakes nothing. */
const orgTreeSig = (s: ReturnType<typeof useInboxStore.getState>) => {
  const t = s.orgTree;
  return t ? `${orgWorkspaceOf(t)}\n${t.roles.map(roleSig).join("\n")}` : "";
};
const orgWorkspaceOf = (t: { workspace: { kind: string; id: string } }) => `${t.workspace.kind}:${t.workspace.id}`;

type LineQueue = { items: unknown[]; cards_cap?: number | null; open_cards?: number | null; hands?: number | null; hands_cap?: number | null };

/** A project's admission from the role that starts its line: the switch and the slots paint from the role, the
 *  sweep's counts (orgLine.queue) fill in when they arrive and stay unknown without them. */
export function admissionOf(role: OrgRole | null, queue?: LineQueue | null): LineAdmission {
  if (!role) return { role: null, on: false, slots: DEFAULT_LINE_CARDS_CAP, busy: null, hands: null, handsCap: null };
  const caps = role.caps;
  return {
    role: { id: role._id, handle: role.handle, paused: role.status !== "active" },
    on: lineStartsOn(role),
    queued: queue?.items.length ?? null,
    // The role's own cap paints first, so an edit shows before the sweep's count echoes it.
    slots: caps?.cards ?? queue?.cards_cap ?? DEFAULT_LINE_CARDS_CAP,
    busy: queue?.open_cards ?? null,
    hands: queue?.hands ?? null,
    handsCap: queue?.hands_cap ?? caps?.hands_per_day ?? null,
  };
}

/** Turns a role's line on or off (lineSwitchFields), read from the org tree at the moment of the click. */
export function setLineOn(roleId: string, on: boolean) {
  const st = useInboxStore.getState();
  const role = st.orgTree?.roles.find((r) => r._id === roleId);
  if (role) st.updateOrgRole(role._id, lineSwitchFields(role, on));
}

/** `projectId`: a project's id, NO_PROJECT for work filed under none (which
 *  nothing admits), or null when the line shown is no one line. */
export function useLineAdmission(projectId: string | null): {
  /** undefined: unknown here (no project, or the org on hand is another workspace's). */
  admission: LineAdmission | undefined;
  role: OrgRole | null;
  /** `perDay`: a daily cap on the sessions it starts, written with the switch (the Turn on review's pick). */
  setOn: (on: boolean, perDay?: number | null) => void;
  setSlots: (n: number) => void;
} {
  useSyncOrgTreeFeeder();
  const workspace = useInboxStore((s) => (projectId ? ((s.projects as Record<string, { workspace?: string }>)[projectId]?.workspace ?? null) : null));
  const sig = useInboxStore(orgTreeSig);
  const { role, known } = useMemo(() => {
    const tree = useInboxStore.getState().orgTree;
    // The org on hand is the active workspace's; another workspace's project
    // cannot be judged from it, so the map says nothing rather than "no role".
    if (!projectId || !tree || !workspace || orgWorkspaceOf(tree) !== workspace) return { role: null, known: false };
    return { role: lineRoleOf(tree.roles, projectId), known: true };
  }, [sig, projectId, workspace]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: queue } = useQueryNoThrow(api.orgLine.queue, role ? { role_id: role._id } : "skip");
  const admission = useMemo<LineAdmission | undefined>(() => {
    if (projectId === NO_PROJECT) return NO_PROJECT_ADMISSION;
    if (!known) return undefined;
    return admissionOf(role, queue);
  }, [projectId, known, role, queue]);

  const setOn = useCallback((on: boolean, perDay?: number | null) => {
    if (!role) return;
    const fields = lineSwitchFields(role, on);
    useInboxStore.getState().updateOrgRole(role._id, perDay != null ? { ...fields, caps: capsWith(fields.caps, { hands_per_day: perDay }) } : fields);
  }, [role]);
  const setSlots = useCallback((n: number) => {
    if (role) useInboxStore.getState().updateOrgRole(role._id, { caps: capsWith(role.caps, { cards: n }) });
  }, [role]);
  return { admission, role, setOn, setSlots };
}

/** Every project's admission at once, for the overview of all lines: the
 *  role whose area holds each, its line's start switch and pause. The sweep's
 *  counts stay unknown here: a project's own line reads them. */
export function useLineAdmissions(projects: ReadonlyArray<{ _id: string; workspace?: string | null }>): ReadonlyMap<string, LineAdmission> {
  useSyncOrgTreeFeeder();
  const sig = useInboxStore(orgTreeSig);
  return useMemo(() => {
    const tree = useInboxStore.getState().orgTree;
    const out = new Map<string, LineAdmission>();
    if (!tree) return out;
    const ws = orgWorkspaceOf(tree);
    for (const p of projects) if (p.workspace === ws) out.set(p._id, admissionOf(lineRoleOf(tree.roles, p._id)));
    return out;
  }, [sig, projects]); // eslint-disable-line react-hooks/exhaustive-deps
}

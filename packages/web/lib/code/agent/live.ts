// The agent integration's reads of the live app: session rows, their work
// state, the stage, the vault's folder. Each read happens on a transition (a
// store change that moved a watched field, a disk change landing, a command),
// never on a keystroke. No CodeMirror, so the Files page can use it.

import { useInboxStore, sessionWorkState, type InboxSession } from "../../../store/inboxStore";
import { useVaultStore } from "../../../store/vaultStore";
import { makeCollectionSig } from "../../../store/wakeSig";
import { localDeviceIdOf } from "../../../hooks/useLocalDeviceId";
import { hostOfVault } from "../../vault/hosts/routes";
import { workspaceFor } from "../../../store/codeStore";
import { ATTRIBUTION_WINDOW, PRESENCE_WINDOW, buildEditIndex, editIndexDigest, writerFor, type EditIndex, type MessageLike } from "./attribution";
import { besideSessionId, candidateSessions, pathWithin, resolveLink, sessionOnMachine, sessionRoots, steerable, workRoots, type AgentLink, type AgentSessionRow, type LinkOverride } from "./sessions";

type InboxState = ReturnType<typeof useInboxStore.getState>;

/** The vault's folder on its machine. */
export function vaultRootOf(vaultId: string): string | null {
  const v = useVaultStore.getState();
  return v.vaults.find((x) => x.id === vaultId)?.root ?? v.remoteVaults.find((x) => x.id === vaultId)?.root ?? null;
}

/** The machine a vault's files live on: a host vault's device, a mirror's
 *  source machine, else this window's daemon (null until the probe finds it). */
export function vaultMachineOf(vaultId: string, s: InboxState = useInboxStore.getState()): string | null {
  const host = hostOfVault(vaultId);
  if (host) return host;
  const v = useVaultStore.getState();
  if (!v.vaults.some((x) => x.id === vaultId)) {
    const mirror = v.remoteVaults.find((x) => x.id === vaultId);
    if (mirror) return mirror.device_id;
  }
  return localDeviceIdOf(s);
}

/** Where a vault's files are: the folder, and the machine holding it. Every
 *  link and attribution matches both, so a session working the same path on
 *  another machine never stands for this one. */
export interface VaultPlace {
  root: string;
  machine: string | null;
}

export function vaultPlaceOf(vaultId: string, s: InboxState = useInboxStore.getState()): VaultPlace | null {
  const root = vaultRootOf(vaultId);
  return root ? { root, machine: vaultMachineOf(vaultId, s) } : null;
}

/** Open the composer for a new session in the vault's folder, stamped to run
 *  on the vault's machine (a host vault's host, a mirror's source Mac), not
 *  whichever machine the composer would default to. False with no folder. */
export function composeInVault(vaultId: string, text: string): boolean {
  const root = vaultRootOf(vaultId);
  if (!root) return false;
  const s = useInboxStore.getState();
  const deviceId = vaultMachineOf(vaultId, s);
  s.openCompose(text, { projectPath: root, ...(deviceId ? { deviceId } : {}) });
  return true;
}

export const isWorkingRow = (row: AgentSessionRow, now = Date.now()) => sessionWorkState(row as InboxSession, now) === "working";

/** Which folder each session works in and whether the viewer may steer it,
 *  for every row: the only all-rows read, so a tool call or a state change in
 *  some other repo never wakes the editor. */
const agentFolderSig = makeCollectionSig<InboxSession>((s) =>
  s ? [s.project_path ?? "", s.git_root ?? "", s.owner_device_id ?? "", s.user_id ?? "", s.owned_by_me === false ? 0 : 1, s.is_subagent ? 1 : 0, s.inbox_killed_at ?? ""].join("|") : null,
);

/** What the chip, the picker and presence draw and branch on for one session
 *  in the folder. Heartbeats and updated_at stay out: ranking by recency is
 *  refreshed on a coarse clock. */
const agentRowSig = (s: InboxSession) =>
  [
    s._id,
    s.title ?? "",
    s.short_title ?? "",
    s.agent_type,
    s.icon_color ?? "",
    s.agent_status ?? "",
    s.is_idle ? 1 : 0,
    s.awaiting_input ? 1 : 0,
    s.is_unresponsive ? 1 : 0,
    s.is_connected ? 1 : 0,
    s.status ?? "",
    s.activity?.text ?? "",
    s.activity?.at ?? 0,
  ].join("|");

const viewerId = (s: InboxState) => {
  const id = (s.currentUser as { _id?: unknown } | null | undefined)?._id;
  return id ? String(id) : null;
};

const rowsOf = (s: InboxState) => Object.values(s.sessions) as AgentSessionRow[];

/** Sessions on the vault's machine whose folder overlaps the vault's: one
 *  holds the other. Cached per place on the folder signature, so only a
 *  session moving in or out of a folder or machine (or becoming unsteerable)
 *  rescans every row. */
/** The session's folder and the vault's overlap: one holds the other. */
const overlapsRoot = (r: AgentSessionRow, root: string) => sessionRoots(r).some((p) => pathWithin(root, p) || pathWithin(p, root));

/** The conversation beside this vault's Files pane (besideSessionId). Off the
 *  active tab it must work in this vault's folder. */
function besideOf(s: InboxState, root: string): string | null {
  const covers = (id: string) => {
    const row = s.sessions[id] as AgentSessionRow | undefined;
    return !!row && workRoots(row).some((p) => pathWithin(root, p) || pathWithin(p, root));
  };
  return besideSessionId(s.tabs as never, s.activeTabId ?? null, s.currentSessionId ?? null, covers);
}

const overlapCache = new Map<string, { sig: string; ids: string[] }>();
function overlapping(s: InboxState, { root, machine }: VaultPlace): AgentSessionRow[] {
  const sig = agentFolderSig(s.sessions as Record<string, InboxSession>);
  const key = `${machine ?? ""}\u0000${root}`;
  let hit = overlapCache.get(key);
  if (!hit || hit.sig !== sig) {
    const ids = rowsOf(s)
      .filter((r) => r && sessionOnMachine(r, machine) && overlapsRoot(r, root))
      .map((r) => r._id);
    hit = { sig, ids };
    overlapCache.set(key, hit);
  }
  return hit.ids.map((id) => s.sessions[id] as AgentSessionRow | undefined).filter((r): r is AgentSessionRow => !!r);
}

const messagesOf = (s: InboxState) => (id: string) => s.messages[id] as readonly MessageLike[] | undefined;

/** A row the viewer may steer, by id. */
export function steerableRow(s: InboxState, id: string): AgentSessionRow | null {
  const row = s.sessions[id] as AgentSessionRow | undefined;
  return row && steerable(row, viewerId(s)) ? row : null;
}

export interface VaultAgentState {
  link: AgentLink;
  candidates: AgentSessionRow[];
  index: EditIndex;
  digest: string;
}

/** The picker's sessions for a place. Every candidate works in a folder
 *  holding the root, so it overlaps it. */
export function placeCandidates(s: InboxState, place: VaultPlace, limit?: number): AgentSessionRow[] {
  return candidateSessions(overlapping(s, place), place.root, place.machine, viewerId(s), limit);
}

/** Everything AgentLayer keeps current for one vault. */
export function computeVaultAgentState(s: InboxState, place: VaultPlace, override: LinkOverride, current?: AgentLink, now = Date.now()): VaultAgentState {
  const rows = overlapping(s, place);
  const candidates = candidateSessions(rows, place.root, place.machine, viewerId(s));
  const besideId = besideOf(s, place.root);
  // A picked or beside session may work elsewhere in the tree, never on
  // another machine.
  const exists = (id: string) => {
    const row = steerableRow(s, id);
    return !!row && sessionOnMachine(row, place.machine);
  };
  const link = resolveLink({ override, besideId, candidates, exists, current });
  const index = buildEditIndex({ rows, isWorking: (r) => isWorkingRow(r, now), messagesOf: messagesOf(s), now, window: PRESENCE_WINDOW });
  return { link, candidates, index, digest: editIndexDigest(index) };
}

/** The signature of what computeVaultAgentState reads, so a store change that
 *  moved none of it does no work: where every session works, and the drawn
 *  fields of the sessions in this folder only. Messages count only for working
 *  sessions in the folder: their newest tool call is presence evidence. */
export function vaultAgentSig(s: InboxState, place: VaultPlace): string {
  const rows: string[] = [];
  const working: string[] = [];
  for (const r of overlapping(s, place)) {
    rows.push(agentRowSig(r as InboxSession));
    if (!isWorkingRow(r)) continue;
    const msgs = s.messages[r._id];
    working.push(`${r._id}:${msgs?.length ?? 0}:${msgs?.[msgs.length - 1]?.timestamp ?? 0}`);
  }
  const beside = besideOf(s, place.root);
  return `${place.machine ?? ""}#${agentFolderSig(s.sessions as Record<string, InboxSession>)}#${rows.join(",")}#${beside ?? ""}#${working.join(",")}`;
}

/** The session most likely behind a change to a vault file that just landed. */
export function writerNow(vaultId: string, path: string, now = Date.now()): string | null {
  const s = useInboxStore.getState();
  const place = vaultPlaceOf(vaultId, s);
  if (!place) return null;
  const abs = `${place.root.replace(/\/+$/, "")}/${path}`;
  const index = buildEditIndex({ rows: overlapping(s, place), isWorking: (r) => isWorkingRow(r, now), messagesOf: messagesOf(s), now, window: ATTRIBUTION_WINDOW });
  return writerFor(index, abs, (name) => openPathsNamed(vaultId, name) <= 1);
}

/** How many files open in the vault's editor tabs carry this basename. */
function openPathsNamed(vaultId: string, name: string): number {
  const paths = new Set<string>();
  for (const g of workspaceFor(vaultId).groups) for (const t of g.tabs) if (t.path === name || t.path.endsWith(`/${name}`)) paths.add(t.path);
  return paths.size;
}

export function sessionRow(id: string | null | undefined): AgentSessionRow | null {
  if (!id) return null;
  return (useInboxStore.getState().sessions[id] as AgentSessionRow | undefined) ?? null;
}

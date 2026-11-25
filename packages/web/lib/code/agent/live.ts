// The agent integration's reads of the live app: session rows, their work
// state, the stage, the vault's folder. Each read happens on a transition (a
// store change that moved a watched field, a disk change landing, a command),
// never on a keystroke. No CodeMirror, so the Files page can use it.

import { useInboxStore, sessionWorkState, type InboxSession } from "../../../store/inboxStore";
import { useVaultStore } from "../../../store/vaultStore";
import { makeCollectionSig } from "../../../store/wakeSig";
import { ATTRIBUTION_WINDOW, PRESENCE_WINDOW, buildEditIndex, editIndexDigest, writerFor, type EditIndex, type MessageLike } from "./attribution";
import { besideSessionId, candidateSessions, pathWithin, resolveLink, sessionRoots, steerable, type AgentLink, type AgentSessionRow, type LinkOverride } from "./sessions";

type InboxState = ReturnType<typeof useInboxStore.getState>;

/** The vault's folder on its machine. */
export function vaultRootOf(vaultId: string): string | null {
  const v = useVaultStore.getState();
  return v.vaults.find((x) => x.id === vaultId)?.root ?? v.remoteVaults.find((x) => x.id === vaultId)?.root ?? null;
}

export const isWorkingRow = (row: AgentSessionRow, now = Date.now()) => sessionWorkState(row as InboxSession, now) === "working";

/** Fields the link, the picker and presence branch on. Heartbeats and
 *  updated_at stay out: ranking by recency is refreshed on a coarse clock. */
export const agentSessionsSig = makeCollectionSig<InboxSession>((s) =>
  s
    ? [
        s.project_path ?? "",
        s.git_root ?? "",
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
        s.owned_by_me === false ? 0 : 1,
        s.inbox_killed_at ?? "",
      ].join("|")
    : null,
);

const viewerId = (s: InboxState) => {
  const id = (s.currentUser as { _id?: unknown } | null | undefined)?._id;
  return id ? String(id) : null;
};

const rowsOf = (s: InboxState) => Object.values(s.sessions) as AgentSessionRow[];

/** Sessions whose folder overlaps the vault's: one holds the other. Cached on
 *  the sessions signature, so a heartbeat does not rescan every row. */
let overlapCache: { sig: string; root: string; ids: string[] } | null = null;
function overlapping(s: InboxState, root: string): AgentSessionRow[] {
  const sig = agentSessionsSig(s.sessions as Record<string, InboxSession>);
  if (!overlapCache || overlapCache.sig !== sig || overlapCache.root !== root) {
    const ids = rowsOf(s)
      .filter((r) => r && sessionRoots(r).some((p) => pathWithin(root, p) || pathWithin(p, root)))
      .map((r) => r._id);
    overlapCache = { sig, root, ids };
  }
  return overlapCache.ids.map((id) => s.sessions[id] as AgentSessionRow | undefined).filter((r): r is AgentSessionRow => !!r);
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

/** Everything AgentLayer keeps current for one vault. */
export function computeVaultAgentState(s: InboxState, root: string, override: LinkOverride, now = Date.now()): VaultAgentState {
  const rows = rowsOf(s);
  const candidates = candidateSessions(rows, root, viewerId(s));
  const besideId = besideSessionId(s.tabs as never, s.activeTabId ?? null, s.currentSessionId ?? null);
  const link = resolveLink({ override, besideId, candidates, exists: (id) => !!steerableRow(s, id) });
  const index = buildEditIndex({ rows: overlapping(s, root), isWorking: (r) => isWorkingRow(r, now), messagesOf: messagesOf(s), now, window: PRESENCE_WINDOW });
  return { link, candidates, index, digest: editIndexDigest(index) };
}

/** The signature of what computeVaultAgentState reads, so a store change that
 *  moved none of it does no work. Messages count only for working sessions in
 *  the folder: their newest tool call is presence evidence. */
export function vaultAgentSig(s: InboxState, root: string): string {
  const working: string[] = [];
  for (const r of overlapping(s, root)) {
    if (!isWorkingRow(r)) continue;
    const msgs = s.messages[r._id];
    working.push(`${r._id}:${msgs?.length ?? 0}:${msgs?.[msgs.length - 1]?.timestamp ?? 0}`);
  }
  const beside = besideSessionId(s.tabs as never, s.activeTabId ?? null, s.currentSessionId ?? null);
  return `${agentSessionsSig(s.sessions as Record<string, InboxSession>)}#${beside ?? ""}#${working.join(",")}`;
}

/** The session most likely behind a change to a vault file that just landed. */
export function writerNow(vaultId: string, path: string, now = Date.now()): string | null {
  const root = vaultRootOf(vaultId);
  if (!root) return null;
  const s = useInboxStore.getState();
  const abs = `${root.replace(/\/+$/, "")}/${path}`;
  const index = buildEditIndex({ rows: overlapping(s, root), isWorking: (r) => isWorkingRow(r, now), messagesOf: messagesOf(s), now, window: ATTRIBUTION_WINDOW });
  return writerFor(index, abs);
}

export function sessionRow(id: string | null | undefined): AgentSessionRow | null {
  if (!id) return null;
  return (useInboxStore.getState().sessions[id] as AgentSessionRow | undefined) ?? null;
}

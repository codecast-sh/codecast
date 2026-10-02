// The app header pins roles or sessions (org-staffing.md S30), the way the
// sidebar pins rows (lib/sidebarPins): one list in `clientState.ui.header_pins`,
// a stamped per user pref, identity only. The header resolves each pin at
// render from the anchors collection (a role's seat row carries the role's
// identity and the live status the chip reads) and the sessions collection,
// so a pin whose row the viewer cannot see is not drawn and grants nothing.
//
// An ABSENT list is the default: the person's global Executive Assistant when one
// stands, else the active workspace's agent, which is what the header showed
// before pins. An empty list is a person who unpinned everything.

import { roleIdentity } from "@codecast/shared/contracts/orgIdentity";
import { useInboxStore } from "../store/inboxStore";
import { agentName, rootAgentOf, type AnchorRow } from "../hooks/useSyncAnchors";

export type HeaderPin = { kind: "role" | "session"; id: string };

const NO_PINS: HeaderPin[] = [];

export function readHeaderPins(state: any): HeaderPin[] | null {
  const raw = state.clientState?.ui?.header_pins;
  return Array.isArray(raw) ? (raw as HeaderPin[]) : null;
}

export function isHeaderPinned(state: any, kind: HeaderPin["kind"], id: string): boolean {
  return (readHeaderPins(state) ?? NO_PINS).some((p) => p.kind === kind && p.id === id);
}

/** A resolved pin: what the header draws and what a click opens. */
export type ResolvedPin = {
  key: string;
  pin: HeaderPin | null;
  /** The seat row for a role pin (face, status), null for a session pin. */
  anchor: AnchorRow | null;
  conversationId: string | null;
  name: string;
  subtitle: string;
  /** True when the header shows it because nothing is pinned. */
  isDefault: boolean;
};

/** The person's global Executive Assistant, when one stands among the rows they see. */
export function globalAssistantOf(anchors: AnchorRow[]): AnchorRow | null {
  return anchors.find((a) => a.scope_type === "user" && a.role?.assistant?.reach === "global" && a.role.status !== "retired") ?? null;
}

/** The one line a role row reads as: its given name, and its title with an
 *  assistant's reach ("Ada", "Executive Assistant, global"). A row not yet seated reads
 *  as the workspace's agent. */
export function anchorIdentityWords(a: AnchorRow | null | undefined): { name: string; subtitle: string } {
  if (a?.role) {
    const id = roleIdentity({ ...a.role, scope_type: a.scope_type }, { teamName: a.team_name });
    return { name: id.name, subtitle: id.subtitle };
  }
  return { name: agentName(a), subtitle: a?.scope_type === "team" ? `${a.team_name ?? "Team"}'s agent` : "Your agent" };
}

export function resolveHeaderPins(
  pins: HeaderPin[] | null,
  anchors: AnchorRow[],
  sessions: Record<string, any>,
  activeTeamId: string | null | undefined,
): ResolvedPin[] {
  if (pins === null) {
    const def = globalAssistantOf(anchors) ?? rootAgentOf(anchors, activeTeamId);
    if (!def) return [];
    const words = anchorIdentityWords(def);
    return [{ key: `anchor:${def._id}`, pin: null, anchor: def, conversationId: def.conversation_id ? String(def.conversation_id) : null, ...words, isDefault: true }];
  }
  const out: ResolvedPin[] = [];
  for (const pin of pins) {
    if (pin.kind === "role") {
      const a = anchors.find((row) => row.role && String(row.role._id) === pin.id && row.role.status !== "retired");
      if (!a) continue;
      const words = anchorIdentityWords(a);
      out.push({ key: `role:${pin.id}`, pin, anchor: a, conversationId: a.conversation_id ? String(a.conversation_id) : null, ...words, isDefault: false });
    } else {
      const s = sessions[pin.id];
      if (!s) continue;
      out.push({ key: `session:${pin.id}`, pin, anchor: null, conversationId: pin.id, name: s.title || "Session", subtitle: s.short_id ? `session ${s.short_id}` : "session", isDefault: false });
    }
  }
  return out;
}

/** Add or remove one pin. Pinning for the first time starts from what the
 *  header shows by default, so the default stays unless the person removes
 *  it; order is pin order, newest last. */
export function toggleHeaderPin(kind: HeaderPin["kind"], id: string): void {
  const store = useInboxStore.getState() as any;
  const current = readHeaderPins(store);
  const base: HeaderPin[] = current ?? defaultPinsOf(store);
  const exists = base.some((p) => p.kind === kind && p.id === id);
  const next = exists ? base.filter((p) => !(p.kind === kind && p.id === id)) : [...base, { kind, id }];
  store.updateClientUI({ header_pins: next });
}

/** The default as a pin list, so a first pin keeps what the header showed. */
export function defaultPinsOf(state: any): HeaderPin[] {
  const anchors: AnchorRow[] = Object.values(state.anchors ?? {}).filter((a: any) => a.status !== "decommissioned") as AnchorRow[];
  const activeTeamId = (state.clientState?.ui?.active_team_id as string | undefined) ?? null;
  const def = globalAssistantOf(anchors) ?? rootAgentOf(anchors, activeTeamId);
  return def?.role ? [{ kind: "role", id: String(def.role._id) }] : [];
}

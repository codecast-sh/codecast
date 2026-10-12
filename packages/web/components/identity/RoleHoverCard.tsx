// Who a role is and what it carries, one hover away from every place a role
// is named (session-characters.md S4; cohesive build spec §5.4, D14). The
// card paints at once from whatever the caller already has (face, name,
// handle), then from the store through RoleScopeView: the role's summary,
// the same head its sheet and its line say. `org.roleCard` is enrichment
// only: it stands in for the tree on a page that never loaded it. A missing
// answer leaves a face and a name, never an error (useQueryNoThrow).
//
// A click anywhere on the card opens the role: its sheet inside the Org
// screen, its address anywhere else.
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useLineTree } from "../org/lines/lineTree";
import { HoverCard } from "../ui/HoverCard";
import { ObjectCardBody } from "./objectCard";
import { RoleScopeView } from "./RoleScopeView";
import type { RoleCardAnswer } from "../../lib/roleScope";
import type { SessionRoleSnapshot } from "../../store/inboxStore";

export type RoleRef = Pick<SessionRoleSnapshot, "short_id" | "name" | "handle"> & Partial<SessionRoleSnapshot>;

/** `onOpen` replaces the card's own open on a click (a pill passes its
 *  opener, which also closes the popover the card sits in). */
export function RoleHoverContent({ role, onOpen }: { role: RoleRef; onOpen?: (e: React.MouseEvent) => void }) {
  const tree = useLineTree();
  const r = role.short_id.toLowerCase();
  const treeRole = tree?.roles.find((x) => x.short_id.toLowerCase() === r || x._id === role.short_id) ?? null;
  // Enrichment, asked only when the tree does not hold the role.
  const { data: card } = useQueryNoThrow(api.org.roleCard, treeRole ? "skip" : { role_id: role.short_id });
  return (
    <ObjectCardBody kind="role" refId={treeRole?.short_id ?? role.short_id} label="Open role" onOpen={onOpen} data-role-card={treeRole?.short_id ?? role.short_id}>
      <RoleScopeView role={role} treeRole={treeRole} card={card as (RoleCardAnswer & { avatar?: string; status?: string; trust?: string }) | null | undefined} />
    </ObjectCardBody>
  );
}

/** Wraps anything that names a role; the card opens on hover. */
export function RoleHoverCard({ role, children, side, align, disabled, triggerClassName }: { role: RoleRef; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; disabled?: boolean; triggerClassName?: string }) {
  return (
    <HoverCard card={<RoleHoverContent role={role} />} side={side} align={align} disabled={disabled} className="w-[22rem]" triggerClassName={triggerClassName}>
      {children}
    </HoverCard>
  );
}

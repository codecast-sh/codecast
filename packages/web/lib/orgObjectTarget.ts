// Which object an `/org/<ref>` address names. The address forms are the ones
// objectHref writes (`in-N`, `or-N`, `pj-…`, `@handle`) plus two older ones
// still in links people hold: a goal's stub key (`in_…`, before the server
// minted its `in-N`) and a bare Convex id, which names a goal, a project or a
// role by the table it belongs to. Pure, so the page and its test share it.
import { isConvexId, orgObjectOfRef, type EntityType, type OrgObjectKind } from "@codecast/shared/entities";
import { entityTypeInStore, findEntityInStore } from "./liveEntities";
import { isInitiativeKey } from "./initiatives";

export type OrgObjectTarget =
  | { kind: OrgObjectKind; ref: string }
  /** A Convex id the store does not hold, waiting on entities.resolveIdType. */
  | { kind: "pending" }
  /** The workspace root, or anything else a scope page reads. */
  | { kind: "scope"; ref: string };

/** True when the address needs the server to name its table: a Convex id
 *  the store holds no row for. */
export function orgRefNeedsTypeLookup(id: string, state: unknown): boolean {
  return !orgObjectOfRef(id) && isConvexId(id) && !storeKindOfConvexId(state, id);
}

/**
 * The object `id` names. `resolvedType` is the server's answer for a Convex id
 * the store does not hold: undefined while it is in flight, null when the id
 * is in no entity table (a role: org roles are not in that list).
 */
export function orgObjectTarget(id: string, state: unknown, resolvedType?: EntityType | null): OrgObjectTarget {
  const object = orgObjectOfRef(id);
  if (object) return object;
  if (isInitiativeKey(id)) return { kind: "initiative", ref: id };
  if (!isConvexId(id)) return { kind: "scope", ref: id };
  const kind = storeKindOfConvexId(state, id) ?? (resolvedType === undefined ? "pending" : kindOfType(resolvedType));
  if (kind === "pending") return { kind };
  if (kind === "project") return { kind, ref: projectShortId(state, id) ?? id };
  return { kind, ref: id };
}

function storeKindOfConvexId(state: unknown, id: string): "initiative" | "project" | "role" | undefined {
  if (findEntityInStore(state, "initiative", id)) return "initiative";
  if (findEntityInStore(state, "project", id)) return "project";
  if (findEntityInStore(state, "role", id)) return "role";
  const type = entityTypeInStore(state, id);
  return type === "initiative" || type === "project" ? type : undefined;
}

/** Only a goal and a project live in the id tables; any other id is a role's. */
const kindOfType = (type: EntityType | null): "initiative" | "project" | "role" =>
  type === "initiative" || type === "project" ? type : "role";

const projectShortId = (state: unknown, id: string): string | undefined =>
  (findEntityInStore(state, "project", id) as { short_id?: string } | undefined)?.short_id || undefined;

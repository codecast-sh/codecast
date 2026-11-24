import type { CoOwners } from "../../lib/coOwners";
import { AssigneeFace } from "../identity/AssigneeFace";
import { RoleFace } from "../org/RoleFace";
import { ParentSessionFace } from "../OwnersMenu";
import { withOwnerShown } from "../../lib/withOwner";

/** A card's co-owners (lib/coOwners) as faces beside its time, every owner
 *  named in the tooltip. No face is ringed. */
export function CoOwnerFaces({ owners }: { owners: CoOwners | null | undefined }) {
  if (!owners) return null;
  return (
    <span data-card-owners className="own-stack shrink-0" title={owners.title}>
      {owners.people.map((p) => <AssigneeFace key={p.key} info={{ name: p.name, image: p.image }} size={16} hover={false} />)}
      {owners.more > 0 && <span className="text-meta tabular-nums text-sol-text-dim">+{owners.more}</span>}
      {owners.role && <RoleFace role={owners.role} size={16} title={owners.title} />}
      {owners.parentId && <ParentSessionFace sessionId={owners.parentId} title={owners.title} size={16} />}
    </span>
  );
}

/** Under the owners model a wait its agent owner answers says who has it. */
export function WithOwnerMark({ withOwner, working, pendingSend }: { withOwner: string | null; working: boolean; pendingSend: boolean }) {
  if (!withOwnerShown(withOwner, working, pendingSend)) return null;
  return (
    <span data-sv-with-owner className="flex-shrink-0 truncate max-w-[160px] text-meta font-medium text-sol-green">
      With {withOwner}
    </span>
  );
}

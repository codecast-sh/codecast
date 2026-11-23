import type { CoOwners } from "../../lib/coOwners";
import { AssigneeFace } from "../identity/AssigneeFace";
import { RoleFace } from "../org/RoleFace";

/** A card's co-owners (lib/coOwners) as faces beside its time: the driver
 *  ringed, a paused role greyed (globals.css .own-drv, .own-paused), and every
 *  owner named in the tooltip. */
export function CoOwnerFaces({ owners }: { owners: CoOwners | null }) {
  if (!owners) return null;
  return (
    <span data-card-owners className="own-stack shrink-0" title={owners.title}>
      {owners.faces.map((f) => {
        const cls = `${f.driver ? "own-drv" : ""} ${f.kind === "role" && f.paused ? "own-paused" : ""}`.trim();
        return f.kind === "role"
          ? <RoleFace key={f.key} role={f.role} size={16} className={cls} title={owners.title} />
          : <AssigneeFace key={f.key} info={{ name: f.name, image: f.image }} size={16} hover={false} className={cls} />;
      })}
      {owners.more > 0 && <span className="text-meta tabular-nums text-sol-text-dim">+{owners.more}</span>}
    </span>
  );
}

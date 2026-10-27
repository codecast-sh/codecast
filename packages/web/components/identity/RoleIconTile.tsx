// A role's practical face (roleIcon.ts): its drawn icon on a tile tinted with
// the icon's accent, or, for a role with no icon yet, the first letter of its
// title on the same tile. The rounded square itself says "standing role";
// people and sessions are circles. Colors are theme tokens mixed in CSS
// (`.role-tile` in app/globals.css), so the tile follows light and dark.
import { ROLE_ICON_TILE, roleIconStroke, roleIconSvg } from "@codecast/shared/contracts/roleIcon";
import { avatarLength } from "../../lib/orgAvatars";
import type { RoleTile } from "../../lib/sessionIdentity";

export function RoleIconTile({ tile, size = 20, className, title, block }: {
  tile: RoleTile;
  /** A block box, for a parent that sizes it with line-height 0 (SessionFace):
   *  inline, middle alignment there lifts the tile off the text. */
  block?: boolean;
  /** Pixels, or any CSS length ("1em" rides the prose it sits in). */
  size?: number | string;
  className?: string;
  title?: string;
}) {
  const box = avatarLength(size);
  const label = title ?? tile.title;
  // roleTile only hands over an icon that passed isRoleIcon, and roleIconSvg
  // builds its markup from those validated shapes alone.
  const svg = tile.icon ? roleIconSvg(tile.icon, { strokeWidth: roleIconStroke(typeof size === "number" ? size : 20) }) : null;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`role-tile ${className ?? ""}`}
      data-role-tile={tile.icon ? tile.icon.concept : "monogram"}
      style={{
        ["--rt-accent" as string]: `var(--sol-${tile.accent})`,
        display: block ? "flex" : "inline-flex",
        verticalAlign: block ? undefined : "middle",
        width: box, height: box,
        borderRadius: `calc(${box} * ${ROLE_ICON_TILE.radius})`,
      }}
    >
      {svg ? (
        <span aria-hidden className="role-tile-glyph" style={{ width: `${ROLE_ICON_TILE.glyph * 100}%`, height: `${ROLE_ICON_TILE.glyph * 100}%` }} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        // The letter's size is set on the letter, not the tile: an em-sized
        // tile ("1em") would otherwise measure itself in the shrunk font.
        <span aria-hidden className="role-tile-letter" style={{ fontSize: `calc(${box} * 0.54)` }}>{tile.monogram}</span>
      )}
    </span>
  );
}

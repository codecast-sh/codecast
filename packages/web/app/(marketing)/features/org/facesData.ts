import type { RoleIcon } from "@codecast/shared/contracts/roleIcon";
import { ACCENT, SOL } from "./model";
import { ICONS, type IconKey } from "./icons";

// Values the faces section's components share (a .tsx may export only components).

export const iconOf = (k: IconKey): RoleIcon => ICONS[k] as RoleIcon;
export const accentHex = (k: IconKey): string => ACCENT[iconOf(k).accent];
/** The glyph's colour on the dark band: the accent lifted toward paper. */
export const glow = (c: string, pct = 72) => `color-mix(in srgb, ${c} ${pct}%, ${SOL.base3})`;

/** The wall's order: every icon, arranged so no tile shares an accent with its left or upper neighbour at 8 across and at 4 across (phones). */
export const WALL: IconKey[] = (() => {
  const left = Object.keys(ICONS) as IconKey[];
  const out: IconKey[] = [];
  while (left.length) {
    const n = out.length;
    const near = [n % 4 ? n - 1 : -1, n - 4, n - 8].filter((j) => j >= 0).map((j) => accentHex(out[j]));
    const i = left.findIndex((k) => !near.includes(accentHex(k)));
    out.push(left.splice(i < 0 ? 0 : i, 1)[0]);
  }
  return out;
})();

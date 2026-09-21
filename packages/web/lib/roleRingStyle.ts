import type { CSSProperties } from "react";

export function roleRingStyle(size: number | string): CSSProperties {
  // A 1 px ring under 20 px, a gapped 1.5 px ring above, both in the role violet.
  return (typeof size === "number" ? size : 14) < 20
    ? { boxShadow: "0 0 0 1px var(--sol-violet)" }
    : { boxShadow: "0 0 0 1px var(--sol-card), 0 0 0 2.5px var(--sol-violet)" };
}

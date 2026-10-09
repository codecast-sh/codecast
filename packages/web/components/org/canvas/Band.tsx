"use client";
// One band of the canvas (essence spec §4.1): a header row, then its cards in
// a grid as wide as the scroller. A 1px spine runs down from the header's face
// along the grid's left edge, with a tick into the first card: the whole
// connector system.
import type { ReactNode } from "react";

export function Band({ header, children, unled = false, id }: { header: ReactNode; children?: ReactNode; unled?: boolean; id?: string }) {
  return (
    <section className="oc-band" {...(unled ? { "data-unled": "" } : {})} {...(id ? { "data-canvas-band": id } : {})}>
      {header}
      {children ? <div className="oc-grid">{children}</div> : null}
    </section>
  );
}

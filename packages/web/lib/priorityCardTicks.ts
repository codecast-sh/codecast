// The priority change card's ticks (components/decisions/PriorityChangeCard):
// what pressing a row does to them, and what the first answer says about them.
import type { PriorityCard } from "@codecast/shared/contracts/priorityCard";

/**
 * The ticks after pressing one row. Unticking a new priority unticks the
 * milestones that hang off it (`parent`), and ticking such a milestone ticks
 * its priority back on, since a milestone of a new priority cannot land alone.
 * Returned in card order.
 */
export function toggleTicked(card: PriorityCard, ticked: readonly string[], id: string): string[] {
  const on = new Set(ticked);
  if (on.has(id)) {
    on.delete(id);
    for (const c of card.changes) if (c.parent === id) on.delete(c.id);
  } else {
    on.add(id);
    const parent = card.changes.find((c) => c.id === id)?.parent;
    if (parent) on.add(parent);
  }
  return card.changes.map((c) => c.id).filter((x) => on.has(x));
}

/** The first answer's words: all of them, or how many of how many. */
export function acceptLabel(on: number, total: number) {
  return on === total ? `Accept all ${total} changes` : `Accept ${on} of ${total} changes`;
}

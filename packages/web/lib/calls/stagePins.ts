// What a call's stage needs to know about pinned things (convex/callStage.ts),
// apart from the components that draw them: the share the stage views lay
// out for a pin row, its name, where it opens, and the context a pin's tile
// acts through.
import { createContext } from "react";
import { DOC_TYPE_LABELS, type DocType } from "@codecast/shared/docs";
import type { StagePinRow } from "../../hooks/useStagePins";
import type { StagePinShare } from "../../components/calls/stageHost";

/** What a pin's tile may do outside itself: open the thing whole (in the app,
 *  or the main window from a call's own window), and take it off the stage. */
export type StagePinActions = { roomKey: string; openPath: (path: string) => void };
export const StagePinContext = createContext<StagePinActions | null>(null);

/** A pin's name before anything resolves it: its stored title, else its kind. */
export function pinTitle(row: StagePinRow): string {
  if (row.title) return row.title;
  if (row.kind === "page") return "Published page";
  if (row.kind === "doc") return row.doc_type ? DOC_TYPE_LABELS[row.doc_type as DocType] ?? "Doc" : "Doc";
  return row.ref;
}

/** Where a pin opens whole, or null for one with no page of its own. */
export function pinPath(row: StagePinRow): string | null {
  if (row.kind === "doc" && row.doc_id) return `/docs/${row.doc_id}`;
  if (row.kind === "page" && row.slug) return `/a/${row.slug}`;
  return null;
}

/** The stage share for a pin row: what the views lay out. */
export function pinShare(row: StagePinRow): StagePinShare {
  return { kind: "pin", key: `pin:${row.ref}`, identity: `pin:${row.ref}`, name: pinTitle(row), pin: row, at: row.at };
}

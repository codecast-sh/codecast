// "Pick" mode for the command palette (Cmd+K).
//
// A feature that needs the user to choose a session, doc, task or plan — to
// send something to it, link it, move under it — must not grow its own list
// popover. It opens the palette with a PalettePick: the palette shows the
// title, the feature's own extra rows (e.g. "new agent session"), then the
// same recents + search groups the root palette already has, restricted to
// the allowed kinds. Choosing a target calls `onPick` and closes the palette
// — unless `notePlaceholder` is set, in which case the palette first shows a
// confirm step (chosen target, optional note, confirm button) and completes
// from there. Open it with `useInboxStore.getState().openPalette({ pick })`.

// "person" lists teammates and "role" the org roles that have a standing
// agent; a role row's id is that agent's session.
import { matchScore } from "./mentionRanking";

export type PalettePickKind = "session" | "doc" | "task" | "plan" | "channel" | "person" | "role";

export type PalettePickTarget =
  | { kind: PalettePickKind; id: string; label: string }
  // Offered only when kinds includes "channel": a teammate with no DM room
  // yet. The caller opens the DM (openDmChannel) with this member id.
  | { kind: "person"; id: string; label: string }
  // One of the caller's extra rows.
  | { kind: "extra"; key: string };

export type PalettePickExtra = {
  key: string;
  label: string;
  description?: string;
  icon?: "sparkles" | "doc" | "slack";
  // Highlight as the promoted default (first row, accent styling).
  primary?: boolean;
  // The row is only offered once the search box has text (e.g. "use what I
  // typed as a Slack channel id").
  needsQuery?: boolean;
};

export type PalettePickResult = {
  // Text from the optional note field, trimmed; undefined when empty.
  note?: string;
  // The search box text at the moment of the pick, trimmed.
  query: string;
  // Images from the confirm-step composer. Chat sends attach them; other
  // pickers ignore them.
  attachments?: Array<{
    storage_id: string;
    mime?: string;
    name?: string;
    width?: number;
    height?: number;
  }>;
};

export type PalettePick = {
  title: string;
  preview?: { title: string; text?: string; url: string };
  kinds: PalettePickKind[];
  // Ids of people and role sessions to leave out (already there).
  exclude?: string[];
  extras?: PalettePickExtra[];
  // Collect an optional note. With this set, picking becomes two steps:
  // choose a target from the list, then a confirm view shows the chosen
  // target, the same composer the chat box uses (mentions, image paste,
  // auto-grow), and a confirm button. Without it, picking completes immediately.
  notePlaceholder?: string;
  // Label for the confirm button in the two-step flow. Defaults to "Send".
  confirmLabel?: string;
  onPick: (target: PalettePickTarget, result: PalettePickResult) => void;
};

type WhoOption = { key: string; label: string; hint?: string };
export type PickWhoRow<O extends WhoOption> = { kind: "person" | "role"; id: string; o: O };

/** The person and role rows of a pick: teammates by user id, roles by their
 *  standing agent's session (a role with none has no row), less the viewer
 *  and the caller's exclusions, matched against the query. */
export function pickWhoRows<O extends WhoOption>(opts: {
  people: readonly O[] | null;
  roles: readonly O[] | null;
  standing: ReadonlyMap<string, string | undefined>;
  skip: ReadonlySet<string>;
  query: string;
}): PickWhoRow<O>[] {
  const q = opts.query.trim().toLowerCase();
  const rows: PickWhoRow<O>[] = [
    ...(opts.people ?? []).map((o) => ({ kind: "person" as const, id: String(o.key), o })),
    ...(opts.roles ?? []).map((o) => ({ kind: "role" as const, id: opts.standing.get(String(o.key)) ?? "", o })),
  ];
  return rows
    .filter((r) => r.id && !opts.skip.has(r.id) && matchScore(`${r.o.label} ${r.o.hint ?? ""}`, q) !== Infinity)
    .slice(0, 12);
}

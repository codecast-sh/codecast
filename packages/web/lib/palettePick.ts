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

export type PalettePickKind = "session" | "doc" | "task" | "plan" | "channel";

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
};

export type PalettePick = {
  title: string;
  kinds: PalettePickKind[];
  extras?: PalettePickExtra[];
  // Collect an optional free-text note. With this set, picking becomes two
  // steps: choose a target from the list, then a confirm view shows the
  // chosen target, the note field, and a confirm button. Without it, picking
  // completes immediately.
  notePlaceholder?: string;
  // Label for the confirm button in the two-step flow. Defaults to "Send".
  confirmLabel?: string;
  onPick: (target: PalettePickTarget, result: PalettePickResult) => void;
};

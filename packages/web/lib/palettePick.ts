// "Pick" mode for the command palette (Cmd+K).
//
// A feature that needs the user to choose a session, doc, task or plan — to
// send something to it, link it, move under it — must not grow its own list
// popover. It opens the palette with a PalettePick: the palette shows the
// title, the optional note field, the feature's own extra rows (e.g. "new
// agent session"), then the same recents + search groups the root palette
// already has, restricted to the allowed kinds. Choosing anything calls
// `onPick` and closes the palette. Open it with
// `useInboxStore.getState().openPalette({ pick })`.

export type PalettePickKind = "session" | "doc" | "task" | "plan";

export type PalettePickTarget =
  | { kind: PalettePickKind; id: string; label: string }
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
  // Show a free-text field above the list (an instruction, a note).
  notePlaceholder?: string;
  onPick: (target: PalettePickTarget, result: PalettePickResult) => void;
};

// Display preferences whose default is not a plain "off". Every reader, web and
// mobile, goes through these so a default lives in one place: the settings
// row, the inbox card, the feed and the phone cannot disagree about what an
// unset preference means. A leaf module (no store import) so lib/ files like
// sessionIdentity can use it without a cycle.

export type CardBarsMode = "strip" | "full" | "hidden";

type UIPrefs = {
  inbox_image_thumbs?: boolean;
  show_characters?: boolean;
  show_branch_pill?: boolean;
  comments_enabled?: boolean;
  card_bars?: CardBarsMode;
  show_triggers?: boolean;
} | null | undefined;

export function resolveImageThumbs(ui: UIPrefs): boolean {
  return ui?.inbox_image_thumbs ?? true;
}

export function resolveShowCharacters(ui: UIPrefs): boolean {
  return ui?.show_characters ?? false;
}

export function resolveShowBranchPill(ui: UIPrefs): boolean {
  return ui?.show_branch_pill ?? false;
}

export function resolveCommentsEnabled(ui: UIPrefs): boolean {
  return ui?.comments_enabled ?? true;
}

// show_triggers is the legacy toggle card_bars replaced; an old `true` still
// means the full bars.
export function resolveCardBars(ui: UIPrefs): CardBarsMode {
  return ui?.card_bars ?? (ui?.show_triggers ? "full" : "hidden");
}

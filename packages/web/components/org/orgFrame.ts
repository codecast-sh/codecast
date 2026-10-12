// The Org screen's frame in one place: the band every pane's head sits in,
// the rule under it, and the gutter its first line starts at. The header,
// the strip, the conversation head and the company head all read from here,
// so the rules on both sides of the seam meet at one height and the left
// edges line up under the workspace name.

/** One band height for every head on the screen. `box-content` keeps the
 *  44px for the content whether or not the head draws its own rule, so a
 *  head with a border (the company's, a seat's) and the strip's head (whose
 *  rule is its section's) both end their rule at 45px. */
export const ORG_BAND = "box-content h-11";

/** Every frame rule: the header's, the strip's, each pane head's, the seam. */
export const ORG_RULE = "var(--cc-panel-rule)";

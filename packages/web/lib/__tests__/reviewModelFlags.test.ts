// Both review model preferences are on for everyone; only an explicit false
// keeps a person on the old path.
import { describe, expect, test } from "bun:test";
import { commentsFromReviewOn } from "../commentSource";
import { quoteDraftsOn } from "../quoteDraftWire";

describe("review model preferences", () => {
  for (const [name, on, key] of [["quote_drafts", quoteDraftsOn, "quote_drafts"], ["comments_from_review", commentsFromReviewOn, "comments_from_review"]] as const) {
    test(`${name}: on when unset, off only when false`, () => {
      expect(on({})).toBe(true);
      expect(on({ clientState: null })).toBe(true);
      expect(on({ clientState: { ui: null } })).toBe(true);
      expect(on({ clientState: { ui: { [key]: true } } })).toBe(true);
      expect(on({ clientState: { ui: { [key]: false } } })).toBe(false);
    });
  }
});

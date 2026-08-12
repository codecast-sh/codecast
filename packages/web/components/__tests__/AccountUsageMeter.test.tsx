import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountUsageBars } from "../AccountUsageMeter";

describe("AccountUsageBars", () => {
  test("renders limits without the model mix", () => {
    const html = renderToStaticMarkup(
      <AccountUsageBars
        now={1_000}
        usage={{
          fetched_at: 1_000,
          weekly: { percent: 42 },
          models: [{ model: "gpt-5", label: "Sol", tokens: 100, share: 100 }],
        }}
      />,
    );

    expect(html).toContain("Week");
    expect(html).toContain("42%");
    expect(html).not.toContain("model mix");
    expect(html).not.toContain("Sol");
  });

  test("a window whose reset has passed clears instead of showing its old percent", () => {
    // The reported state: a 17h-old snapshot still painting a red 100% session
    // bar for a 5h window that rolled 12h ago.
    const now = 1_000_000_000_000;
    const html = renderToStaticMarkup(
      <AccountUsageBars
        now={now}
        usage={{
          fetched_at: now - 17 * 3600_000,
          session: { percent: 100, resets_at: now - 12 * 3600_000 },
          weekly: { percent: 21, resets_at: now + 3 * 86_400_000 },
        }}
      />,
    );

    expect(html).toContain(">reset<"); // the value cell, not a percentage
    expect(html).not.toContain(">100%<");
    expect(html).toContain("width:0%");
    // The old reading survives only as an explanation on hover.
    expect(html).toContain("window reset 12h ago");
    // The window that hasn't rolled still reads normally.
    expect(html).toContain("21%");
    expect(html).toContain("as of 17h ago");
  });
});

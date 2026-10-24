import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountUsageBars, LoginExpiredBadge } from "../AccountUsageMeter";

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

describe("LoginExpiredBadge", () => {
  const year = 365 * 86_400_000;
  test("an expired saved login reads as expired", () => {
    expect(renderToStaticMarkup(<LoginExpiredBadge profile={{ login_expired_at: 1 }} />)).toContain("login expired");
  });

  test("a live minted token carries the profile, so its dead saved login is not shown", () => {
    // The reported state: a token minted for the profile, and the row still
    // said "login expired" beside the new token chip.
    const html = renderToStaticMarkup(
      <LoginExpiredBadge profile={{ login_expired_at: 1, setup_token: { expires_at: Date.now() + year } }} />,
    );
    expect(html).toBe("");
  });

  test("an expired minted token leaves the dead login showing", () => {
    const html = renderToStaticMarkup(
      <LoginExpiredBadge profile={{ login_expired_at: 1, setup_token: { expires_at: Date.now() - 1 } }} />,
    );
    expect(html).toContain("login expired");
  });
});

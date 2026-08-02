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
});

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DrivingHint, WatchAddress, WheelButton } from "../watchControls";
import { WHEEL_BACK_LABEL, WHEEL_TAKE_LABEL } from "../../../lib/watchLabels";

// The dock and the stage pane both draw these; the copy and the states are
// pinned here once so neither host can drift.
describe("WheelButton", () => {
  test("offers the wheel in sentence case, not pressed, no tint", () => {
    const html = renderToStaticMarkup(<WheelButton on={false} onToggle={() => {}} />);
    expect(html).toContain(`>${WHEEL_TAKE_LABEL}</button>`);
    expect(WHEEL_TAKE_LABEL).toBe("Take the wheel");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("data-sv-wheel");
    expect(html).not.toContain("bg-sol-cyan/15");
    expect(html).toContain('title="Take the wheel: your clicks and typing go to this page, for a sign-in the agent cannot do"');
  });

  test("while the human drives it reads Hand back, is pressed, and wears the cyan tint", () => {
    const html = renderToStaticMarkup(<WheelButton on onToggle={() => {}} />);
    expect(html).toContain(`>${WHEEL_BACK_LABEL}</button>`);
    expect(WHEEL_BACK_LABEL).toBe("Hand back");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("text-sol-cyan");
    expect(html).toContain("bg-sol-cyan/15");
    expect(html).toContain('title="Hand the page back to the agent (Esc)"');
  });

  test("floating over the frame it brings a backdrop in both states", () => {
    expect(renderToStaticMarkup(<WheelButton on={false} onToggle={() => {}} floating />)).toContain("bg-sol-bg/80");
    const on = renderToStaticMarkup(<WheelButton on onToggle={() => {}} floating />);
    expect(on).toContain("color-mix(in_srgb,var(--sol-cyan)");
    expect(on).toContain("backdrop-blur-sm");
  });
});

describe("DrivingHint", () => {
  test("says what is true about the agent and renders Esc as a keycap", () => {
    const html = renderToStaticMarkup(<DrivingHint />);
    expect(html).toContain("data-sv-driving-hint");
    expect(html).toContain("You have the wheel.");
    expect(html).toContain("The agent keeps its session; nothing you do here is sent to it.");
    expect(html).toMatch(/<kbd[^>]*>Esc<\/kbd>/);
    expect(html).toContain("hands back");
    // A drawing over the frame, never a surface: clicks fall through to the page.
    expect(html).toContain("pointer-events-none");
  });
});

describe("WatchAddress", () => {
  test("flashes only once a navigation has happened", () => {
    const still = renderToStaticMarkup(<WatchAddress url="https://a.test/" nav={null} />);
    expect(still).toContain("https://a.test/");
    expect(still).not.toContain("cc-nav-flash");
    const moved = renderToStaticMarkup(<WatchAddress url="https://b.test/" nav={{ url: "https://b.test/", at: 5 }} />);
    expect(moved).toContain("cc-nav-flash");
    expect(moved).toContain('title="https://b.test/"');
  });
});

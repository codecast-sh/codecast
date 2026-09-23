import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ShareImpactBand } from "../ShareImpactBand";
import { startOfDay } from "../../../lib/team/shareImpact";

// The band is the sentence a person reads before a share writes. It must name
// the team, the level, the repos, the count and the span, and it must offer
// the switch that keeps the past private whenever there is a past to keep.

const NOW = Date.now();
const impact = { repos: 2, sessions: 112, first: NOW - 100 * 86_400_000, last: NOW, older: 100, hidden: 0, manuallyShared: 0, truncated: false, exact: true };

function render(props: Partial<Parameters<typeof ShareImpactBand>[0]> = {}) {
  return renderToStaticMarkup(
    <ShareImpactBand
      teamName="Littlebird"
      memberCount={4}
      visibility="full"
      selectedNames={["codecast", "mail"]}
      impact={impact}
      since={null}
      onSinceChange={() => {}}
      {...props}
    />,
  );
}

describe("ShareImpactBand", () => {
  test("says who sees how much of what, and how many sessions", () => {
    const html = render();
    expect(html).toContain("Littlebird");
    expect(html).toContain("3 teammates");
    expect(html).toContain("the whole conversation");
    expect(html).toContain("codecast and mail");
    expect(html).toContain("112 sessions");
    expect(html).toContain("to today");
    expect(html).toContain('aria-label="Include past sessions"');
  });
  test("with a share start it says what stays private", () => {
    const html = render({ since: startOfDay(NOW) });
    expect(html).toContain("12 sessions from today on");
    expect(html).toContain("100 sessions before that stay private");
  });
  test("the scope controls offer everything, today and a date", () => {
    const html = render({ controls: "scope", since: startOfDay(NOW) });
    expect(html).toContain("Everything, past sessions included");
    expect(html).toContain("From today on");
    expect(html).toContain('type="date"');
    expect(html).not.toContain('aria-label="Include past sessions"');
  });
  test("nothing selected reads as private", () => {
    const html = render({ impact: { ...impact, repos: 0, sessions: 0 } });
    expect(html).toContain("Nothing selected");
    expect(html).not.toContain("Include past sessions");
  });
  test("a hidden level warns instead of promising", () => {
    const html = render({ visibility: "hidden" });
    expect(html).toContain("Hidden");
    expect(html).not.toContain('aria-label="Include past sessions"');
  });
  test("a still loading count says so", () => {
    const html = render({ impact: { ...impact, exact: false } });
    expect(html).toContain("Still counting");
  });
});

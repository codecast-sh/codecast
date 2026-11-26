import { describe, expect, mock, test } from "bun:test";

// A stage's state, and which half of a fan-out stopped, sent back or waits, reads without color: a glyph on screen and
// words for a screen reader.

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));
const targetsHook = { ...(await import("../../hooks/useSyncDeployTargets")) };
mock.module("../../hooks/useSyncDeployTargets", () => ({ ...targetsHook, useDeployTargets: () => ({ targets: [], deploys: [], ready: true }) }));
const pressHook = { ...(await import("../../hooks/useDeployPress")) };
mock.module("../../hooks/useDeployPress", () => ({ ...pressHook, useDeployPress: () => ({ open() {}, review: null }) }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { JourneyTrack } = await import("./Journey");

const stage = (id: string, label: string, state: string, extra: object = {}) => ({ id, label, role: "step", who: "auto", state, round: null, loops: [], ...extra }) as any;
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

describe("states that read without color", () => {
  test("a fan-out branch that was sent back or stopped carries a glyph and its state in words", () => {
    const fan = stage("checks", "CI + Review", "back", { role: "parallel", branches: [stage("ci", "CI", "back"), stage("review", "Review", "done")] });
    const html = renderToStaticMarkup(<JourneyTrack stages={[stage("pr", "PR", "done"), fan, stage("merge", "Merge", "idle")]} />);
    expect(html).toContain('class="sj-branch-flag" aria-hidden="true">↩</i>');
    expect(text(html)).toContain("CI↩ (sent back) + Review, sent back");
    // Each stage's own state is said: done, the fan-out sent back, and nothing for one not reached.
    expect(text(html)).toContain("PR, done");
    expect(text(html)).not.toContain("Merge,");
    const stopped = renderToStaticMarkup(<JourneyTrack stages={[stage("checks", "CI + Review", "stopped", { role: "parallel", branches: [stage("ci", "CI", "done"), stage("review", "Review", "stopped")] })]} />);
    expect(text(stopped)).toContain("CI + Review✕ (stopped), stopped");
  });
});

describe("a branch that found nothing to do", () => {
  const fan = (state: string, check: string) => stage("checks", "Check + Review", state, { role: "parallel", who: "agent", branches: [stage("check", "Check", check), stage("review", "Review", state === "back" ? "back" : "done")] });
  test("says so beside who acts, never in place of it, and never inside the stage's name", () => {
    const back = text(renderToStaticMarkup(<JourneyTrack stages={[fan("back", "nothing"), stage("land", "Land", "idle")]} />));
    expect(back).toContain("Check + Review↩ (sent back), sent back");
    expect(back).toContain("This session · Check skipped");
    const waiting = text(renderToStaticMarkup(<JourneyTrack stages={[fan("waiting", "nothing"), stage("land", "Land", "idle")]} />));
    expect(waiting).toContain("Agent · Check skipped");
    // A finished run says only what happened.
    const done = renderToStaticMarkup(<JourneyTrack stages={[fan("done", "nothing"), stage("land", "Land", "done")]} />);
    expect(text(done)).toContain("Check + Review, doneCheck skipped");
    expect(done).not.toContain("sj-branch-flag");
    // A later round's finished stage says its round, then what it skipped, apart.
    const round2 = renderToStaticMarkup(<JourneyTrack stages={[{ ...fan("done", "nothing"), round: 2 }, stage("land", "Land", "done")]} />);
    expect(text(round2)).toContain("round 2 · Check skipped");
  });
});

const { journeyStages } = await import("../../lib/ship/journey");
const { appPool, flowBySlug } = await import("../../lib/line/flowPool");
const { LAND_REPO_FLOW } = await import("../../lib/ship/journeyFixtures");

describe("a segment stage", () => {
  const stages = journeyStages(flowBySlug(appPool([], [LAND_REPO_FLOW]), "change")!).map((s) => ({ ...s, state: "idle", round: null })) as any;
  test("hints at its inside under its name, a press away from opening it", () => {
    const html = renderToStaticMarkup(<JourneyTrack stages={stages} onOpen={() => {}} insideId="in1" />);
    expect(html).toContain('aria-expanded="false" aria-controls="in1"');
    expect(text(html)).toContain("PR · CI + Review · Merge");
  });
  test("alone and sending work back, it draws a hook under itself, not a bracket of no width", () => {
    expect(renderToStaticMarkup(<JourneyTrack stages={stages} />)).toContain("data-single");
    const two = [stage("pr", "PR", "idle", { loops: [{ id: "fix", label: "Fix", max: 3 }] }), stage("merge", "Merge", "idle", { loops: [{ id: "fix", label: "Fix", max: 3 }] })];
    expect(renderToStaticMarkup(<JourneyTrack stages={two} />)).not.toContain("data-single");
  });
});

import { describe, expect, mock, test } from "bun:test";

// A finished run drawn on a newer version of its flow (ct-98800): every stage it passed reads done with a check and a
// green way into it, the bar says where the change went, and a stage the run never entered has no green way into it.

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));
const targetsHook = { ...(await import("../../hooks/useSyncDeployTargets")) };
mock.module("../../hooks/useSyncDeployTargets", () => ({ ...targetsHook, useDeployTargets: () => ({ targets: [], deploys: [], ready: true }) }));
const pressHook = { ...(await import("../../hooks/useDeployPress")) };
mock.module("../../hooks/useDeployPress", () => ({ ...pressHook, useDeployPress: () => ({ open() {}, review: null }) }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { JourneyTrack, JourneyView } = await import("./Journey");
const { journeyOf } = await import("../../lib/ship/journey");
const { pushedFlow } = await import("../../lib/line/flowPool");
const { UNION_CHANGE_FLOW, UNION_FLAT_RUN } = await import("../../lib/ship/journeyFixtures");

/** Each stage as the track draws it: its id, its state, whether the way out of it is green, and whether its node holds a check. */
const drawn = (html: string) => [...html.matchAll(/<li class="sj-stage"([^>]*)>([\s\S]*?)<\/li>/g)].map(([, attrs, inner]) => ({
  id: attrs.match(/data-stage="([^"]+)"/)![1],
  state: attrs.match(/data-state="([^"]+)"/)![1],
  past: /data-past=""/.test(attrs),
  check: /lucide-check/.test(inner),
}));

describe("a finished run's track", () => {
  const flow = pushedFlow({ _id: "wf_union_change", ...UNION_CHANGE_FLOW });
  const run = { ...UNION_FLAT_RUN, workspace: "team:T1", spawner_conversation_id: "conv1" };
  const journey = journeyOf(flow, run as any);

  test("the run that recorded flat ids draws Land, Deploy and Live done, checked, joined by green ways", () => {
    expect(drawn(renderToStaticMarkup(<JourneyTrack stages={journey.stages} />))).toEqual([
      { id: "land", state: "done", past: true, check: true },
      { id: "deploy", state: "done", past: true, check: true },
      { id: "live", state: "done", past: false, check: true },
    ]);
  });

  test("its bar says Live", () => {
    const html = renderToStaticMarkup(<JourneyView journey={journey} run={run} now_ms={20} />);
    expect(html).toContain('data-journey="live"');
    expect(html).toMatch(/<b>Live<\/b>/);
  });

  test("no green way into a stage the run never entered", () => {
    const stages = journey.stages.map((s, i) => ({ ...s, state: i === 0 ? "done" as const : "skipped" as const }));
    expect(drawn(renderToStaticMarkup(<JourneyTrack stages={stages} />)).map((s) => [s.id, s.state, s.past])).toEqual([
      ["land", "done", false], ["deploy", "skipped", false], ["live", "skipped", false],
    ]);
  });
});

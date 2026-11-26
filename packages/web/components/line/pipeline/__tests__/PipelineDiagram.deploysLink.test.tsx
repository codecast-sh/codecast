// The pipeline page's main row: each target links into /deploys at its target on the pipeline's team and repository,
// with the deploy its words are about highlighted (going out, else failed, else live), and none when it has none.
import { expect, mock, test } from "bun:test";

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));
// The page's other sections read the store and Convex; only the main row is under test.
mock.module("../CheckoutsSection", () => ({ CheckoutsSection: () => null }));
mock.module("../../../ShareControl", () => ({ ShareControl: () => null }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { PipelineDiagram } = await import("../PipelineDiagram");
const { PIPELINE_FIXTURES } = await import("../../../../lib/line/__tests__/pipelines.fixture.generated");
const { pipelineModel } = await import("../../../../lib/line/pipelineModel");

const example = PIPELINE_FIXTURES.find((p) => p.repository === "example-org/example-app")!;

test("each main target opens on Deploys at its deploy: going, else failed, else live while nothing waits; none without one", () => {
  const m = pipelineModel(example);
  const quiet = { policy: "auto", runs: "here", waiting: 0, groups: [], live: null, going: null, failed: null } as const;
  const live = { deploy: "dp-3", version: null, at: 1 };
  const model = {
    ...m,
    main: {
      waiting: 0,
      targets: [
        { ...quiet, name: "web", tone: "going", live, going: { deploy: "dp-7", step: null, outside: false, stuck: null }, failed: { deploy: "dp-5", at: 1, step: null } },
        { ...quiet, name: "cli", tone: "failed", live, failed: { deploy: "dp-5", at: 1, step: null } },
        { ...quiet, name: "api", tone: "current", live },
        { ...quiet, name: "docs", tone: "current" },
        // Commits wait to ship: its words are about them, not the old live deploy.
        { ...quiet, name: "app", tone: "behind", live, waiting: 3 },
      ],
    },
  } as any;
  const html = renderToStaticMarkup(<PipelineDiagram model={model} pipeline={example as any} teamId="T1" />).replace(/&amp;/g, "&");
  const links = [...html.matchAll(/<a href="([^"]*)"[^>]*data-pv-target="([^"]+)"/g)].map((x) => [x[2], x[1]]);
  expect(links).toEqual([
    ["web", "/deploys?team=T1&repo=example-org%2Fexample-app&target=web&deploy=dp-7"],
    ["cli", "/deploys?team=T1&repo=example-org%2Fexample-app&target=cli&deploy=dp-5"],
    ["api", "/deploys?team=T1&repo=example-org%2Fexample-app&target=api&deploy=dp-3"],
    ["docs", "/deploys?team=T1&repo=example-org%2Fexample-app&target=docs"],
    ["app", "/deploys?team=T1&repo=example-org%2Fexample-app&target=app"],
  ]);
});

test("a personal pipeline's targets are not links: Deploys belong to a team", () => {
  const m = pipelineModel(example);
  const model = { ...m, main: { waiting: 0, targets: [{ policy: "auto", runs: "here", waiting: 0, groups: [], live: { deploy: "dp-3", version: null, at: 1 }, going: null, failed: null, name: "web", tone: "current" }] } } as any;
  const html = renderToStaticMarkup(<PipelineDiagram model={model} pipeline={example as any} teamId={null} />);
  expect(html).toContain('data-pv-target="web"');
  expect(html).not.toMatch(/<a [^>]*data-pv-target/);
});

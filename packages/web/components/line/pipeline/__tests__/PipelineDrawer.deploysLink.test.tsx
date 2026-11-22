// The drawer's "Waiting to ship" targets link into /deploys at their target on the pipeline's team and repository; one
// with a deploy going out or failed opens with that deploy highlighted.
import { expect, mock, test } from "bun:test";

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { MainDetails } = await import("../PipelineDrawer");
const { PIPELINE_FIXTURES } = await import("../../../../lib/line/__tests__/pipelines.fixture.generated");
const { pipelineModel } = await import("../../../../lib/line/pipelineModel");

const example = PIPELINE_FIXTURES.find((p) => p.repository === "example-org/example-app")!;

test("each target opens on Deploys, a going or failed one at its deploy", () => {
  const m = pipelineModel(example);
  const quiet = { policy: "auto", runs: "here", waiting: 0, groups: [], live: null, going: null, failed: null } as const;
  const model = {
    ...m,
    main: {
      waiting: 0,
      targets: [
        { ...quiet, name: "web", tone: "going", going: { deploy: "dp-7", step: null, outside: false, stuck: null } },
        { ...quiet, name: "cli", tone: "failed", failed: { deploy: "dp-5", at: 1, step: null } },
        { ...quiet, name: "docs", tone: "current" },
      ],
    },
  } as any;
  const html = renderToStaticMarkup(<MainDetails model={model} teamId="T1" />).replace(/&amp;/g, "&");
  const links = [...html.matchAll(/href="(\/deploys[^"]*)"/g)].map((x) => x[1]);
  expect(links).toEqual([
    "/deploys?team=T1&repo=example-org%2Fexample-app&target=web&deploy=dp-7",
    "/deploys?team=T1&repo=example-org%2Fexample-app&target=cli&deploy=dp-5",
    "/deploys?team=T1&repo=example-org%2Fexample-app&target=docs",
  ]);
});

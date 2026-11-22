// The pipeline drawing as markup: what a person reads on each station (pipeline.md PL6, PL7). A change standing on a
// station is counted on it on the full drawing as on the list's strip, a group reads by its own name everywhere, and
// release steps with nothing to run say so once on the lane.
import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FlowDiagram } from "../../widgets/FlowDiagram";
import { PipelineStrip } from "../PipelineDiagram";
import { PipelineTrack } from "../PipelineTrack";
import { trackOf } from "../../../../lib/line/pipelineView";
import { PIPELINE_FIXTURES } from "../../../../lib/line/__tests__/pipelines.fixture.generated";
import { pipelineModel, type PipelineRun } from "../../../../lib/line/pipelineModel";

const example = PIPELINE_FIXTURES.find((p) => p.repository === "example-org/example-app")!;
const run = (id: string, at: string): PipelineRun => ({ _id: id, status: "running", workflow_slug: "change", project_path: "/w/example-app", current_node_id: at, created_at: 1 });

test("a change on a station is counted on the full drawing and on the strip", () => {
  const m = pipelineModel(example, [run("a", "ci"), run("b", "merge")]);
  const full = renderToStaticMarkup(<FlowDiagram flow={m.change.drawn} diagram={m.change.diagram} marks={m.change.marks} quietRoutes onPick={() => {}} />);
  expect(full.match(/data-mark="here"[^>]*>1 here</g)?.length).toBe(2);
  const strip = renderToStaticMarkup(<PipelineStrip model={m} />);
  expect(strip).toContain("1 here");
  // One label per station: the group reads by its own name on the strip too.
  expect(strip).toContain("CI and review");
  expect(strip).not.toContain("CI + Review");
});

test("a step with no command is quiet, and a waiting deploy says what it waits for", () => {
  const m = pipelineModel(example);
  const release = renderToStaticMarkup(<FlowDiagram flow={m.release.drawn} diagram={m.release.diagram} marks={m.release.marks} quietRoutes />);
  expect(release).toContain('data-passes=""');
  expect(release).toContain("no command");
  const change = renderToStaticMarkup(<FlowDiagram flow={m.change.drawn} diagram={m.change.diagram} marks={m.change.marks} quietRoutes />);
  expect(change).toContain("waits for the deploy");
  expect(change).not.toContain("sends none");
});

test("the overview's track: only the passing path, a count on the pill a change stands on, hollow steps with no command", () => {
  const m = pipelineModel(example, [run("a", "ci")]);
  const change = renderToStaticMarkup(<PipelineTrack items={trackOf(m.change, true)} onOpen={() => {}} />);
  expect(change).toContain(">Session<");
  expect(change).toMatch(/class="pt-count"[^>]*>1</);
  // Side routes live in the drawer: none of their words reach the track.
  expect(change).not.toMatch(/other ways|sends|loop/i);
  const release = renderToStaticMarkup(<PipelineTrack items={trackOf(m.release, false)} />);
  expect(release).toContain('data-kind="none"');
  // Without onOpen (the list's card is one link) a pill is no button.
  expect(release).not.toContain("<button");
});

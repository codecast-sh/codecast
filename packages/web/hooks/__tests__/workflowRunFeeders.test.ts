// The run feeders skip ids that are not Convex ids. The render gallery seeds
// fixture runs (lib/renderGalleryFlows.ts) whose cards mount these feeders;
// before they went through entityIdArgs, every open gallery sent its fixture
// ids to `v.id("workflow_runs")` validators: ~350 ArgumentValidationErrors in
// prod's workflow_runs:get and graphOfRun in six hours (2026-11-26).
import { test, expect, describe, mock } from "bun:test";
import * as real from "../useSyncCollection";

const calls: Array<{ args: unknown }> = [];
mock.module("../useSyncCollection", () => ({
  ...real,
  useSyncCollection: (_key: string, _fn: unknown, args: unknown) => {
    calls.push({ args });
    return { ready: false, error: undefined };
  },
}));

const { useSyncWorkflowRun, useSyncRunGraph, useSyncWorkflowRuns } = await import("../useSyncWorkflows");
const { GALLERY_FLOW } = await import("../../lib/renderGalleryFlows");

const REAL_ID = "jx7edd00y85v1rgj5tda5s9cm98ewywv";

describe("workflow run feeders", () => {
  test.each([
    ["useSyncWorkflowRun", useSyncWorkflowRun],
    ["useSyncRunGraph", useSyncRunGraph],
    ["useSyncWorkflowRuns", useSyncWorkflowRuns],
  ] as const)("%s skips gallery fixture ids and subscribes for Convex ids", (_name, feeder) => {
    for (const id of [GALLERY_FLOW.shipLandBack, GALLERY_FLOW.liveRun, GALLERY_FLOW.graphId]) {
      calls.length = 0;
      feeder(id);
      expect(calls.at(-1)?.args).toBe("skip");
    }
    calls.length = 0;
    feeder(REAL_ID);
    expect(Object.values(calls.at(-1)?.args as object)).toEqual([REAL_ID]);
  });
});

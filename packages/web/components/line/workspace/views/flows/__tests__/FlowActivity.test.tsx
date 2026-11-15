import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { JSDOM } from "jsdom";
import { FlowActivity, type ActivityFilter } from "../FlowActivity";
import type { FlowRun } from "../../../../../../hooks/useFlowLibrary";

const NOW = 1_000_000_000;
const run = (id: string, slug: string, node: string) => ({ _id: id, status: "running", workflow_slug: slug, current_node_id: node, current_node_label: node, updated_at: NOW - 1000, created_at: NOW - 5000 }) as unknown as FlowRun;
const family = [run("a", "onefix", "build"), run("b", "onefix", "review")];
const atCheck = [run("b", "onefix", "review"), run("c", "change", "decide")];

const draw = (filter: ActivityFilter) => new JSDOM(renderToStaticMarkup(
  <MemoryRouter><FlowActivity runs={family} atCheck={atCheck} flowLabel={() => null} now={NOW} href={() => "/x"} filter={filter} onFilter={() => {}} /></MemoryRouter>,
)).window.document;

describe("the Flows stage's run list", () => {
  test("At a check lists the runs standing at a check, from any flow, as the Checks count counts them", () => {
    const doc = draw("check");
    expect(doc.querySelector('[data-flow-activity-filter="check"]')?.getAttribute("aria-selected")).toBe("true");
    expect([...doc.querySelectorAll("[data-flow-activity-run]")].map((a) => a.getAttribute("data-flow-activity-run"))).toEqual(["b", "c"]);
  });

  test("All lists the live flows' own runs", () => {
    expect([...draw("all").querySelectorAll("[data-flow-activity-run]")].map((a) => a.getAttribute("data-flow-activity-run"))).toEqual(["a", "b"]);
  });
});

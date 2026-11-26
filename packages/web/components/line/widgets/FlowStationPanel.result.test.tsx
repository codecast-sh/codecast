import { describe, expect, mock, test } from "bun:test";

// A station open under its drawing says what it did on the run from its result: a red Check or a failed Deploy exits 0
// and says so in its result JSON, so it reads Failed, never Done.

mock.module("next/link", () => ({ default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a> }));
const stations = { ...(await import("../../../lib/line/flowStations")) };
mock.module("../../../lib/line/flowStations", () => ({ ...stations, useFlowStations: () => undefined }));
// A pill for the session that ran a station reads the store; the station's own run line is what this reads.
const pill = { ...(await import("../../EntityIdPill")) };
mock.module("../../EntityIdPill", () => ({ ...pill, EntityIdPill: () => null }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { FlowStationPanel } = await import("./FlowStationPanel");
const { appPool, flowBySlug } = await import("../../../lib/line/flowPool");

const { end, replay } = await import("../../../lib/ship/__tests__/replayReports");
const { at } = await import("../../../lib/ship/__tests__/replayReports");

// Runs from the real runner's replayed reports (lib/ship/__tests__/replayReports.ts).
const personal = flowBySlug(appPool(), "personal")!;
const panel = (id: string, kind: any, run: object) => renderToStaticMarkup(<FlowStationPanel flow={personal} pick={{ id, kind }} run={run as any} onClose={() => {}} />);
const runLine = (html: string) => html.match(/<div class="fsp-run" data-status="(\w+)"><span class="fsp-run-state">([^<]*)</)?.slice(1);

describe("a station's run, from its result", () => {
  test("a red Check and a failed Deploy read sent back while the session fixes them, Failed where the run stopped; a passing Check reads Done", () => {
    expect(runLine(panel("check", "script", at(replay("a red check goes back to the session as one brief"), { node: "brief", status: "running" })))).toEqual(["back", "Sent back"]);
    expect(runLine(panel("deploy", "agent", at(replay("a failed deploy goes back to the session to fix the script"), { node: "deploy_fix", status: "running" })))).toEqual(["back", "Sent back"]);
    expect(runLine(panel("deploy", "agent", end(replay("a deploy that still fails after three fixes"))))).toEqual(["failed", "Failed"]);
    expect(runLine(panel("check", "script", end(replay("a passing check and a ship verdict land"))))).toEqual(["completed", "Done"]);
  });

  test("in round 2 an earlier round's red Check is no run line of this round", () => {
    expect(runLine(panel("check", "script", at(replay("a red check goes back to the session as one brief"), { node: "round", status: "running" }, 1)))).toBeUndefined();
  });

  test("a step left for the person opens the task it was posted to", () => {
    const done = end(replay("a deploy with one step left for the person"));
    expect(panel("deploy", "agent", done)).toContain(`href="/tasks/${done.task_short_id}"`);
  });
});

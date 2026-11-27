import { describe, expect, mock, test } from "bun:test";

// An open pull request's shipping strip says what its card on the Deploys page says: from its Ship run when one
// carries it (the decision it waits on is a link), else from GitHub with Ship as the press; and it always links to
// that card for a reader on the team.

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));
let runs: any[] = [];
const realShipping = { ...(await import("../../hooks/useSyncShipping")) };
mock.module("../../hooks/useSyncShipping", () => ({ ...realShipping, useShipping: () => ({ shipping: { runs, shippers: [] }, error: false }) }));
const realShip = { ...(await import("../ShipControl")) };
mock.module("../ShipControl", () => ({ ...realShip, ShipControl: () => <button data-ship-control>Ship</button> }));
const realPill = { ...(await import("../EntityIdPill")) };
mock.module("../EntityIdPill", () => ({ ...realPill, EntityIdPill: ({ shortId, id }: any) => <span data-pill>{shortId ?? id}</span> }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { PRShipStrip } = await import("./PRShipStrip");

const model = (over: any = {}): any => ({
  teamId: "T1", repository: "acme/app", number: 101, open: true, merged: false, declares: true, rows: [], dormant: [], now: 0, mergedAt: null,
  shipsTo: [{ target: { _id: "t1", name: "cli", runs: "here", policy: "release" }, idle: false }], press: { open() {}, review: null }, headline: null, ...over,
});
const run = (over: any = {}) => ({
  _id: "r1", status: "paused", task_id: "t", task_short_id: "ct-9", task_title: "Fix", workflow_slug: "change", workflow_label: null,
  current_node_id: "merge", current_node_label: "Merge", node_statuses: [], pr: { repository: "acme/app", number: 101 }, fail_reason: null,
  ci_verdict: { green: true, head_sha: "a", at: 1 }, review_verdict: { verdict: "ship", at: 1 }, merge: null,
  gate_prompt: "Merge?", gate_node_id: "merge", gate_decision_short_id: "dc-7", gate_decision_status: "pending",
  spawner_conversation_id: null, stand_in: false, primary_conversation_id: null, project_path: null, user_id: "u", created_at: 1, updated_at: 2, ...over,
});
const strip = (pr: any, m = model(), authed = true) => renderToStaticMarkup(<PRShipStrip pr={{ _id: "p1", number: 101, ...pr }} model={m} shepherd={null} authed={authed} />);

describe("the PR page's shipping strip", () => {
  test("a run waiting on a decision: the stepper, the decision as a link, no second Ship, and Open on Deploys", () => {
    runs = [run()];
    const html = strip({});
    expect(html).toContain('data-pr-ship="run"');
    expect(html).toContain('href="/decisions/dc-7"');
    expect(html).toContain("Waiting on a decision");
    expect(html).not.toContain("data-ship-control");
    expect(html).toContain('href="/deploys?team=T1&amp;repo=acme%2Fapp&amp;target=cli&amp;pr=101"');
    expect(html).toContain("ct-9");
  });

  test("a run on another repository's PR of the same number does not stand for this one", () => {
    runs = [run({ pr: { repository: "acme/other", number: 101 } })];
    expect(strip({ checks_state: "failure" })).toContain('data-pr-ship="pr"');
  });

  test("no run: GitHub's state in the same words as its Deploys card, Ship to start one, and the link even when it deploys nothing", () => {
    runs = [];
    const html = strip({ checks_state: "failure" }, model({ shipsTo: [] }));
    expect(html).toContain('data-pr-ship="pr"');
    expect(html).toContain("CI failing");
    expect(html).toContain("data-ship-control");
    expect(html).toContain('href="/deploys?team=T1&amp;repo=acme%2Fapp&amp;pr=101"');
    expect(html).not.toContain("Goes to");
  });

  test("a reader outside the team gets the stepper and no Deploys link; a merged or closed PR gets no strip", () => {
    runs = [];
    // With no team no targets are read (usePrDeploy), so nothing is declared either.
    expect(strip({}, model({ teamId: null, declares: false, shipsTo: [] }), false)).not.toContain("/deploys");
    expect(strip({}, model({ open: false, merged: true }))).toBe("");
  });
});

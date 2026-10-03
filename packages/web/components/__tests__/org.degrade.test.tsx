// THE ORG CHART PAINTS ITS CACHED TREE WHEN ITS BACKEND IS MISSING.
//
// /org mounted in the dashboard shell over a convex transport that answers
// every query "Could not find public function" (test-helpers/
// missingBackend.tsx), the live site between a web push and its convex
// deploy. The chart paints the orgTree collection; org.tree and the proposal
// list only refresh and annotate it, so the cached people and roles stay on
// screen and no part of the page falls into an ErrorBoundary.
// Run: cd packages/web && bun test --isolate components/__tests__/org.degrade.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, installDom, installMissingBackend, seedViewer, TEAM_ID } from "../../test-helpers/missingBackend";

const { mountPage } = installDom("https://app.test/org");
const backend = await installMissingBackend();
await seedViewer();

const { useInboxStore } = await import("../../store/inboxStore");
const { ORG_FIXTURE } = await import("../org/orgFixture");
const { default: OrgPage } = await import("../../app/org/page");

useInboxStore.setState({ orgTree: { ...ORG_FIXTURE, workspace: { kind: "team", id: TEAM_ID, name: "Degrade Co" } } } as any);

test("the org chart paints its cached people and roles with every query missing", async () => {
  const page = await mountPage("/org", { org: <OrgPage /> });
  try {
    expect(describeFailures(page)).toBe("");
    const text = page.text();
    expect(text).toContain("Head of Growth");
    expect(text).toContain("Samvit Jain");
    for (const fn of ["org:tree", "orgProposals:list"]) expect(backend.refused).toContain(fn);
  } finally {
    await page.unmount();
  }
}, 120_000);

import { expect, mock, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { featureOffCopy } from "@platform/flags";
import { TEAM_FEATURE_CATALOG } from "../../lib/teamFeatures";
import { realInboxStore, restoreInboxStoreAfterAll } from "../../components/__tests__/mockInboxStore";

// The route holds the page's gates, so a rewritten ChangesPage cannot drop
// them: no team gets the team line, a team with the flag off gets the shared
// off landing, and only a team with it on reaches the page.
// Link the page before substituting the store (see OrgIntro.mount.test.tsx):
// the substitution mutates the live module, so the linked page reads the stub.
const { ChangesGate } = await import("./page");
const fake = { state: {} as any };
mock.module("../../store/inboxStore", () => ({
  ...realInboxStore,
  useInboxStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(fake.state),
    realInboxStore.useInboxStore,
    { getState: () => fake.state },
  ),
}));
restoreInboxStoreAfterAll();

function render(team: { _id: string; features?: Record<string, boolean> } | null) {
  fake.state = { teams: team ? [team] : [], clientState: { ui: { active_team_id: team?._id } } };
  return renderToStaticMarkup(<ChangesGate><span>changes-page</span></ChangesGate>);
}

test("no team: the team line, never the page", () => {
  const html = render(null);
  expect(html).toContain("Changes is written for a team");
  expect(html).not.toContain("changes-page");
});

test("flag off: the off landing, never the page", () => {
  const html = render({ _id: "t1", features: { changes: false } });
  expect(html).toContain(featureOffCopy(TEAM_FEATURE_CATALOG, "changes", false).title);
  expect(html).not.toContain("changes-page");
});

test("flag on: the page", () => {
  expect(render({ _id: "t1", features: { changes: true } })).toContain("changes-page");
});

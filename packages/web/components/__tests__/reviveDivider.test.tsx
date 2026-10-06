import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { MID_WORK_REVIVE_MESSAGE } from "@codecast/shared/contracts";

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
  useAction: () => async () => undefined,
  useConvex: () => ({ query: async () => null, mutation: async () => null }),
}));
const { ReviveDivider } = await import("../conversation/blocks/systemBlocks");

// The watchdog's revive of a session whose process died mid-work is codecast
// talking to the agent: one captioned rule, the note behind a click, never
// the account-recovery pill or the whole paragraph.
describe("revive divider", () => {
  test("a one-line rule with the note collapsed", () => {
    const html = renderToStaticMarkup(<MemoryRouter><ReviveDivider content={MID_WORK_REVIVE_MESSAGE} timestamp={1_790_000_000_000} /></MemoryRouter>);
    expect(html).toContain('data-switch-divider="mid-work-revive"');
    expect(html).toContain("restarted after the agent process exited");
    expect(html).not.toContain("Pick up where you left off");
    expect(html).not.toContain("usage limit");
  });
});

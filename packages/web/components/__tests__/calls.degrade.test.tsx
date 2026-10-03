// THE CALLS PAGE AND THE FACE ROW STAND WHEN THEIR BACKEND IS MISSING.
//
// /calls mounted in the dashboard shell over a convex transport that answers
// every query "Could not find public function" (test-helpers/
// missingBackend.tsx), the live site between a web push and its convex
// deploy.
//
//   face row    the faces in the top bar paint from the cached roster; the
//               roster, the call config and the room feeds only refresh it
//   call list   the list has no cache of its own, so it says the calls could
//               not be loaded and offers to try again, instead of "Loading…"
//               forever; the record button and the rest of the page stay
// Run: cd packages/web && bun test --isolate components/__tests__/calls.degrade.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, fixtureId, installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

const TEAMMATE = fixtureId("degradeteammate");

const { mountPage } = installDom("https://app.test/calls");
const backend = await installMissingBackend();
await seedViewer();

const { useInboxStore } = await import("../../store/inboxStore");
const { default: CallsPage } = await import("../../app/calls/page");

const store = useInboxStore.getState();
store.syncTable("teamMembers", [
  ...(store.teamMembers as any[]),
  { _id: TEAMMATE, name: "Sam Teammate", email: "sam@degrade.test", role: "member", presence_state: "active" },
] as any);

test("the calls page and the face row render through every missing query", async () => {
  const page = await mountPage("/calls", { calls: <CallsPage /> });
  try {
    expect(describeFailures(page)).toBe("");
    // The face row: the cached teammate is a face in the shell's top bar.
    expect(page.container.querySelector(`[data-face-id="${TEAMMATE}"]`)).not.toBeNull();
    // The list: an honest failure with a way to ask again.
    const text = page.text();
    expect(text).toContain("Your calls could not be loaded.");
    expect(text).not.toContain("Loading…");
    expect([...page.container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Try again")).toBe(true);
    expect(text).toContain("Record audio");
    for (const fn of ["transcripts:webListCalls", "teams:getTeamMembers", "calls:getCallConfig"]) {
      expect(backend.refused).toContain(fn);
    }
  } finally {
    await page.unmount();
  }
}, 120_000);

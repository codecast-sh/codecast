// PAGE EMBEDS IN A MESSAGE STAND WHEN THEIR BACKEND IS MISSING.
//
// A cached conversation whose agent posted a published page, a Claude
// artifact and a plain web link, each alone on its line, opened in the
// dashboard shell over a convex transport that answers every query "Could not
// find public function" (test-helpers/missingBackend.tsx). The page's title
// and author (artifacts.getShared) and the link's unfurl (linkPreviews.get)
// only dress the card, so each embed still renders its frame or its address,
// and the message around them stays.
// Run: cd packages/web && bun test --isolate components/__tests__/publishedPageEmbed.degrade.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, fixtureId, installDom, installMissingBackend, seedCachedSession, seedViewer } from "../../test-helpers/missingBackend";

const SESSION = fixtureId("convembeds");
// Page slugs are alphanumeric secrets of 8 to 24 characters.
const SLUG = "launchRpt7Kq2x";
const ARTIFACT = "0f6c2a7e-5b1d-4c3e-9a8f-2d4b6e8a1c3f";

const { mountPage } = installDom(`https://app.test/conversation/${SESSION}`);
const backend = await installMissingBackend();
await seedViewer();

const { default: ConversationRoute } = await import("../../app/conversation/[id]/page");
const { default: InboxPage } = await import("../../app/inbox/page");

await seedCachedSession(SESSION, "Publish the launch report", [
  { role: "user", content: "Publish the launch report" },
  {
    role: "assistant",
    content: [
      "Published it here:",
      "",
      `https://codecast.sh/a/${SLUG}`,
      "",
      "The prototype is a Claude artifact:",
      "",
      `https://claude.ai/public/artifacts/${ARTIFACT}`,
      "",
      "Background reading:",
      "",
      "https://example.com/launch-checklist",
    ].join("\n"),
  },
]);

test("a published page, a Claude artifact and a link render in a message with every query missing", async () => {
  const page = await mountPage(`/conversation/${SESSION}`, { "conversation/:id": <ConversationRoute />, inbox: <InboxPage /> });
  try {
    expect(describeFailures(page)).toBe("");
    const html = page.container.innerHTML;
    // The published page: its card links the public address and frames it.
    expect(html).toContain(`href="https://codecast.sh/a/${SLUG}"`);
    expect([...page.container.querySelectorAll("iframe")].some((f) => f.getAttribute("src")?.includes(SLUG))).toBe(true);
    // The artifact and the link keep their addresses on screen.
    expect(html).toContain(ARTIFACT);
    expect(html).toContain("example.com");
    // The words around the embeds are still the message.
    expect(page.text()).toContain("Published it here:");
    for (const fn of ["artifacts:getShared", "linkPreviews:get"]) expect(backend.refused).toContain(fn);
  } finally {
    await page.unmount();
  }
}, 120_000);

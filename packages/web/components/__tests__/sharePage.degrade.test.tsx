// A SHARED PAGE STANDS WHEN ITS BACKEND IS MISSING.
//
// /share/doc/<token> (every SharedObjectPage kind takes the same path)
// mounted over a convex transport that answers every query "Could not find
// public function" (test-helpers/missingBackend.tsx), the live site between
// a web push and its convex deploy.
//
//   preloaded   the prod server inlines the share payload into the HTML, so
//               the page paints the doc from it and the failed live read
//               costs only freshness
//   no preload  nothing is known about the link, so the page says the server
//               did not answer and offers to try again; it does not call the
//               link closed, and it does not spin forever
// Run: cd packages/web && bun test --isolate components/__tests__/sharePage.degrade.test.tsx
import { afterEach, expect, test } from "bun:test";
import { describeFailures, installDom, installMissingBackend } from "../../test-helpers/missingBackend";

const TOKEN = "shr7Kq2xLaunchNotes";

const { mountSurface } = installDom(`https://app.test/share/doc/${TOKEN}`);
const backend = await installMissingBackend();

const { MemoryRouter, Routes, Route } = await import("react-router");
const { default: ShareDocPage } = await import("../../app/share/doc/[token]/page");

const mountShare = () =>
  mountSurface(
    <MemoryRouter initialEntries={[`/share/doc/${TOKEN}`]}>
      <Routes>
        <Route path="share/doc/:token" element={<ShareDocPage />} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => {
  delete (window as any).__SHARE_PRELOAD__;
});

test("a preloaded shared doc paints from the inlined payload with every query missing", async () => {
  const now = Date.now();
  (window as any).__SHARE_PRELOAD__ = {
    kind: "doc",
    token: TOKEN,
    now,
    data: {
      title: "Launch notes",
      doc_type: "note",
      content: "# Launch notes\n\nShip the importer on Thursday.",
      user: { name: "Dana Viewer" },
      created_at: now - 86_400_000,
      updated_at: now - 86_400_000,
      entries: [],
    },
  };
  const page = await mountShare();
  try {
    expect(describeFailures(page)).toBe("");
    expect(page.text()).toContain("Launch notes");
    expect(page.text()).toContain("Ship the importer on Thursday.");
    expect(backend.refused.size).toBeGreaterThan(0);
  } finally {
    await page.unmount();
  }
}, 120_000);

test("a shared doc with no preload says the server did not answer, not that the link is closed", async () => {
  const page = await mountShare();
  try {
    expect(describeFailures(page)).toBe("");
    const text = page.text();
    expect(text).toContain("This doc could not be loaded");
    expect(text).not.toContain("This link is closed");
    expect([...page.container.querySelectorAll("button")].some((b) => b.textContent === "Try again")).toBe(true);
  } finally {
    await page.unmount();
  }
}, 120_000);

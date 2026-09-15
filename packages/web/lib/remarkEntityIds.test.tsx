import { test, expect, describe, mock } from "bun:test";

// DocEmbed resolves docs through convex/react's useQuery; tests run without a
// Convex connection, so the hook is replaced before the component graph loads.
// Any non-skip doc query resolves to FAKE_DOC.
const FAKE_DOC_ID = "s97cj9d9n7vrjs2jaan05q4tyx8avxjs";
const FAKE_DOC = {
  _id: FAKE_DOC_ID,
  title: "Retro Notes",
  doc_type: "note",
  content: "The **workout circuit** was great.\n\n- bring clothes\n- takeout for dinner",
  updated_at: Date.now(),
};

// Keep every other export real: replacing the whole module drops names the
// component graph imports statically (EntityIdPill → useQueryNoThrow →
// useQueries), and a missing named export is a link-time SyntaxError, not a
// call-time one. Only the hooks that need a live client are overridden — and
// the override leaks to any file sharing this test process, so a module-shaped
// mock keeps those files working too.
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: (_fn: unknown, args: unknown) => (args === "skip" ? undefined : FAKE_DOC),
  // useQueryNoThrow's transport. No subscription resolves here, which is the
  // honest answer for resolveIdType without a backend: the pill falls back to
  // its plain-text rendering, exactly as it does when the query is in flight.
  useQueries: () => ({}),
}));

// The real next/link compat shim calls react-router's useNavigate, which
// requires a <Router> — irrelevant to what these tests assert.
mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router");
const { default: ReactMarkdown } = await import("react-markdown");
const { entityRemarkPlugins } = await import("./remarkEntityIds");
const { EntityAwareLink, EntityAwareCode } = await import("../components/EntityIdPill");
const { JSDOM } = await import("jsdom");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { replaceGlobals } = await import("../test-helpers/globals");
const { useInboxStore } = await import("../store/inboxStore");
const { leavesOf } = await import("../store/stageSplit");

const MD_COMPONENTS = { a: EntityAwareLink, code: EntityAwareCode } as const;

// The pill resolves its open gesture via router hooks (useOpenLinkedSession),
// so rendering needs a Router around it — same as every real surface.
function render(markdown: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={MD_COMPONENTS as any}>
        {markdown}
      </ReactMarkdown>
    </MemoryRouter>,
  );
}

describe("authored local file links", () => {
  test("the reported browser instructions link renders through FilePathLink", () => {
    const html = render("[browser instructions](/Users/ashot/.codex/AGENTS.md:1042)");
    expect(html).toContain('href="/files?path=%2FUsers%2Fashot%2F.codex%2FAGENTS.md&amp;l=1042"');
    expect(html).toContain('class="fs-link"');
    expect(html).toContain('title="Open /Users/ashot/.codex/AGENTS.md in Files"');
    expect(html).toContain('>browser instructions</a>');
  });

  test("angle-bracket and encoded space destinations keep the path and label", () => {
    for (const destination of ["</Users/ashot/My Project/My Report.md:3>", "/Users/ashot/My%20Project/My%20Report.md:3"]) {
      const html = render(`[My Report](${destination})`);
      expect(html).toContain('href="/files?path=%2FUsers%2Fashot%2FMy+Project%2FMy+Report.md&amp;l=3"');
      expect(html).toContain('>My Report</a>');
    }
  });

  test("remote links retain their URL and external-link behavior", () => {
    const html = render("[instructions](https://example.com/Users/ashot/AGENTS.md:1042)");
    expect(html).toContain('href="https://example.com/Users/ashot/AGENTS.md:1042"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('class="fs-link"');
  });

  test("clicking the reported link opens Files beside the conversation with its line", async () => {
    const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://codecast.test/conversation/jx707h3" });
    const restore = replaceGlobals({
      window: Object.assign(dom.window, { innerWidth: 1400 }),
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const { tabs, activeTabId } = useInboxStore.getState();
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    try {
      useInboxStore.setState({ tabs: [{ id: "file-link-test", title: "Conversation", path: "/conversation/jx707h3", createdAt: 0 }], activeTabId: "file-link-test" });
      await act(() => root.render(
        <MemoryRouter>
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={MD_COMPONENTS}>
            {"[browser instructions](/Users/ashot/.codex/AGENTS.md:1042)"}
          </ReactMarkdown>
        </MemoryRouter>,
      ));
      await act(() => container.querySelector<HTMLAnchorElement>("a")!.click());
      expect(leavesOf(useInboxStore.getState().tabs[0].layout!).map((leaf) => leaf.path)).toEqual([
        "/conversation/jx707h3",
        "/files?path=%2FUsers%2Fashot%2F.codex%2FAGENTS.md&l=1042",
      ]);
    } finally {
      await act(() => root.unmount());
      useInboxStore.setState({ tabs, activeTabId });
      restore();
      dom.window.close();
    }
  }, 15_000);
});

describe("doc transclusion (![[doc:…]])", () => {
  test("standalone embed renders the doc body in full", () => {
    const html = render(`Here is the note:\n\n![[doc:${FAKE_DOC_ID}]]\n\nThat is all.`);
    expect(html).toContain("Retro Notes");
    // The doc's own markdown is rendered (bold → <strong>), not shown as raw text.
    expect(html).toMatch(/<strong[^>]*>workout circuit<\/strong>/);
    expect(html).toContain("takeout for dinner");
    // Header links to the doc.
    expect(html).toContain(`/docs/${FAKE_DOC_ID}`);
  });

  test("standalone embed is hoisted out of its paragraph", () => {
    const html = render(`![[doc:${FAKE_DOC_ID}]]`);
    // The embed card must render at block level — never inside a <p>.
    expect(html).not.toMatch(/<p[^>]*>\s*<span[^>]*data-doc-embed/);
    expect(html).toContain("data-doc-embed");
  });

  test("embed body blocks are direct children of the quote-units container", () => {
    const html = render(`![[doc:${FAKE_DOC_ID}]]`);
    // lib/quoteUnits descends into [data-doc-embed-body] and enumerates its
    // direct children as quotable units — the doc's <p>/<ul> must sit
    // immediately inside it, with no intermediate wrapper.
    expect(html).toMatch(/data-doc-embed-body[^>]*><p>/);
  });

  test("inline embed mid-sentence demotes to a pill, not a full card", () => {
    const html = render(`An inline ![[doc:${FAKE_DOC_ID}]] reference.`);
    // Pill label renders the resolved title; the doc BODY must not appear.
    expect(html).toContain("Retro Notes");
    expect(html).not.toContain("workout circuit");
  });

  test("non-doc and malformed ids never produce an embed card", () => {
    const short = render("![[doc:abc123]]");
    expect(short).toContain("![[");
    expect(short).not.toContain("border-sol-green/25");
    // ct- ids aren't embeddable: the ![[ ]] stays literal (the id itself still
    // pills via the pre-existing bare-id rule, which is fine).
    const task = render("![[ct-12345]]");
    expect(task).not.toContain("border-sol-green/25");
    expect(task).toContain("![[");
  });

  test("recursive embeds terminate via the depth cap", () => {
    // FAKE_DOC embeds itself: every doc query returns FAKE_DOC, so without the
    // depth cap this recurses forever and the test never completes.
    const selfRef = { ...FAKE_DOC, content: `self:\n\n![[doc:${FAKE_DOC_ID}]]` };
    mock.module("convex/react", () => ({
      useQuery: (_fn: unknown, args: unknown) => (args === "skip" ? undefined : selfRef),
    }));
    const html = render(`![[doc:${FAKE_DOC_ID}]]`);
    expect(html).toContain("self:");
    // Restore the default mock for any later tests.
    mock.module("convex/react", () => ({
      useQuery: (_fn: unknown, args: unknown) => (args === "skip" ? undefined : FAKE_DOC),
    }));
  });

  test("plain doc: references still render as pills (no regression)", () => {
    const html = render(`See doc:${FAKE_DOC_ID} for details.`);
    expect(html).toContain("Retro Notes");
    expect(html).not.toContain("workout circuit");
  });
});

// The doc editor serializes a date pill as `@[<label> date:<iso>]`
// (DateMentionExtension markdown storage / convex docSync toMarkdown). Read
// mode must render that form back as the same pill — before this, the form
// didn't exist and dates were silently wiped from doc.content.
describe("date mention pills (@[label date:iso])", () => {
  test("renders a date pill with the label and resolved weekday", () => {
    const html = render("Kickoff @[Aug 24, 2026 date:2026-08-24] sharp.");
    expect(html).toContain("Aug 24, 2026");
    // Resolved display derived from the ISO date, not the label.
    expect(html).toContain("Mon, Aug 24");
    // The raw serialized form never reaches the reader.
    expect(html).not.toContain("date:2026-08-24");
  });

  test("a malformed date id falls through to the mention fallback, not a crash", () => {
    const html = render("See @[Someday date:not-a-date].");
    expect(html).not.toContain("Mon,");
  });
});

describe("authored conversation message deep links", () => {
  const CONV = "jx84qtvpbmmrmwcjqmhzawejsx8bq9gm";
  const MSG = "kx82qtvpbmmrmwcjqmhzawejsx8bq9gm";
  const href = `https://codecast.sh/conversation/${CONV}#msg-${MSG}`;

  test("custom link text stays the words and keeps the message hash", () => {
    const html = render(`[See the conversation](${href})`);
    expect(html).toContain("See the conversation");
    expect(html).toContain(`href="/conversation/${CONV}#msg-${MSG}"`);
    // Not a session pill — those drop the hash and open the conversation, not the message.
    expect(html).not.toContain("entity-ref");
  });

  test("clicking the link on a thread jumps to the message", async () => {
    const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: `https://codecast.test/inbox?s=${CONV}` });
    const restore = replaceGlobals({
      window: Object.assign(dom.window, { innerWidth: 1400 }),
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const { pendingNavigateId, pendingScrollToMessageId } = useInboxStore.getState();
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    try {
      await act(() => root.render(
        <MemoryRouter>
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={MD_COMPONENTS}>
            {`[See the conversation](${href})`}
          </ReactMarkdown>
        </MemoryRouter>,
      ));
      await act(() => container.querySelector<HTMLAnchorElement>("a")!.click());
      const s = useInboxStore.getState();
      expect(s.pendingNavigateId).toBe(CONV);
      expect(s.pendingScrollToMessageId).toBe(MSG);
    } finally {
      await act(() => root.unmount());
      useInboxStore.setState({ pendingNavigateId, pendingScrollToMessageId });
      restore();
      dom.window.close();
    }
  }, 15_000);
});

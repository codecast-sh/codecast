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
const { default: ReactMarkdown } = await import("react-markdown");
const { entityRemarkPlugins } = await import("./remarkEntityIds");
const { EntityAwareLink, EntityAwareCode } = await import("../components/EntityIdPill");

const MD_COMPONENTS = { a: EntityAwareLink, code: EntityAwareCode } as const;

function render(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={MD_COMPONENTS as any}>
      {markdown}
    </ReactMarkdown>,
  );
}

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

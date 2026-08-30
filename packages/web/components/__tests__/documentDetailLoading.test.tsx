import { describe, expect, test, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The read-mode body has three empty-content states that must not be confused:
// still-loading (detail not synced → loader), genuinely empty (the "Empty
// document" affordance), and loaded content (the review blocks). The regression
// with teeth: a doc opened from the list has NO content until the detail query
// returns (webListPaginated strips it), and that window used to render as a
// blank body with no loading state.

// The layout's chrome pulls in router, store, and Convex-backed children that
// can't SSR outside the app — stub them; the branch under test is the layout's
// own.
mock.module("next/link", () => ({
  default: ({ href, children }: any) => <a href={String(href)}>{children}</a>,
}));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/docs/doc1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
mock.module("../ContextChatInput", () => ({
  ContextChatInput: () => <div data-stub="chat-input" />,
}));
mock.module("../MessageReview", () => ({
  MessageReview: ({ content }: { content: string }) => (
    <div data-stub="message-review">{content}</div>
  ),
}));
mock.module("../DocReviewBar", () => ({
  DocReviewBar: () => <div data-stub="review-bar" />,
}));
mock.module("../workspace/Slot", () => ({
  SlotActions: () => null,
}));
mock.module("../editor/CollabDocEditor", () => ({
  CollabDocEditor: () => <div data-stub="collab-editor" />,
}));
// Spread, not replaced: `mock.module` is process-global, and a sibling test
// imports `matchScore` off this module.
const realMentions = { ...(await import("../../hooks/useMentionQuery")) };
mock.module("../../hooks/useMentionQuery", () => ({
  ...realMentions,
  useMentionQuery: () => () => [],
  useActiveMentionScope: () => null,
}));
mock.module("../../hooks/useImageUpload", () => ({
  useImageUpload: () => async () => "",
}));
mock.module("../../hooks/useTitlebarHead", () => ({
  useTitlebarHead: () => ({ current: null }),
}));
const { mockInboxStore } = await import("./mockInboxStore");
mockInboxStore(() => ({ reviewComments: {} }));

const { DocumentDetailLayout } = await import("../DocumentDetailLayout");

function render(props: Partial<Parameters<typeof DocumentDetailLayout>[0]>) {
  return renderToStaticMarkup(
    <DocumentDetailLayout
      docId="doc1"
      title="My Doc"
      markdownContent=""
      onTitleChange={() => {}}
      backHref="/docs"
      {...props}
    />,
  );
}

describe("DocumentDetailLayout body modes", () => {
  test("editable docs mount the collab editor by default (edit-first)", () => {
    const html = render({ markdownContent: "## The idea", contentReady: true });
    expect(html).toContain('data-stub="collab-editor"');
    expect(html).not.toContain('data-stub="message-review"');
  });

  // The review body's three empty-content states (opted out of edit mode).
  test("review: content not yet synced → loader, never a blank or 'empty' body", () => {
    const html = render({ markdownContent: "", contentReady: false, defaultEditing: false });
    expect(html).toContain("app-loader-bar");
    expect(html).not.toContain("Empty document");
  });

  test("review: confirmed-empty doc → the empty-document affordance, no loader", () => {
    const html = render({ markdownContent: "", contentReady: true, defaultEditing: false });
    expect(html).toContain("Empty document");
    expect(html).not.toContain("app-loader-bar");
  });

  test("review: loaded content renders through the review blocks", () => {
    const html = render({
      markdownContent: "## The idea",
      contentReady: true,
      defaultEditing: false,
    });
    expect(html).toContain("The idea");
    expect(html).not.toContain("app-loader-bar");
    expect(html).not.toContain("Empty document");
  });
});

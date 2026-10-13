import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBlocks } from "../tools/MarkdownRenderer";
import { InlineDiff, MessageIdentityProvider } from "../InlineDiff";
import { fileDiffRenders } from "../../test-helpers/pierreFileDiff";

// End-to-end render of the message pipeline: markdown body → pre-override fence
// dispatch → InlineDiff → DiffView, asserted on the emitted HTML and on what
// DiffView asked Pierre to draw (test-helpers/pierreFileDiff.tsx stands in for
// Pierre's shadow DOM, which only a browser renders).

const DIFF = [
  "diff --git a/New note.md b/New note.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/New note.md\t",
  "@@ -0,0 +1,2 @@",
  "+# A new note",
  "+Body of the new note.",
  "diff --git a/Old note.md b/Old note.md",
  "index 06743cb..0c2f463 100644",
  "--- a/Old note.md\t",
  "+++ b/Old note.md\t",
  "@@ -1,20 +1,20 @@",
  ...Array.from({ length: 9 }, (_, i) => ` filler line ${i + 1}`),
  "-old line ten",
  "+new line ten",
  ...Array.from({ length: 10 }, (_, i) => ` filler line ${i + 11}`),
].join("\n");

const MEMO = ["# Memo", "", "Intro prose.", "", "````cast-diff", DIFF, "````", "", "Closing prose."].join("\n");

describe("inline diff rendering", () => {
  test("a cast-diff fence in a message body renders file cards, not a code block", () => {
    const html = renderToStaticMarkup(<MarkdownBlocks content={MEMO} />);
    expect(html).toContain("New note.md");
    expect(html).toContain("Old note.md");
    expect(html).toContain('data-line-type="change-addition"');
    expect(html).toContain('data-line-type="change-deletion"');
    // Status badges: A for the new file, M for the modified one
    expect(html).toContain(">A</span>");
    expect(html).toContain(">M</span>");
    // Surrounding prose still renders as markdown
    expect(html).toContain("Intro prose.");
    // The fence did NOT fall through to a plain code block
    expect(html).not.toContain("language-cast-diff");
  });

  test("modified file collapses to context: far-away filler is hidden", () => {
    const html = renderToStaticMarkup(<InlineDiff raw={DIFF} />);
    expect(html).toContain("filler line 9"); // within 3 lines of the change
    expect(html).not.toContain("filler line 20"); // far from the change — collapsed
    expect(html).toContain("expand all");
  });

  test("without MessageIdentity the diff is inert; with it, every file offers line comments", () => {
    fileDiffRenders.length = 0;
    renderToStaticMarkup(<InlineDiff raw={DIFF} />);
    expect(fileDiffRenders.map((r) => !!r.options?.enableGutterUtility)).toEqual([false, false]);
    fileDiffRenders.length = 0;
    renderToStaticMarkup(
      <MessageIdentityProvider conversationId="conv1" messageId="msg1">
        <InlineDiff raw={DIFF} />
      </MessageIdentityProvider>,
    );
    expect(fileDiffRenders.map((r) => !!r.options?.enableGutterUtility)).toEqual([true, true]);
  });

  test("a whole-file diff can open its unchanged lines; the header expands them all", () => {
    fileDiffRenders.length = 0;
    renderToStaticMarkup(<InlineDiff raw={DIFF} />);
    const modified = fileDiffRenders.find((r) => !r.fileDiff.isPartial && r.fileDiff.type === "change")!;
    expect(modified.options?.hunkSeparators).toBe("line-info");
    expect(modified.options?.expandUnchanged).toBe(false);
  });

  test("non-diff fence content falls back to a plain code block", () => {
    const html = renderToStaticMarkup(<InlineDiff raw={"not a diff at all"} />);
    expect(html).not.toContain("diffs-container");
  });
});

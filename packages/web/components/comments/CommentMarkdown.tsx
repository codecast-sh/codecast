import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { MarkdownImageSize } from "../../lib/markdownImageSize";

// Rich comment body — the SAME markdown codepath the conversation transcript uses
// (entity pills, mentions, fenced code with syntax highlighting, GFM tables,
// images). The `cc-cmt-md` class just tightens the prose spacing for the narrow
// rail. An image someone attached is the point of their comment, so it shows
// whole rather than cut to the transcript's preview height.
export function CommentMarkdown({ content }: { content: string }) {
  return (
    <MarkdownImageSize.Provider value="whole">
      <MarkdownRenderer content={content} className="cc-cmt-md" />
    </MarkdownImageSize.Provider>
  );
}

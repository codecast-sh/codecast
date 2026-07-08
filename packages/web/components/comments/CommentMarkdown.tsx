import { MarkdownRenderer } from "../tools/MarkdownRenderer";

// Rich comment body — the SAME markdown codepath the conversation transcript uses
// (entity pills, mentions, fenced code with syntax highlighting, GFM tables,
// collapsible images). The `cc-cmt-md` class just tightens the prose spacing for
// the narrow rail; everything else is identical to a message body, so a comment
// and the message it's about render with one visual language.
export function CommentMarkdown({ content }: { content: string }) {
  return <MarkdownRenderer content={content} className="cc-cmt-md" />;
}

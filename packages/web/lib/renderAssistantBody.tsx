import { parseInsightBlocks } from "../components/insightBlocks";
import { MessageMarkdown, InsightCard } from "../components/conversation/markdown";

// Renders an assistant message body as a flat run of block elements: ★ Insight
// fences become InsightCards, everything else is markdown, emitted as a FRAGMENT
// (no wrapper) so each block stays a DIRECT child of MessageReview's .cc-content
// and remains independently hover-quotable — a wrapper div would collapse the
// whole message into one un-quotable block. Module-level const so MessageReview's
// memo holds (a fresh inline arrow at the call site would defeat it).
export const renderAssistantBody = (content: string) => {
  const parts = parseInsightBlocks(content);
  if (!parts.some((p) => p.type === "insight")) return <MessageMarkdown content={content} />;
  return (
    <>
      {parts.map((part, i) =>
        part.type === "insight" ? (
          <InsightCard key={i} label={part.label} content={part.content} />
        ) : (
          <MessageMarkdown key={i} content={part.content} />
        ),
      )}
    </>
  );
};

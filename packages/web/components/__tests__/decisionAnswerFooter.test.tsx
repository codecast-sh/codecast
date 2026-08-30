import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { DecisionAnswerFooter } from "../DecisionAnswerFooter";

// The strip under a `cast decide` answer bubble. It must render from the
// message alone (id + question ride the wire) so an answer older than the
// queue's day-long window still reads against its ask. (Static render reads
// the store's initial snapshot, so the live-row preference is not testable here.)
const client = new ConvexReactClient("https://example.convex.cloud");
const render = (el: React.ReactElement) => renderToStaticMarkup(<ConvexProvider client={client}>{el}</ConvexProvider>);
const CONV = "conv1234567890123456789012345678";

describe("DecisionAnswerFooter", () => {
  test("closed strip names the decision, its question and the way back to the ask", () => {
    useInboxStore.setState({ sessionDecisions: {} } as any);
    const html = render(
      <DecisionAnswerFooter decision={{ id: "d1", question: "Keep the engine vendored?", answer: "Keep vendored" }} conversationId={CONV} />,
    );
    expect(html).toContain("decision");
    expect(html).toContain("Keep the engine vendored?");
    expect(html).toContain("the ask");
    expect(html).toContain('aria-expanded="false"');
    // Options only unfold on demand.
    expect(html).not.toContain("Keep vendored");
  });
});

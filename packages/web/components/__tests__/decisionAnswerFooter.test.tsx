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

  test("a legacy answer (no id or question on the wire) still renders the strip", () => {
    // Static render can't see setState (zustand serves the initial snapshot
    // on the server), so the row lookup itself is covered by the shared
    // pickAnsweredDecision tests; here the strip must stand on the wire
    // alone: placeholder question, the way back to the ask, no crash.
    useInboxStore.setState({ sessionDecisions: {} } as any);
    const html = render(
      <DecisionAnswerFooter decision={{ id: "", answer: "Hold" }} conversationId={CONV} timestamp={5_100} />,
    );
    expect(html).toContain("decision");
    expect(html).toContain("the agent&#x27;s question");
    expect(html).toContain("the ask");
  });
});

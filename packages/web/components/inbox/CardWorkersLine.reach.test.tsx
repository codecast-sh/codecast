import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboxSession } from "../../store/inboxStore";
import { CardWorkersLine } from "./SessionCardParts";

// ct-101636: with the global Subagents option off, a card's "N workers" line
// must itself be the way to reach that one session's workers. Today the count
// is plain text whose tooltip sends the person to the global option, which
// lists every subagent in the sidebar (382 rows in rp-25836).

const html = (count: number, needsYou: InboxSession[] = []) =>
  renderToStaticMarkup(<CardWorkersLine count={count} needsYou={needsYou} onOpen={() => {}} />);

describe("CardWorkersLine reaches this card's workers without the global option", () => {
  test("the worker count is a pressable control", () => {
    const out = html(3);
    expect(out).toMatch(/<button[^>]*>[^<]*3 workers[^<]*<\/button>/);
  });

  test("it does not send the person to the global Sub-agents option", () => {
    expect(html(3)).not.toContain("View options › Sub-agents");
  });
});

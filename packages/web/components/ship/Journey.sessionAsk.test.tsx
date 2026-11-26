import { describe, expect, mock, test } from "bun:test";

// A run whose session asks a person (ct-99051): the bar says whom it waits on and the question, with the way to answer
// right there; never a stop, never Ship again.

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));
const targetsHook = { ...(await import("../../hooks/useSyncDeployTargets")) };
mock.module("../../hooks/useSyncDeployTargets", () => ({ ...targetsHook, useDeployTargets: () => ({ targets: [], deploys: [], ready: true }) }));
const pressHook = { ...(await import("../../hooks/useDeployPress")) };
mock.module("../../hooks/useDeployPress", () => ({ ...pressHook, useDeployPress: () => ({ open() {}, review: null }) }));
const detailHook = { ...(await import("../../hooks/useSyncDecisionDetail")) };
mock.module("../../hooks/useSyncDecisionDetail", () => ({ ...detailHook, useSyncDecisionDetail: () => ({ ready: true, missing: false }) }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { JourneyNowBar } = await import("./Journey");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const now = (over: object) => ({ kind: "session", stage: "CI + Review", note: "Waiting for Jason: keep the old flag?", since: null, round: 1, max: 3, by: null, blocked: true, ask: null, conversation: "conv1", ...over }) as any;
const draw = (n: any) => renderToStaticMarkup(<JourneyNowBar now={n} run={{ _id: "run1", status: "running" }} now_ms={0} again={() => <button data-again>Ship again</button>} />);
const ask = { id: "d1", short_id: "sd-7", question: "Keep the old flag?", mine: true, open: true };

describe("the bar of a run whose session asks a person", () => {
  test("the viewer's own card: Waiting on you, the question, and the card to answer in place", () => {
    const html = draw(now({ ask }));
    expect(text(html)).toContain("Waiting on you Keep the old flag?");
    expect(html).toContain('data-kind="you"');
    expect(html).toContain('data-run-gate="d1"');
    // The session's own words stay beside the card: a card can be about something else.
    expect(text(html)).toContain("Waiting for Jason: keep the old flag?");
    expect(html).not.toContain("data-again");
    expect(text(html)).not.toMatch(/Failed|Stopped/);
  });
  test("someone else's card: waiting for a person, and the card a press away", () => {
    const html = draw(now({ ask: { ...ask, mine: false } }));
    expect(text(html)).toContain("Waiting for a person Keep the old flag?");
    expect(html).toContain('href="/decisions/sd-7"');
    expect(html).not.toContain("data-run-gate");
  });
  test("an ask in words only: the pin, and the session where it is answered", () => {
    const html = draw(now({}));
    expect(text(html)).toContain("Waiting for a person");
    expect(text(html)).toContain("Waiting for Jason: keep the old flag?");
    expect(html).toContain('href="/conversation/conv1"');
    expect(html).not.toContain("data-again");
  });
  test("back at work, the session fixes as before", () => {
    expect(text(draw(now({ blocked: false })))).toContain("CI + Review sent it back this session is fixing it · round 1 of 3");
  });
});

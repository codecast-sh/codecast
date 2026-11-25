// ct-101350: Answer on a team feed row must land on what waits on the person.
// A bare /conversation/<id> opens the session at its default position with
// nothing marking the ask, so the person has to hunt for it. These cases read
// the href the rendered Answer button carries.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ActivityActions } from "./ActivityRow";
import { NO_OUTCOMES, type ActivityDecision, type ActivityItem } from "./activityModel";

const CONV = "jx7br5kkjfn7332zsx1cdh4p058jxd12";

function item(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: CONV, title: "Session", line: "", reason: null, status: "idle",
    actor: { id: "u1", name: "Me" } as ActivityItem["actor"], project: null, at: 0,
    isOwn: false, hiddenFromTeam: false, needs: true, outcomes: NO_OUTCOMES,
    conv: { _id: CONV } as unknown as ActivityItem["conv"], sig: "",
    ...over,
  };
}

function decision(over: Partial<ActivityDecision>): ActivityDecision {
  return { id: "kd7decisionid000000000000000001", shortId: null, question: "Ship it?", pending: true, askedOfViewer: true, at: 1, ...over };
}

function hrefOf(it: ActivityItem, action: "answer" | "open" = "answer"): string | null {
  const html = renderToStaticMarkup(<MemoryRouter><ActivityActions item={it} /></MemoryRouter>);
  const doc = new (require("jsdom").JSDOM)(html).window.document;
  return doc.querySelector(`[data-activity-action='${action}']`)?.getAttribute("href") ?? null;
}

describe("Answer lands on the ask", () => {
  test("a pending decision with a short id links to its decision page (kept)", () => {
    expect(hrefOf(item({ outcomes: { ...NO_OUTCOMES, decisions: [decision({ shortId: "sd-7" })] } }))).toBe("/decisions/sd-7");
  });

  test("a pending decision WITHOUT a short id never links to the bare conversation", () => {
    const href = hrefOf(item({ outcomes: { ...NO_OUTCOMES, decisions: [decision({ shortId: null })] } }));
    expect(href).not.toBeNull();
    expect(href).not.toBe(`/conversation/${CONV}`);
  });

  test("the viewer's own needs_you session marks the waiting message, not the bare conversation", () => {
    const href = hrefOf(item({ isOwn: true, status: "needs_you" }));
    expect(href).not.toBeNull();
    expect(href).not.toBe(`/conversation/${CONV}`);
    expect(href!.startsWith(`/conversation/${CONV}`)).toBe(true);
  });

  test("Open still opens the bare conversation (kept)", () => {
    expect(hrefOf(item({ isOwn: true, status: "needs_you" }), "open")).toBe(`/conversation/${CONV}`);
  });
});

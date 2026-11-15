import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { JSDOM } from "jsdom";
import { FlowLoop } from "../FlowLoop";
import type { FlowLoop as Loop } from "../../../../../../lib/line/flowLoop";

const loop: Loop = {
  rules: { sources: { feeds: 3, silent: 0, unfiled: 0 }, owners: { roles: 1, projects: 1 }, skills: { prompts: 4 }, gates: { checks: 2, people: 1 }, autonomy: { merging: 0, roles: 1 } },
  signals: { today: 42, top: [] },
  problems: { open: 17, queued: 5 },
  person: { running: 1, waiting: 0 },
  line: { running: 3, waiting: 2, stalled: 4 },
  checks: [{ slug: "review", label: "Review", person: false, at: 2, waiting: 0 }, { slug: "decide", label: "Decide", person: true, at: 1, waiting: 1 }],
  ship: { landing: 0, going: 0, liveToday: 0, failedToday: 0, watching: 6 },
  back: { regressed: 0, reopened: 0 },
  decisions: { you: 1, team: 0 },
};

const html = renderToStaticMarkup(
  <MemoryRouter><FlowLoop loop={loop} rates={null} href={(p) => `/flows?view=${p.view ?? ""}${p.activity ? `&activity=${p.activity}` : ""}`} select={() => {}} liveKey={null} onRuns={() => {}} /></MemoryRouter>,
);
const doc = new JSDOM(html).window.document;

describe("the Loop view's stage strip", () => {
  test("each stage is a link carrying the count it opens, repeating the number drawn below", () => {
    const stages = [...doc.querySelectorAll("[data-loop-stage]")].map((a) => [a.getAttribute("data-loop-stage"), a.querySelector("b")?.textContent, a.getAttribute("href")]);
    expect(stages).toEqual([
      ["Signals", "42", "/flows?view=signals"],
      ["Triage", "17", "/flows?view=problems"],
      ["Build", "9", "/flows?view=line"],
      ["Checks", "3", "/flows?view=line&activity=check"],
      ["Ship and watch", "6", "/flows?view=shipped"],
    ]);
    expect(doc.querySelector(".lp-signals .lp-box-head b")?.textContent).toBe("42");
  });

  test("stalled opens the runs it counts, the filter in its address", () => {
    const stalled = [...doc.querySelectorAll("a.lp-fig")].find((a) => a.textContent?.includes("stalled"));
    expect(stalled?.getAttribute("href")).toBe("/flows?view=line&activity=stalled");
  });
});

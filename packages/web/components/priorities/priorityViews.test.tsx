// The pinned-state line drawn as a reader gets it.
// Run: bun test components/priorities/priorityViews.test.tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { PriorityPinLineView } from "./PriorityPinLine";
import { priorityHref } from "../../lib/priorities";

const pin = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

describe("PriorityPinLineView", () => {
  test("names the priority, its critical path and this session's step, and opens it", () => {
    const html = pin(
      <PriorityPinLineView line={{ short_id: "pri-4", title: "Trusted evals", rank: 1, critical_done: 3, critical_total: 6, step_title: "Grader faults under 10%" }} />,
    );
    expect(html).toContain(`href="${priorityHref("pri-4")}"`);
    expect(priorityHref("pri-4")).toBe("/priorities/pri-4");
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toBe("↳#1 Trusted evals · 3/6 · Grader faults under 10%");
  });

  test("an unranked priority with no step says only what it knows", () => {
    const text = pin(<PriorityPinLineView line={{ short_id: "pri-4", title: "Trusted evals", rank: null, critical_done: 0, critical_total: 2 }} />).replace(/<[^>]+>/g, "");
    expect(text).toBe("↳Trusted evals · 0/2");
  });

  test("renders nothing when the session maps to no priority", () => {
    expect(pin(<PriorityPinLineView line={null} />)).toBe("");
  });
});

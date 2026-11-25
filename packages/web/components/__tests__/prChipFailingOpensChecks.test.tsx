import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { LinkedPrChips } from "../PrStatusChip";
import type { LinkedPr } from "../../lib/sessionPullRequests";

// A pull request pill that says "failing" is an invitation to look at the
// failing checks, and the Checks tab is where they and "Send all failing"
// live. The pill opens the pull request there, not on its Conversation tab.
// A pill whose checks are fine keeps opening the pull request itself.

const pr = (over: Partial<LinkedPr>): LinkedPr => ({
  id: "pr1", repository: "acme/app", number: 6106, state: "open", ci: "failure", tier: "committed", title: "Fix it", ...over,
});

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

test("a failing PR pill opens the pull request on its Checks tab", () => {
  const html = renderToStaticMarkup(<MemoryRouter><LinkedPrChips prs={[pr({})]} /></MemoryRouter>);
  expect(html).toContain('data-pr-state="failing"');
  expect(hrefs(html)).toEqual(["/pr/acme/app/6106/checks"]);
});

test("a PR pill with passing checks opens the pull request itself", () => {
  const html = renderToStaticMarkup(<MemoryRouter><LinkedPrChips prs={[pr({ id: "pr2", number: 7, ci: "success" })]} /></MemoryRouter>);
  expect(hrefs(html)).toEqual(["/pr/acme/app/7"]);
});

import { describe, expect, mock, test } from "bun:test";

// An inbox card's ship word links into /deploys: a word naming a deploy opens that
// deploy, one about a commit the run landed opens the run's team's Deploys page at
// that commit, and a word with neither stays plain text.

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { SessionShipChip } = await import("./SessionShipChip");

const hrefs = (html: string) => [...html.replace(/&amp;/g, "&").matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("the session ship chip's link into Deploys", () => {
  test("a word naming a deploy opens that deploy", () => {
    const html = renderToStaticMarkup(<SessionShipChip ship={{ words: "Live in dp-12", tone: "ok", deploy: "dp-12", sha: "abc1234", team: "T1" }} />);
    expect(hrefs(html)).toEqual(["/deploys?deploy=dp-12"]);
  });

  test("a word about a landed commit, with no deploy, opens the team's Deploys page at the commit", () => {
    const html = renderToStaticMarkup(<SessionShipChip ship={{ words: "Merged", tone: "ok", sha: "ABC1234", team: "T1" }} />);
    expect(hrefs(html)).toEqual(["/deploys?team=T1&sha=abc1234"]);
  });

  test("a word with neither a deploy nor a commit is a plain span", () => {
    const html = renderToStaticMarkup(<SessionShipChip ship={{ words: "In review", tone: "working" }} />);
    expect(hrefs(html)).toEqual([]);
    expect(html).toStartWith("<span");
    expect(html).toContain("In review");
  });
});

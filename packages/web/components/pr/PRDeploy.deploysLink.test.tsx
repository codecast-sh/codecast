import { describe, expect, mock, test } from "bun:test";

// The PR page's Production band and its "ships to" list link each target into
// /deploys. A merged PR's link names the PR, so the page opens at that target
// with the deploy that took it highlighted; an open PR is on no target yet.

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { PRDeployBand, PRShipsTo } = await import("./PRDeploy");

const NOW = 1_800_000_000_000;
const base = { teamId: "T1", repository: "acme/app", number: 101, now: NOW, mergedAt: NOW - 3_600_000, press: { open() {}, review: null }, headline: null };
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*\/deploys[^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

describe("the PR page's links into Deploys", () => {
  test("a merged PR's band opens each target with the PR highlighted", () => {
    const model: any = {
      ...base, merged: true, open: false, shipsTo: null, declares: true,
      rows: [{ target: "web", state: "live", deploy: { short_id: "dp-12", status: "live", sha: "2a6e412abc", at: NOW - 60_000, url: null }, now: null, note: null, queue: null, press: null, pressWords: null, blocked: null }],
      dormant: [{ target: "cli", at: null }],
    };
    const links = hrefs(renderToStaticMarkup(<PRDeployBand model={model} />));
    expect(links).toEqual([
      "/deploys?team=T1&repo=acme%2Fapp&target=web&pr=101",
      // The deploy's own link (entityRoute) already names the deploy.
      "/deploys?deploy=dp-12",
      "/deploys?team=T1&repo=acme%2Fapp&target=web&pr=101",
      "/deploys?team=T1&repo=acme%2Fapp&target=cli&pr=101",
    ]);
  });

  test("an open PR's targets open on the Deploys page with nothing highlighted", () => {
    const model: any = {
      ...base, merged: false, open: true, declares: true, rows: [], dormant: [],
      shipsTo: [{ target: { _id: "t1", name: "web", runs: "here", policy: "auto" }, idle: false }],
    };
    expect(hrefs(renderToStaticMarkup(<PRShipsTo model={model} />))).toEqual(["/deploys?team=T1&repo=acme%2Fapp&target=web"]);
  });
});

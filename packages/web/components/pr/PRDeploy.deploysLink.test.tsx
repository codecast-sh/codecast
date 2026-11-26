import { describe, expect, mock, test } from "bun:test";

// The PR page's Production band and its "ships to" list link each target into
// /deploys, and so does the header chip. Every link names the PR: a merged one
// lands on its queue commit or the deploy that took it, an open one on its row
// in On its way.

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { PRDeployBand, PRReachChip, PRShipsTo } = await import("./PRDeploy");

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

  test("an open PR's targets open on the Deploys page with the PR highlighted on its way", () => {
    const model: any = {
      ...base, merged: false, open: true, declares: true, rows: [], dormant: [],
      shipsTo: [{ target: { _id: "t1", name: "web", runs: "here", policy: "auto" }, idle: false }],
    };
    expect(hrefs(renderToStaticMarkup(<PRShipsTo model={model} />))).toEqual(["/deploys?team=T1&repo=acme%2Fapp&target=web&pr=101"]);
  });

  test("the header chip opens the Deploys page at the PR, on the target the headline is about", () => {
    const Chip = ({ children }: any) => <span>{children}</span>;
    const model: any = {
      ...base, merged: true, open: false, shipsTo: null, declares: true, dormant: [],
      headline: { state: "waiting", words: "Not live yet on production" },
      rows: [{ target: "production", state: "waiting" }],
    };
    const html = renderToStaticMarkup(<PRReachChip model={model} Chip={Chip} />);
    expect(hrefs(html)).toEqual(["/deploys?team=T1&repo=acme%2Fapp&target=production&pr=101"]);
    expect(html).toContain("Not live yet on production");
  });

  test("a reader outside the team sees the chip but no link to a Deploys page they cannot open", () => {
    const Chip = ({ children }: any) => <span>{children}</span>;
    const model: any = { ...base, teamId: null, merged: true, open: false, shipsTo: null, declares: true, dormant: [], headline: { state: "live", words: "Live on web" }, rows: [{ target: "web", state: "live" }] };
    const html = renderToStaticMarkup(<PRReachChip model={model} Chip={Chip} />);
    expect(hrefs(html)).toEqual([]);
    expect(html).toContain("Live on web");
  });
});

import { describe, expect, mock, test } from "bun:test";

// The Ship panel links each target the session's change reaches, and its now-bar, into /deploys at that change: the
// commit the run landed when it has one, else the session; a now-bar line that names a deploy opens that deploy.

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));
const targetsHook = { ...(await import("../../hooks/useSyncDeployTargets")) };
mock.module("../../hooks/useSyncDeployTargets", () => ({ ...targetsHook, useDeployTargets: () => ({ targets: [], deploys: [], ready: true }) }));
const pressHook = { ...(await import("../../hooks/useDeployPress")) };
mock.module("../../hooks/useDeployPress", () => ({ ...pressHook, useDeployPress: () => ({ open() {}, review: null }) }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { JourneyView, SessionTargets } = await import("./Journey");

const SHA = "2a6e4120abcdef0123456789abcdef0123456789";
const links = (html: string) => [...html.replace(/&amp;/g, "&").matchAll(/href="(\/deploys[^"]*)"/g)].map((m) => m[1]);
const run = (extra: object) => ({ _id: "r1", status: "completed", workspace: "team:T1", spawner_conversation_id: "conv1", ...extra });

describe("the Ship panel's links into Deploys", () => {
  test("a landed run's targets and its Deploys button open at the commit it landed", () => {
    const journey: any = { stages: [], now: { kind: "landed", line: null, sha: SHA, at: null, hold: { kind: "wait", by: null }, waits: [] } };
    const html = renderToStaticMarkup(<JourneyView journey={journey} run={run({ merge: { sha: SHA } })} now_ms={0} targets={[{ name: "web", state: "waiting" }]} />);
    expect(links(html)).toEqual([`/deploys?team=T1&sha=${SHA}`, `/deploys?team=T1&target=web&sha=${SHA}`]);
  });

  test("a now-bar line that names a deploy opens that deploy, on its target when the line names one", () => {
    const deploying: any = { stages: [], now: { kind: "deploying", line: "waiting for web (going out in dp-13)", targets: ["web"], waits: [] } };
    expect(links(renderToStaticMarkup(<JourneyView journey={deploying} run={run({ status: "running" })} now_ms={0} />))[0]).toBe("/deploys?team=T1&deploy=dp-13");
    const live: any = { stages: [], now: { kind: "deploying", line: "live on web dp-12", targets: ["web"], waits: [] } };
    expect(links(renderToStaticMarkup(<JourneyView journey={live} run={run({ status: "running" })} now_ms={0} />))[0]).toBe("/deploys?team=T1&target=web&deploy=dp-12");
  });

  test("with no landed commit known, a target opens with the session highlighted", () => {
    const html = renderToStaticMarkup(<SessionTargets teamId="T1" conversationId="conv1" known={[{ name: "web", state: "live", deploy: "dp-12" }]} />);
    expect(links(html)).toEqual(["/deploys?team=T1&target=web&session=conv1"]);
  });
});

import { describe, expect, mock, test } from "bun:test";

// The Ship panel links each target the session's change reaches, and its now-bar, into /deploys at that change: the
// commit the run landed when it has one, else the session; a now-bar line that names a deploy opens that deploy.

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));
const targetsHook = { ...(await import("../../hooks/useSyncDeployTargets")) };
let deployState: { targets: any[]; deploys: any[] } = { targets: [], deploys: [] };
mock.module("../../hooks/useSyncDeployTargets", () => ({ ...targetsHook, useDeployTargets: () => ({ ...deployState, productions: [], ready: true }) }));
// A stop that says to resume the run draws its Resume press, which holds a mutation (Journey.resume.mount.test.tsx).
const convex = await import("convex/react");
mock.module("convex/react", () => ({ ...convex, useMutation: () => async () => ({}) }));
const pressHook = { ...(await import("../../hooks/useDeployPress")) };
mock.module("../../hooks/useDeployPress", () => ({ ...pressHook, useDeployPress: () => ({ open() {}, review: null }) }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { JourneyView, SessionTargets } = await import("./Journey");
const { journeyOf } = await import("../../lib/ship/journey");
const { appPool, flowBySlug } = await import("../../lib/line/flowPool");
const { end, replay } = await import("../../lib/ship/__tests__/replayReports");

const SHA = "2a6e4120abcdef0123456789abcdef0123456789";
const links = (html: string) => [...html.replace(/&amp;/g, "&").matchAll(/href="(\/deploys[^"]*)"/g)].map((m) => m[1]);
const run = (extra: object) => ({ _id: "r1", status: "completed", workspace: "team:T1", spawner_conversation_id: "conv1", ...extra });

describe("the Ship panel's links into Deploys", () => {
  test("a landed run's targets and its Deploys button open at the commit it landed", () => {
    const journey: any = { stages: [], now: { kind: "landed", line: null, sha: SHA, at: null, hold: { kind: "wait", by: null }, waits: [] } };
    const html = renderToStaticMarkup(<JourneyView journey={journey} run={run({ merge: { sha: SHA } })} now_ms={0} targets={[{ name: "web", state: "waiting" }]} />);
    expect(links(html)).toEqual([`/deploys?team=T1&sha=${SHA}`, `/deploys?team=T1&target=web&sha=${SHA}`]);
  });

  test("a now-bar line that names a deploy opens the run's change with that deploy open, on its target when the line names one", () => {
    const deploying: any = { stages: [], now: { kind: "deploying", line: "waiting for web (going out in dp-13)", targets: ["web"], waits: [] } };
    expect(links(renderToStaticMarkup(<JourneyView journey={deploying} run={run({ status: "running" })} now_ms={0} />))[0]).toBe("/deploys?team=T1&session=conv1&deploy=dp-13");
    const live: any = { stages: [], now: { kind: "deploying", line: "live on web dp-12", targets: ["web"], waits: [] } };
    expect(links(renderToStaticMarkup(<JourneyView journey={live} run={run({ status: "running" })} now_ms={0} />))[0]).toBe("/deploys?team=T1&target=web&session=conv1&deploy=dp-12");
  });

  test("a run whose Deploy deploys itself, with no deploy targets, offers no Deploys link", () => {
    const self: any = { stages: [], now: { kind: "deploying", line: "Running ./deploy.sh from 4a6e413", targets: [], waits: [] }, personal: true };
    const html = renderToStaticMarkup(<JourneyView journey={self} run={run({ status: "running", workspace: "user:u1" })} now_ms={0} />);
    expect(html).toContain("Deploying");
    expect(html).not.toContain("data-journey-deploys");
    expect(links(html)).toEqual([]);
    // Every other flow's Deploy opens Deploys as before, targets named or not.
    expect(renderToStaticMarkup(<JourneyView journey={{ ...self, personal: undefined }} run={run({ status: "running" })} now_ms={0} />)).toContain("data-journey-deploys");
  });

  test("a step left for the person opens the task it was posted to", () => {
    // The real runner's replayed reports of a run that ended Live with one step left (lib/ship/__tests__/replayReports.ts).
    const done = end(replay("a deploy with one step left for the person"));
    const journey = journeyOf(flowBySlug(appPool(), "personal") as any, done as any);
    const html = renderToStaticMarkup(<JourneyView journey={journey} run={done} now_ms={0} />);
    expect([...html.matchAll(/<a href="([^"]+)" class="sj-left"/g)].map((m) => m[1])).toEqual([`/tasks/${done.task_short_id}`]);
  });

  test("a stop's reason shows whole: never clamped, since its last words are what the person does next", () => {
    const stopped = end(replay("regression S:"));
    const journey = journeyOf(flowBySlug(appPool(), "personal") as any, stopped as any);
    const html = renderToStaticMarkup(<JourneyView journey={journey} run={stopped} now_ms={0} />);
    const why = html.match(/<p[^>]*data-journey-why[^>]*>([^<]*)<\/p>/)?.[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    expect(why).toBe((journey.now as any).why);
    expect(html).toMatch(/<p class="sj-note" data-whole="(true)?"[^>]*data-journey-why/);
    // Every other flow's stop clamps its reason as before.
    const other = renderToStaticMarkup(<JourneyView journey={{ ...journey, personal: undefined }} run={stopped} now_ms={0} />);
    expect(other).not.toContain("data-whole");
    expect(why!.endsWith("and Ship again.")).toBe(true);
    const css = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "ship.css"), "utf8");
    expect(css).toMatch(/\.sj-note\[data-whole\]\s*\{[^}]*-webkit-line-clamp:\s*unset[^}]*overflow:\s*visible/);
  });

  test("Landing unknown offers the run, never Ship again: the change may already be on main", () => {
    const again = () => <button data-ship-again>Ship again</button>;
    for (const name of ["a push whose answer is lost while origin cannot be read stops at Landing unknown, never Not landed (run 1)", "a Land its station cuts off after it set out to push ends Landing unknown"]) {
      const stopped = end(replay(name));
      const journey = journeyOf(flowBySlug(appPool(), "personal") as any, stopped as any);
      const html = renderToStaticMarkup(<JourneyView journey={journey} run={stopped} now_ms={0} again={again} />);
      expect(html).not.toContain("data-ship-again");
      expect(html).toContain(`href="/workflows/runs/${stopped._id}"`);
      expect(html).toContain(">Resume at Land</button>");
    }
    // A stop where shipping again is the way on still offers it.
    const rejected = end(replay("a session that drops its change when briefed"));
    expect(renderToStaticMarkup(<JourneyView journey={journeyOf(flowBySlug(appPool(), "personal") as any, rejected as any)} run={rejected} now_ms={0} again={again} />)).toContain("data-ship-again");
  });

  test("with no landed commit known, a target opens with the session highlighted and its deploy open", () => {
    const html = renderToStaticMarkup(<SessionTargets teamId="T1" conversationId="conv1" known={[{ name: "web", state: "live", deploy: "dp-12" }]} />);
    expect(links(html)).toEqual(["/deploys?team=T1&target=web&session=conv1&deploy=dp-12"]);
  });
});

// Where the session's change is on each target, read from the store when the run has no deploy reach of its own.
describe("the session's targets read from the store", () => {
  const H = 3_600_000;
  const T0 = 1_800_000_000_000;
  const session = { conversation_id: "conv1", short_id: null, title: null };
  const waitingOn = (head_ci: string) => ({
    _id: "o/r#production", workspace: "team:T1", name: "production", repository: "o/r", runs: "here", policy: "press", can_deploy: true,
    queue: { known: true, truncated: false, commits: 1, untouched: 0, head_sha: "c0ffee00", head_ci, head_ci_url: null, shown: 1,
      groups: [{ key: "s:conv1", session, ci: head_ci, commits: [{ sha: "c0ffee00", subject: "x", at: T0, main_at: T0, author: null, session, tasks: [], ci: head_ci, ci_url: null }] }] },
  });
  const dep = (short_id: string, status: string, sha: string | null, created_at: number) => ({ _id: short_id, workspace: "team:T1", target: "production", repository: "o/r", short_id, status, action: "deploy", sha, sessions: [], created_at, live_at: null });
  const draw = () => renderToStaticMarkup(<SessionTargets teamId="T1" conversationId="conv1" />);

  test("a stale open deploy with no commit, or one asked for before the change landed, is not carrying it", () => {
    deployState = { targets: [waitingOn("passed")], deploys: [dep("dp-1969", "requested", null, T0 - 5 * 24 * H)] };
    expect(draw()).toContain("<span>waiting</span>");
    deployState = { targets: [waitingOn("passed")], deploys: [dep("dp-2406", "running", "0dd0dd00", T0 - 4 * 24 * H)] };
    expect(draw()).toContain("<span>waiting</span>");
  });

  test("an open deploy cut after the change landed is taking it out", () => {
    deployState = { targets: [waitingOn("passed")], deploys: [dep("dp-3388", "running", "a1e4faf5", T0 + H)] };
    expect(draw()).toContain("going out · dp-3388");
  });

  test("the Deploy press shows only where CI on what it would send is not red", () => {
    deployState = { targets: [waitingOn("passed")], deploys: [] };
    expect(draw()).toContain("data-session-deploy");
    deployState = { targets: [waitingOn("failed")], deploys: [] };
    expect(draw()).not.toContain("data-session-deploy");
    deployState = { targets: [], deploys: [] };
  });
});

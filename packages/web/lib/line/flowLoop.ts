// The whole loop a change moves through (the Flows page's Loop view, ct-87142):
// the rules people set over each stage, the two ways in (a person's session
// shipping through a flow, the line starting problems from signals), the
// checks both share, ship and watch, and what production sends back as the
// next signal. Each stage carries the counts the store holds now. Pure: the
// Loop view draws it from the flow map, the runs, the deploys and the flows
// the roles own.
import type { FlowMap } from "@codecast/shared/contracts/flowMap";
import { segmentTopOf } from "@codecast/shared/contracts/flowPool";
import type { AppFlow } from "./flowPool";
import type { OwnedFlow } from "./ownedFlows";

type Run = { _id: string; status: string; workflow_slug?: string; current_node_id?: string | null };
type Deploy = { status: string; live_at?: number | null; created_at: number; workspace?: string };

export const LOOP_DAY_MS = 86_400_000;
const LIVE = new Set(["pending", "running", "paused"]);

/** A check every change passes (a library segment that judges the change), and who answers it. */
export type LoopCheck = { slug: string; label: string; person: boolean; at: number; waiting: number };

export type FlowLoop = {
  rules: {
    sources: { feeds: number; silent: number; unfiled: number };
    owners: { roles: number; projects: number };
    skills: { prompts: number };
    gates: { checks: number; people: number };
    autonomy: { merging: number; roles: number };
  };
  signals: { today: number; top: Array<{ key: string; label: string; today: number; state: string }> };
  problems: { open: number; queued: number };
  /** A person's session shipping its change through a flow: runs going now, and those waiting on a person. */
  person: { running: number; waiting: number };
  /** The line taking problems from signals: runs working, waiting on a person, stalled. */
  line: { running: number; waiting: number; stalled: number };
  checks: LoopCheck[];
  ship: { landing: number; going: number; liveToday: number; failedToday: number; watching: number };
  back: { regressed: number; reopened: number };
  /** Blocking decisions on the team's runs: the viewer's, and everyone else's. */
  decisions: { you: number; team: number };
};

/** Segments that judge a change: checks a command or agent runs, and the gates where a person decides. */
const CHECK_SEGMENTS = ["check", "review", "eval", "decide"];
/** Segments that take a change out rather than judge it. */
const SHIPPING = /^(ship|land|deploy)/;
/** Stations where a change waits to go in: landing and merging. */
const LANDING = /^(ship|land|merge|push|ready_to_land|rebase)$/;
/** Stations where a change goes out. */
const DEPLOYING = /^(deploy|wait_for_live)$/;

export function flowLoop(o: {
  map: FlowMap | null;
  runs: ReadonlyArray<Run>;
  library: ReadonlyArray<AppFlow>;
  owned: ReadonlyArray<OwnedFlow>;
  deploys: ReadonlyArray<Deploy>;
  /** The live flow's queue, as its head counts it: problems waiting for the line to take them. */
  queued: number;
  now: number;
}): FlowLoop {
  const { map, now } = o;
  const bySlug = new Map(o.library.map((f) => [f.slug, f]));
  const lineSlugs = new Set((map?.lanes ?? []).map((l) => l.key));
  // A person's change rides a flow that takes a branch or a session's edits; the line's runs ride its lanes.
  const personFlow = (slug: string | undefined) => !!slug && !lineSlugs.has(slug) && !!bySlug.get(slug)?.takes.includes("branch");
  const live = o.runs.filter((r) => LIVE.has(r.status));
  const mine = live.filter((r) => personFlow(r.workflow_slug));
  const stationOf = (r: Run) => segmentTopOf(r.current_node_id ?? "");

  // The checks: the segments the Change flow runs before it lands (a new judge joins on its own), else the usual four.
  const changeUses = (bySlug.get("change")?.uses ?? []).filter((u) => !SHIPPING.test(u));
  const checks: LoopCheck[] = (changeUses.length ? changeUses : CHECK_SEGMENTS).flatMap((slug) => {
    const seg = bySlug.get(slug);
    if (!seg) return [];
    const person = seg.stations.some((s) => s.kind === "person");
    const here = live.filter((r) => stationOf(r) === slug);
    return [{ slug, label: seg.label, person, at: here.length, waiting: here.filter((r) => r.status === "paused").length }];
  });

  const lanes = map?.lanes ?? [];
  const laneSum = (k: "running" | "waiting" | "stalled") => lanes.reduce((n, l) => n + l.steps.reduce((m, s) => m + s[k], 0), 0);
  const sources = map?.sources ?? [];
  const owned = o.owned;
  const liveFlows = lanes.map((l) => bySlug.get(l.key)).filter((f): f is AppFlow => !!f);
  const shipped = map?.shipped ?? [];

  return {
    rules: {
      sources: { feeds: sources.filter((s) => s.route !== "unfiled").length, silent: sources.filter((s) => s.state !== "flowing").length, unfiled: sources.filter((s) => s.route === "unfiled").length },
      owners: { roles: owned.length, projects: owned.reduce((n, f) => n + f.projects.length, 0) },
      skills: { prompts: liveFlows.reduce((n, f) => n + f.stations.filter((s) => s.kind === "agent").length, 0) },
      gates: { checks: checks.filter((c) => !c.person).length, people: checks.filter((c) => c.person).length },
      autonomy: { merging: owned.filter((f) => f.merge).length, roles: owned.length },
    },
    signals: {
      today: sources.reduce((n, s) => n + s.today, 0),
      top: [...sources].sort((a, b) => b.today - a.today).slice(0, 6).map((s) => ({ key: s.key, label: s.label, today: s.today, state: s.state })),
    },
    problems: { open: map?.header.problemsOpen ?? 0, queued: o.queued },
    person: { running: mine.filter((r) => r.status !== "paused").length, waiting: mine.filter((r) => r.status === "paused").length },
    line: { running: laneSum("running"), waiting: laneSum("waiting"), stalled: laneSum("stalled") },
    checks,
    ship: {
      landing: live.filter((r) => LANDING.test(stationOf(r))).length,
      going: o.deploys.filter((d) => d.status !== "live" && d.status !== "failed").length + live.filter((r) => DEPLOYING.test(stationOf(r))).length,
      liveToday: o.deploys.filter((d) => d.status === "live" && (d.live_at ?? d.created_at) > now - LOOP_DAY_MS).length,
      failedToday: o.deploys.filter((d) => d.status === "failed" && d.created_at > now - LOOP_DAY_MS).length,
      watching: map?.header.watching ?? 0,
    },
    back: { regressed: map?.header.regressed ?? 0, reopened: shipped.filter((s) => !!s.reopenedBy).length },
    decisions: { you: map?.header.decisionsForYou ?? 0, team: map?.header.decisionsForTeam ?? 0 },
  };
}

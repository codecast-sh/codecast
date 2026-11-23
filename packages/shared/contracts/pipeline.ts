// A repository's pipeline (docs/architecture/pipeline.md PL1, PL6): the change
// flow a session's Ship runs in it, and the release flow every deploy of it
// runs, each as the repository resolves it, with every station's own/inherited
// mark, when it runs, who does it and what it runs; and the deploy targets a
// release goes out to. The CLI builds it from a checkout (`cast flow pipeline`),
// publishes it beside the repository's deploy targets (deploys.md DP10), and
// the app draws it; all three read this one shape. Derived, never edited.

import type { FlowEdgeIn, FlowNodeIn } from "./flowPool";
import type { DeployTargetPolicy, DeployTargetRuns } from "./deployTargets";
import type { LineDeployStep } from "./lineDeploy";

/** Who does a station's work. `rule` is a branch, a join or a routing step that decides without doing. */
export const PIPELINE_WHO = ["agent", "command", "person", "rule", "eval", "deploy"] as const;
export type PipelineWho = (typeof PIPELINE_WHO)[number];

/**
 * - `added`: the project's own station, not in its backbone.
 * - `changed`: in the backbone, with the project's own words for it (`changed` names which).
 * - `inherited`: the backbone's, as the team keeps it.
 */
export const PIPELINE_OWN = ["added", "changed", "inherited"] as const;
export type PipelineOwn = (typeof PIPELINE_OWN)[number];

export type PipelineStation = {
  /** The top-level node id (a segment's stations fold into it). */
  id: string;
  /** The flow's label for it; deploy steps by LINE_DEPLOY_STEP_LABELS. */
  label: string;
  who: PipelineWho;
  own: PipelineOwn;
  /** On the path a change takes when every station passes (foldFlow `main`); false for a way back or an end route. */
  main: boolean;
  /** For `changed`: the words the project set (`prompt`, `script`, `stations`, `routes`, `guide`, ...). */
  changed?: string[];
  /** Runs only when the change (or the release's batch) touches these paths; absent: always. */
  when?: string[];
  /**
   * What a command station runs (a segment's: its inner commands, one per line). On a release step: the command every
   * target runs for it, or null: no command, it passes with a note. Absent: not a command, or `varies`.
   */
  runs?: string | null;
  /** A release step whose command differs between targets: each target's is in `targets`. */
  varies?: true;
  /** On a release step: what each target the release sends runs for it (null: passes with a note). */
  targets?: Array<{ name: string; runs: string | null }>;
  /** It waits for something it does not start (a Deploy with `send=""` waits for the deploy that carries the change). */
  waits?: true;
  /** An agent's or person's prompt as the station inherits it, files read in; for a segment, its one prompted station's. Absent: no prompt. */
  prompt?: string | null;
  /** The project's guidance appended to that prompt (`guide=`), apart from it. Absent: none. */
  guide?: string | null;
  /** The agent client (`claude`, `codex`) and model the station names, when it names them. */
  agent?: string;
  model?: string;
};

export type PipelineFlow = {
  /** The flow's slug as the repository resolves it (`change`, `line-deploy`). */
  slug: string;
  label: string;
  /** The library flow it extends (its backbone), by slug; itself for a library flow run as it stands; null when the project wrote it whole. */
  base: string | null;
  /** The file it was read from, repo-relative; null for a flow codecast ships or the team's pool holds. */
  file: string | null;
  /** The graph, segments expanded: what foldFlow and flowDiagram read. */
  graph: { nodes: FlowNodeIn[]; edges: FlowEdgeIn[] };
  /** Every folded station, in the order work first reaches it. */
  stations: PipelineStation[];
  /** Backbone stations this flow takes off its path, by label. */
  removed: string[];
};

export type PipelineTarget = {
  name: string;
  policy: DeployTargetPolicy;
  runs: DeployTargetRuns;
  /** Paths whose change it ships; empty: every path. */
  when: string[];
  /** What a deploy of it runs at each step (deploys.md DP13, targetDeployProfile); null: the step passes with a note. */
  steps: Record<LineDeployStep, string | null>;
};

/** At most how many of the default branch's commits a pipeline carries, paths of each, characters of a subject, and bytes of the whole block. */
export const PIPELINE_RECENT_MAX = 50;
export const PIPELINE_COMMIT_FILES_MAX = 100;
export const PIPELINE_SUBJECT_MAX = 120;
export const PIPELINE_RECENT_MAX_BYTES = 64 * 1024;

/** A commit as git reads it, before packing. */
export type PipelineCommitIn = { sha: string; subject: string; at: number; files: string[] };

/**
 * The default branch's last commits, newest first, each path stored once: a commit's `files` index into `paths`.
 * What a `when=` would have matched ("would have run on 12 of the last 50").
 */
export type PipelineRecent = {
  paths: string[];
  /** `at` is the commit time in ms; `files` holds at most PIPELINE_COMMIT_FILES_MAX paths of a larger commit. */
  commits: Array<{ sha: string; subject: string; at: number; files: number[] }>;
  /** The oldest commits of the window left out to stay under PIPELINE_RECENT_MAX_BYTES; 0 when every one fit. */
  dropped: number;
};

export const EMPTY_RECENT: PipelineRecent = { paths: [], commits: [], dropped: 0 };

const byteLength = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

function packFirst(commits: ReadonlyArray<PipelineCommitIn>, n: number): Omit<PipelineRecent, "dropped"> {
  const index = new Map<string, number>();
  const paths: string[] = [];
  const at = (p: string) => {
    let i = index.get(p);
    if (i === undefined) { i = paths.length; paths.push(p); index.set(p, i); }
    return i;
  };
  return {
    paths,
    commits: commits.slice(0, n).map((c) => ({ sha: c.sha, subject: c.subject.split("\n")[0].slice(0, PIPELINE_SUBJECT_MAX), at: c.at, files: c.files.slice(0, PIPELINE_COMMIT_FILES_MAX).map(at) })),
  };
}

/** Pack commits (newest first) into a PipelineRecent under the byte cap, leaving out the oldest until it fits. */
export function packRecent(commits: ReadonlyArray<PipelineCommitIn>, maxBytes = PIPELINE_RECENT_MAX_BYTES): PipelineRecent {
  const window = commits.slice(0, PIPELINE_RECENT_MAX);
  for (let n = window.length; n > 0; n--) {
    const packed = { ...packFirst(window, n), dropped: window.length - n };
    if (byteLength(packed) <= maxBytes) return packed;
  }
  return { ...EMPTY_RECENT, dropped: window.length };
}

/** A packed commit's paths. */
export const recentFiles = (r: PipelineRecent, c: PipelineRecent["commits"][number]): string[] => c.files.map((i) => r.paths[i]);

/** Why a published recent block is not one packRecent makes, or null. */
export function recentRefusal(r: PipelineRecent): string | null {
  if (r.commits.length > PIPELINE_RECENT_MAX) return `recent holds ${r.commits.length} commits, over ${PIPELINE_RECENT_MAX}`;
  if (r.commits.some((c) => c.files.length > PIPELINE_COMMIT_FILES_MAX || c.files.some((i) => !Number.isInteger(i) || i < 0 || i >= r.paths.length))) return "recent names a path index it does not hold";
  const bytes = byteLength(r);
  return bytes > PIPELINE_RECENT_MAX_BYTES ? `recent is ${bytes} bytes, over ${PIPELINE_RECENT_MAX_BYTES}` : null;
}

export type Pipeline = {
  /** `owner/name`, lowercased: the key. */
  repository: string;
  published_at: number;
  /** The machine that published it, which is where its release runs. */
  device_id: string | null;
  /** The commit it was built from: on the default branch, its flow files clean (a publish refuses anything else). */
  head_sha: string | null;
  /** The checkout it was read from, an absolute path on `device_id`'s machine: where a session that edits it starts. */
  root: string | null;
  /** The default branch's last commits on origin with the paths each changed (packRecent). */
  recent: PipelineRecent;
  change: PipelineFlow;
  release: PipelineFlow & { targets: PipelineTarget[] };
};

/** What the CLI sends to /cli/pipelines/publish: the pipeline less what the server stamps. */
export type PipelinePublish = Omit<Pipeline, "published_at">;

/** The words a station's own mark reads as. */
export function ownWords(s: Pick<PipelineStation, "own" | "changed">): string {
  if (s.own === "inherited") return "inherited";
  if (s.own === "added") return "own";
  return `own: ${s.changed?.length ? s.changed.join(", ") : "changed"}`;
}

/** A station's command in words: what it runs, that it passes, or that targets differ; null for no command. */
export function runsWords(s: Pick<PipelineStation, "runs" | "varies" | "waits">): string | null {
  if (s.varies) return "varies by target";
  if (s.runs === undefined) return null;
  return s.runs === null ? "no command: passes" : s.runs;
}

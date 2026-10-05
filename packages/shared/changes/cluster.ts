// Layer 0 of the Changes page (docs/proposals/changes-page.md 7.1): one day's
// commits in, stories out. Pure over plain records, so Convex's buildDay and
// the tests run the same code and a day clusters the same way twice.
//
// The rules, in order:
//   rebase twins collapse, release commits and their restamps become bursts;
//   (a) commits of one team-visible session form a story, and sessions that
//       share a task merge;
//   (b) everything else groups by branch when off the default branch, else by
//       area plus conventional scope plus the pull request or task it is
//       linked to, breaking on a 3 hour gap;
//   (c) a default-branch commit touching 3 or more areas splits into one
//       slice per area; each slice joins the story of its area, and the
//       slices nothing claims stay together as the commit's own story.
import { commitArea, narrowAreas, parseConventional, rankAreas, scopeNamesArea, subjectKind, type AreaTouch, type ChangeKind } from "./classify";
import { dedupeCommits, onDefaultBranch, resolveDefaultBranch } from "./dedupe";
import { sliceDek, storyDek, storyHeadline, type HeadlineUnit } from "./headline";
import { clusterAnchor, storyKey } from "./keys";
import { computeRisks, type RiskContext } from "./risks";
import { assignRelease, releaseBursts, withoutShadowedReleases } from "./surfaces";
import type { ChangeCommit, ChangePr, LayerZeroStory, ReleaseBurst, ShipEvent, VisibleConversation } from "./types";

/** A commit touching this many areas is a batch and splits by area. */
export const BATCH_AREAS = 3;
/** An area of a batch commit is a slice of its own only with this share of the commit's file touches. */
export const SLICE_SHARE = 0.15;
/** A session whose commits land in this many areas is committing a tree, not pursuing one intent. */
export const SPREAD_AREAS = 4;
/** Commits further apart than this start a new cluster under rule (b). */
export const CLUSTER_GAP_MS = 3 * 60 * 60 * 1000;
/** Conventional types that read as housekeeping and rank into In brief by default. */
const BRIEF_TYPES = new Set(["chore", "ci", "build", "style"]);

export type LayerZeroInput = {
  team_id: string;
  repository: string;
  /** Team-local YYYY-MM-DD; part of every story key. */
  date: string;
  /** `repo_sources.default_branch` when recorded. */
  default_branch?: string | null;
  commits: readonly ChangeCommit[];
  /** Conversations that passed `teamVisibleInputs()`. A commit whose conversation is absent is private provenance. */
  visible: readonly VisibleConversation[];
  prs?: readonly ChangePr[];
  /** Tags and deploy markers from `external_events`, any time. The day's release commits are added here. */
  ships?: readonly ShipEvent[];
};

export type LayerZeroResult = {
  default_branch: string;
  stories: LayerZeroStory[];
  bursts: ReleaseBurst[];
  /** Input ships plus the day's release commits, oldest first. */
  ships: ShipEvent[];
  twins: Record<string, string[]>;
  /** Visible sessions with commits today. */
  visible_conversation_ids: string[];
  /** Sessions with commits today that failed the gate; a count, never names. */
  private_conversation_count: number;
};

/** One commit's share of a story: the whole commit, or one area's slice of a batch commit. */
type Unit = {
  commit: ChangeCommit;
  /** Set for a slice; null for a whole commit. */
  slice: string | null;
  area: string;
  scope: string | null;
  type: string | null;
  lines: number;
  touches: Record<string, AreaTouch>;
};

type Cluster = {
  anchor: string;
  area: string;
  scope: string | null;
  units: Unit[];
  /** A batch commit's leftover slices, told from their facts rather than the subject alone. */
  remainder: boolean;
};

const lineCount = (t: AreaTouch) => t.insertions + t.deletions;

function toUnits(c: ChangeCommit, defaultBranch: string): Unit[] {
  const conv = parseConventional(c.subject);
  const scope = conv?.scope ?? null;
  const type = conv?.type ?? null;
  if (Object.keys(c.areas).length >= BATCH_AREAS && onDefaultBranch(c, defaultBranch)) {
    // Only an area with a real share of the commit is a slice of its own; the
    // thin ones ride with its largest slice, so a stray file never becomes a
    // second story told from the same commit message.
    const total = Object.values(c.areas).reduce((n, t) => n + t.touches, 0);
    const ranked = rankAreas(c.areas);
    const slices = ranked.filter((a) => c.areas[a].touches >= total * SLICE_SHARE);
    if (slices.length >= 2) {
      const thin = ranked.filter((a) => !slices.includes(a));
      return slices.map((a, i) => {
        const touches: Record<string, AreaTouch> = { [a]: c.areas[a] };
        if (i === 0) for (const t of thin) touches[t] = c.areas[t];
        return {
          commit: c,
          slice: a,
          area: a,
          scope: scope && scopeNamesArea(scope, a) ? null : scope,
          type,
          lines: Object.values(touches).reduce((n, t) => n + lineCount(t), 0),
          touches,
        };
      });
    }
  }
  const area = commitArea(c.areas, scope);
  return [{
    commit: c,
    slice: null,
    area,
    // A scope that only names the area adds nothing to the grouping key.
    scope: scope && scopeNamesArea(scope, area) ? null : scope,
    type,
    lines: c.insertions + c.deletions,
    touches: c.areas,
  }];
}

function mergeTouches(units: readonly Unit[]): Record<string, AreaTouch> {
  const out: Record<string, AreaTouch> = {};
  for (const u of units) {
    for (const [a, t] of Object.entries(u.touches)) {
      const o = (out[a] ??= { touches: 0, insertions: 0, deletions: 0 });
      o.touches += t.touches;
      o.insertions += t.insertions;
      o.deletions += t.deletions;
    }
  }
  return out;
}

const byTime = (a: Unit, b: Unit) => a.commit.timestamp - b.commit.timestamp || a.commit.sha.localeCompare(b.commit.sha);

class Unions {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  join(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

export function buildLayerZero(input: LayerZeroInput): LayerZeroResult {
  const defaultBranch = resolveDefaultBranch(input.default_branch, input.commits.map((c) => c.branch));
  const deduped = dedupeCommits(input.commits, defaultBranch);
  const commits = narrowAreas(deduped.commits);
  const twins = deduped.twins;
  const { bursts, absorbed } = releaseBursts(commits, defaultBranch);
  const ships = withoutShadowedReleases([...(input.ships ?? []), ...bursts.flatMap((b) => b.releases)]).sort((a, b) => a.at - b.at || a.surface.localeCompare(b.surface));

  const visible = new Map(input.visible.map((v) => [v.conversation_id, v]));
  const units = commits.filter((c) => !absorbed.has(c.sha)).flatMap((c) => toUnits(c, defaultBranch)).sort(byTime);
  const isDefault = (u: Unit) => onDefaultBranch(u.commit, defaultBranch);

  const privateConvs = new Set<string>();
  const visibleConvs = new Set<string>();
  for (const c of commits) {
    if (!c.conversation_id) continue;
    (visible.has(c.conversation_id) ? visibleConvs : privateConvs).add(c.conversation_id);
  }

  // A visible session whose own commits land in many areas committed a tree
  // of other work; it stays as provenance but does not group by rule (a).
  const convAreas = new Map<string, Set<string>>();
  for (const c of commits) {
    if (absorbed.has(c.sha) || !c.conversation_id || !visible.has(c.conversation_id)) continue;
    const set = convAreas.get(c.conversation_id) ?? new Set();
    set.add(commitArea(c.areas, parseConventional(c.subject)?.scope ?? null));
    convAreas.set(c.conversation_id, set);
  }
  const spread = new Set([...convAreas].filter(([, areas]) => areas.size >= SPREAD_AREAS).map(([id]) => id));
  const anchors = (u: Unit) => {
    const id = u.commit.conversation_id;
    return !u.slice && !!id && visible.has(id) && !spread.has(id) ? id : null;
  };

  // (a) sessions, merged through shared tasks.
  const unions = new Unions();
  const taskOwner = new Map<string, string>();
  const tasksOf = (id: string, u: Unit) => [...(visible.get(id)?.task_ids ?? []), ...commitLinks(u.commit, visible).task_ids];
  for (const u of units) {
    const id = anchors(u);
    if (!id) continue;
    unions.find(id);
    for (const t of tasksOf(id, u)) {
      const owner = taskOwner.get(t);
      if (owner) unions.join(owner, id);
      else taskOwner.set(t, id);
    }
  }
  const sessionGroups = new Map<string, Unit[]>();
  const rest: Unit[] = [];
  const slices: Unit[] = [];
  for (const u of units) {
    const id = anchors(u);
    if (id) {
      const root = unions.find(id);
      const g = sessionGroups.get(root) ?? [];
      g.push(u);
      sessionGroups.set(root, g);
    } else if (u.slice) slices.push(u);
    else rest.push(u);
  }

  const clusters: Cluster[] = [];
  for (const g of sessionGroups.values()) {
    // Anchor on the session with the earliest commit, so a late session joining through a task keeps the key.
    const anchor = g[0].commit.conversation_id!;
    clusters.push({ anchor, area: rankAreas(mergeTouches(g))[0] ?? g[0].area, scope: null, units: g, remainder: false });
  }

  // (b) branch, or area plus scope, with a gap.
  const open = new Map<string, Cluster>();
  for (const u of rest) {
    const branch = isDefault(u) ? defaultBranch : u.commit.branch!;
    // A commit linked to a pull request or task is its own piece of work: it never absorbs unlinked neighbours.
    const key = isDefault(u) ? `\u0000${u.area}\u0000${u.scope ?? ""}\u0000${linkKey(u.commit, visible)}` : branch;
    const cur = open.get(key);
    const last = cur?.units[cur.units.length - 1];
    if (cur && last && u.commit.timestamp - last.commit.timestamp <= CLUSTER_GAP_MS) {
      cur.units.push(u);
      continue;
    }
    const scope = isDefault(u) ? u.scope : null;
    const c: Cluster = { anchor: clusterAnchor(branch, isDefault(u) ? u.area : "", scope, u.commit.sha), area: u.area, scope, units: [u], remainder: false };
    clusters.push(c);
    open.set(key, c);
  }
  // A branch cluster reads as the area it touched most; its key does not name an area, so this never moves it.
  for (const c of clusters) if (!c.units.some(isDefault)) c.area = rankAreas(mergeTouches(c.units))[0] ?? c.area;

  // (c) slices join the nearest default-branch story of their area within the gap.
  const byArea = new Map<string, Cluster[]>();
  for (const c of clusters) {
    if (!c.units.some(isDefault)) continue;
    const list = byArea.get(c.area) ?? [];
    list.push(c);
    byArea.set(c.area, list);
  }
  const leftovers = new Map<string, Unit[]>();
  for (const s of slices) {
    let best: Cluster | null = null;
    let bestGap = Infinity;
    for (const c of byArea.get(s.area) ?? []) {
      const first = c.units[0].commit.timestamp;
      const last = c.units[c.units.length - 1].commit.timestamp;
      const gap = s.commit.timestamp < first ? first - s.commit.timestamp : Math.max(0, s.commit.timestamp - last);
      if (gap <= CLUSTER_GAP_MS && gap < bestGap) {
        best = c;
        bestGap = gap;
      }
    }
    if (best) {
      best.units.push(s);
      best.units.sort(byTime);
    } else {
      const list = leftovers.get(s.commit.sha) ?? [];
      list.push(s);
      leftovers.set(s.commit.sha, list);
    }
  }
  for (const [sha, list] of leftovers) {
    const area = rankAreas(mergeTouches(list))[0];
    clusters.push({ anchor: clusterAnchor(defaultBranch, area, null, sha), area, scope: null, units: list, remainder: true });
  }

  // Unlinked bulk work stands out only on a day whose other work carries a session, pull request or task.
  const linked = commits.some((c) => !!c.conversation_id || !!c.pr_id || !!c.task_ids?.length);
  const stories = clusters.map((c) => toStory(c, input, defaultBranch, visible, spread, { ships, linked }));
  stories.sort((a, b) => a.first_at - b.first_at || a.story_key.localeCompare(b.story_key));
  return {
    default_branch: defaultBranch,
    stories,
    bursts,
    ships,
    twins,
    visible_conversation_ids: [...visibleConvs].sort(),
    private_conversation_count: privateConvs.size,
  };
}

const uniq = <T,>(xs: Iterable<T>) => [...new Set(xs)];

/** A commit's own task and PR links, withheld when its session failed the gate: they would name private work. */
function commitLinks(c: ChangeCommit, visible: ReadonlyMap<string, VisibleConversation>): { task_ids: readonly string[]; pr_id: string | null } {
  return c.conversation_id && !visible.has(c.conversation_id) ? { task_ids: [], pr_id: null } : { task_ids: c.task_ids ?? [], pr_id: c.pr_id ?? null };
}

/** The pull request a squash merge (`… (#123)`) or a merge commit (`Merge pull request #123 …`) names on its subject. */
export function prNumberOf(subject: string): number | null {
  const n = /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? /^Merge pull request #(\d+)\b/.exec(subject)?.[1];
  return n ? Number(n) : null;
}

/** What a default-branch commit is linked to under rule (b): its pull request, else its first task, else the pull request its subject names. */
function linkKey(c: ChangeCommit, visible: ReadonlyMap<string, VisibleConversation>): string {
  const links = commitLinks(c, visible);
  return links.pr_id ?? links.task_ids[0] ?? String(prNumberOf(c.subject) ?? "");
}

function toStory(c: Cluster, input: LayerZeroInput, defaultBranch: string, visible: Map<string, VisibleConversation>, spread: ReadonlySet<string>, risk: RiskContext): LayerZeroStory {
  const units = c.units;
  const commits = uniq(units.map((u) => u.commit));
  const whole = units.filter((u) => !u.slice);
  const onDefault = units.some((u) => onDefaultBranch(u.commit, defaultBranch));
  const branch = onDefault ? defaultBranch : units[units.length - 1].commit.branch!;

  // Slices never carry their commit's session, nor does any commit of a
  // session that committed a spread of work: the session that landed it is not
  // its author, and its account of its own day would be told as this story's.
  // Phase 2 names the authors by their edits, the lander too when it made them.
  const convIds = uniq(whole.map((u) => u.commit.conversation_id).filter((id): id is string => !!id));
  const conversation_ids = convIds.filter((id) => visible.has(id) && !spread.has(id)).sort();
  const conversations = conversation_ids.map((id) => visible.get(id)!);
  const links = whole.map((u) => commitLinks(u.commit, visible));
  const task_ids = uniq([...links.flatMap((l) => l.task_ids), ...conversations.flatMap((v) => v.task_ids ?? [])]).sort();
  const shas = new Set(commits.map((x) => x.sha));
  // Like commitLinks, a private session's commit names no pull request.
  const numbers = new Set(
    commits.filter((x) => !x.conversation_id || visible.has(x.conversation_id)).map((x) => prNumberOf(x.subject)).filter((n): n is number => n !== null),
  );
  const pr_ids = uniq([
    ...links.map((l) => l.pr_id).filter((id): id is string => !!id),
    ...(input.prs ?? [])
      .filter((p) => p.shas?.some((s) => shas.has(s)) || (p.number !== undefined && numbers.has(p.number)) || p.conversation_ids?.some((id) => conversation_ids.includes(id)))
      .map((p) => p.id),
  ]).sort();

  const touches = mergeTouches(units);
  const insertions = Object.values(touches).reduce((n, t) => n + t.insertions, 0);
  const deletions = Object.values(touches).reduce((n, t) => n + t.deletions, 0);
  const area_counts = Object.fromEntries(rankAreas(touches).map((a) => [a, touches[a].touches]));
  const first_at = units[0].commit.timestamp;
  const last_at = units[units.length - 1].commit.timestamp;

  const headlineUnits: HeadlineUnit[] = units.map((u) => ({ sha: u.commit.sha, subject: u.commit.subject, timestamp: u.commit.timestamp, lines: u.lines }));
  const top = [...units].sort((a, b) => b.lines - a.lines || byTime(a, b))[0];
  const kind: ChangeKind = units.some((u) => subjectKind(u.commit.subject) === "revert") ? "revert" : subjectKind(top.commit.subject);
  const brief = c.remainder || kind === "docs" || kind === "test" || (!!top.type && BRIEF_TYPES.has(top.type));

  return {
    story_key: storyKey(input.team_id, input.repository, input.date, c.anchor),
    anchor: c.anchor,
    area: c.area,
    scope: c.scope,
    branch,
    on_default_branch: onDefault,
    commit_shas: commits.map((x) => x.sha),
    whole_shas: uniq(whole.map((u) => u.commit.sha)),
    conversation_ids,
    private_conversation_count: convIds.filter((id) => !visible.has(id)).length,
    task_ids,
    pr_ids,
    author_names: uniq(commits.map((x) => x.author_name)),
    insertions,
    deletions,
    files_changed: Object.values(touches).reduce((n, t) => n + t.touches, 0),
    area_counts,
    first_at,
    last_at,
    release: onDefault ? assignRelease(c.area, last_at, risk.ships) : null,
    risks: computeRisks(
      { units: units.map((u) => ({ commit: u.commit, area: u.slice })), insertions, deletions, conversations, landed: convIds.some((id) => spread.has(id)), pr_ids, task_ids },
      risk,
    ),
    kind,
    importance: brief ? 1 : 2,
    headline: storyHeadline(headlineUnits),
    dek: c.remainder ? sliceDek(area_counts) : storyDek(headlineUnits, commits.length === 1 ? commits[0].body : undefined),
  };
}

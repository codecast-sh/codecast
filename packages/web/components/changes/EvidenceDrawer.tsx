// A story's evidence (spec 3, level 3): its commits in mono with their
// diffstats, the sessions behind it with their insight headline and turns as
// ask/did pairs, its pull requests, and its files grouped by area. The commits
// come from the shared `commits` collection, so a commit the /commit page
// already cached paints at once. The sessions come from `changeStorySessions`,
// fed by storySessions, which passes each one through the Changes gate again:
// a headline only when the team may read the session, turns only when its
// owner shares it in full. Both feeders mount only while the drawer is open.
import Link from "next/link";
import { useMemo, useState } from "react";
import { areaOf, isGeneratedPath, pathInArea } from "@codecast/shared/changes";
import {
  useStoryEvidence,
  useStorySessions,
  useSyncStoryEvidence,
  useSyncStorySessions,
  type StoryRow,
  type StorySessionRow,
} from "../../hooks/useSyncChanges";
import { DiffStat, MetaDot } from "../entityDisplay";
import { EntityIdPill } from "../EntityIdPill";
import { CommitLinks } from "../repo/CommitLinks";
import { AreaTag, Tip, clockOf } from "./StoryParts";
import { areaColor } from "./areaColor";
import { plural } from "./format";
import { useAreaColors } from "./storyContext";
import { KeyHint } from "./useChangesKeys";

export const commitPath = (repository: string, sha: string) => `/commit/${repository}/${sha}`;

type FileLines = { path: string; lines: number; generated: boolean };

/**
 * Files touched per area, from the commits' file lists when they came with
 * them, else the story's counts. Each path sums its changed lines across the
 * story's commits; source comes before generated files, then the largest.
 */
function filesByArea(story: StoryRow, commits: readonly any[]): { area: string; touches: number; paths: FileLines[] }[] {
  const byArea = new Map<string, Map<string, number>>();
  const named = Object.keys(story.area_counts);
  for (const c of commits) {
    for (const f of (c.files ?? []) as { filename: string; changes?: number; additions?: number; deletions?: number }[]) {
      // The story's own word for where the file sits (`backend` on a day that split `outreach` by folder), else the path's.
      const top = areaOf(f.filename);
      const area = named.find((a) => a !== top && pathInArea(f.filename, a)) ?? top;
      const paths = byArea.get(area) ?? new Map<string, number>();
      paths.set(f.filename, (paths.get(f.filename) ?? 0) + (f.changes ?? (f.additions ?? 0) + (f.deletions ?? 0)));
      byArea.set(area, paths);
    }
  }
  if (byArea.size) {
    return [...byArea.entries()]
      .map(([area, paths]) => ({
        area,
        touches: paths.size,
        paths: [...paths.entries()]
          .map(([path, lines]) => ({ path, lines, generated: isGeneratedPath(path) }))
          .sort((a, b) => Number(a.generated) - Number(b.generated) || b.lines - a.lines || a.path.localeCompare(b.path)),
      }))
      .sort((a, b) => b.touches - a.touches || a.area.localeCompare(b.area));
  }
  return Object.entries(story.area_counts)
    .map(([area, touches]) => ({ area, touches, paths: [] }))
    .sort((a, b) => b.touches - a.touches || a.area.localeCompare(b.area));
}

/** Files listed per area before "+N more files". */
const MAX_FILES = 12;

/** An area's files, largest source first, each with its changed lines. */
function AreaFiles({ area, paths }: { area: string; paths: readonly FileLines[] }) {
  const [all, setAll] = useState(false);
  const colors = useAreaColors();
  const more = paths.length - MAX_FILES;
  return (
    <div className="mt-0.5 border-l pl-3 font-mono text-[10px] leading-relaxed text-sol-text/55" style={{ borderColor: areaColor(area, colors) }}>
      {(all ? paths : paths.slice(0, MAX_FILES)).map((f) => (
        <div key={f.path} className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate" title={f.path}>{f.path}</span>
          <span className="shrink-0 tabular-nums text-sol-text/45">{f.lines.toLocaleString()}</span>
        </div>
      ))}
      {more > 0 && (
        <button type="button" onClick={() => setAll((a) => !a)} className="text-sol-text/45 transition-colors hover:text-sol-text">
          {all ? "fewer files" : `+${plural(more, "more file")}`}
        </button>
      )}
    </div>
  );
}

/** Turns shown per session, and the length a did item is cut to (spec 7.4 trims dids the same way). */
const MAX_TURNS = 4;
/** Sessions drawn with their turns; the rest are pills. */
const MAX_SESSIONS = 3;
const DID_CHARS = 160;
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}...` : t);

type Turn = { ask: string; did: string[] };

/** A session's turns as ask/did pairs: empty turns dropped, at most MAX_TURNS, each did cut to DID_CHARS. */
export function InsightTurns({ turns }: { turns: readonly Turn[] }) {
  const shown = turns.filter((t) => t.ask.trim() || t.did.length);
  if (!shown.length) return null;
  const more = shown.length - MAX_TURNS;
  return (
    <ol className="space-y-1 border-l border-sol-border/30 pl-3">
      {shown.slice(0, MAX_TURNS).map((t, i) => (
        <li key={i} className="min-w-0">
          {t.ask.trim() && (
            <p className="chg-ui text-[12px] leading-[1.5] text-sol-text/80">
              <span className="mr-1.5 font-mono text-[10px] text-sol-text/45">asked</span>
              {clip(t.ask.trim(), DID_CHARS)}
            </p>
          )}
          {t.did.slice(0, 3).map((d, j) => (
            <p key={j} className="chg-ui text-[12px] leading-[1.5] text-sol-text/60">
              <span className="mr-1.5 font-mono text-[10px] text-sol-text/40">did</span>
              {clip(d, DID_CHARS)}
            </p>
          ))}
        </li>
      ))}
      {more > 0 && (
        <li className="font-mono text-[10px] text-sol-text/40">{plural(more, "more turn")} in the session</li>
      )}
    </ol>
  );
}

/** One session behind a story: its pill, the insight headline it was summed up by, and what it was asked and did. */
function SessionEvidence({ id, insight }: { id: string; insight: StorySessionRow | undefined }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-baseline gap-2 text-[11px]">
        <EntityIdPill type="session" id={id} compact />
        {insight?.headline && <span className="chg-ui min-w-0 truncate text-[12px] text-sol-text/75">"{insight.headline}"</span>}
      </div>
      <InsightTurns turns={insight?.turns ?? []} />
    </div>
  );
}

export function EvidenceDrawer({ story }: { story: StoryRow }) {
  const feed = useSyncStoryEvidence(String(story._id));
  useSyncStorySessions(String(story._id));
  const sessions = useStorySessions(story);
  const sessionById = useMemo(() => new Map(sessions.map((r) => [String(r.conversation_id), r])), [sessions]);
  const commits = useStoryEvidence(story);
  const areas = useMemo(() => filesByArea(story, commits), [story, commits]);
  const missing = story.commit_shas.length - commits.length;

  return (
    <div className="mt-3 space-y-3 border-t border-dashed border-sol-border/40 pt-3">
      <section>
        <h4 className="mb-1.5 text-[12px] font-semibold text-sol-text/80">
          Commits <span className="font-mono text-[10px] font-normal text-sol-text/45">{story.commit_shas.length}</span>
        </h4>
        <ul className="space-y-1">
          {commits.map((c) => {
            const [subject, ...rest] = String(c.message ?? "").split("\n");
            return (
              <li key={c.sha} data-commit-href={commitPath(story.repository, c.sha)} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[11px]">
                <Link href={commitPath(story.repository, c.sha)} className="shrink-0 text-sol-text/70 underline-offset-2 hover:text-sol-text hover:underline">
                  {c.sha.slice(0, 7)}
                </Link>
                <Tip text={rest.join("\n").trim() ? <span className="whitespace-pre-line">{c.message}</span> : subject}>
                  <span className="min-w-0 flex-1 truncate text-sol-text/85">{subject}</span>
                </Tip>
                <DiffStat additions={c.insertions} deletions={c.deletions} files={c.files_changed} themed />
                <span className="shrink-0 text-[10px] text-sol-text/45">
                  {c.author_name} {clockOf(c.timestamp)}
                </span>
                <CommitLinks
                  repository={story.repository}
                  joins={{ conversation_id: c.conversation_id ?? null, task_ids: c.task_ids, pr_number: c.pr_number ?? null }}
                  className="basis-full pl-[calc(7ch+0.5rem)]"
                />
              </li>
            );
          })}
          {missing > 0 && (
            <li className="font-mono text-[10px] text-sol-text/45">
              {feed.ready || feed.refused
                ? `${plural(missing, "commit is", "commits are")} not readable here`
                : commits.length ? `${missing} more loading` : "Loading commits"}
            </li>
          )}
        </ul>
      </section>

      {(story.conversation_ids.length > 0 || story.pr_ids.length > 0 || story.private_session_count > 0) && (
        <section>
          <h4 className="mb-1.5 text-[12px] font-semibold text-sol-text/80">Sessions and pull requests</h4>
          <div className="space-y-2.5">
            {story.conversation_ids.slice(0, MAX_SESSIONS).map((id) => <SessionEvidence key={String(id)} id={String(id)} insight={sessionById.get(String(id))} />)}
            <div className="flex flex-wrap items-center gap-1.5">
              {story.conversation_ids.slice(MAX_SESSIONS).map((id) => (
                <EntityIdPill key={String(id)} type="session" id={String(id)} compact />
              ))}
              {story.pr_ids.map((id) => (
                <EntityIdPill key={String(id)} type="pr" id={String(id)} />
              ))}
              {story.private_session_count > 0 && (
                <span className="font-mono text-[10px] text-sol-text/45">
                  {plural(story.private_session_count, "session is", "sessions are")} not shared with the team
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {areas.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[12px] font-semibold text-sol-text/80">Files</h4>
          <div className="space-y-1.5">
            {areas.map((a) => (
              <div key={a.area} className="min-w-0">
                <div className="flex items-center gap-2">
                  <AreaTag area={a.area} />
                  <span className="font-mono text-[10px] tabular-nums text-sol-text/45">{a.touches}</span>
                </div>
                {a.paths.length > 0 && <AreaFiles area={a.area} paths={a.paths} />}
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="flex items-center gap-1.5 font-mono text-[10px] text-sol-text/45">
        <KeyHint action="changes.open" /> opens {story.conversation_ids.length ? "the session" : "the largest commit"}
        <MetaDot />
        <KeyHint action="changes.copyLink" /> copies a link
      </p>
    </div>
  );
}

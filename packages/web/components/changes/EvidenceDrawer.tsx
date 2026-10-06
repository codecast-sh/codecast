// An opened story: its article (markdown: sections, screenshots with
// captions, quoted instruction changes), its why, risks and people, then its
// evidence (spec 3, level 3): its commits in mono with their
// diffstats, the sessions behind it with their insight headline and turns as
// ask/did pairs, its pull requests, and its files grouped by area. The commits
// come from the shared `commits` collection, so a commit the /commit page
// already cached paints at once. The sessions come from `changeStorySessions`,
// fed by storySessions, which passes each one through the Changes gate again:
// a headline only when the team may read the session, turns only when its
// owner shares it in full. Both feeders mount only while the drawer is open.
import Link from "next/link";
import { ChevronRight } from "lucide-react";
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
import { ImageGalleryProvider } from "../ImageGallery";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { AreaTag, People, Provenance, ReleaseTag, RiskLine, Tip, clockOf } from "./StoryParts";
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
          {f.lines > 0 && <span className="shrink-0 tabular-nums text-sol-text/45">{f.lines.toLocaleString()}</span>}
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

/** The first sentences of a session's summary, as many as fit `max` characters. */
function lead(text: string, max: number): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const p of parts) {
    if ((out + " " + p).trim().length > max) break;
    out = (out + " " + p).trim();
  }
  return out || clip(text, max);
}

/**
 * One session behind a story, told in a line and a sentence or two: the
 * outcome it was summed up by and what it did, with its step by step log
 * folded away for whoever wants the detail.
 */
function SessionEvidence({ id, insight }: { id: string; insight: StorySessionRow | undefined }) {
  const turns = (insight?.turns ?? []).filter((t) => t.ask.trim() || t.did.length);
  const summary = insight?.summary ? lead(insight.summary, 240) : "";
  return (
    <div className="min-w-0 rounded-md border border-sol-border/25 bg-sol-bg-alt/40 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px]"><EntityIdPill type="session" id={id} compact /></span>
        {insight?.headline && <span className="chg-ui min-w-0 truncate text-[12.5px] font-medium text-sol-text/85">{insight.headline}</span>}
      </div>
      {summary && <p className="chg-ui mt-1 text-[12px] leading-[1.55] text-sol-text/65 [overflow-wrap:anywhere]">{summary}</p>}
      {turns.length > 0 && (
        <details className="group/steps mt-1">
          <summary className="flex cursor-pointer list-none items-center gap-1 font-mono text-[10px] text-sol-text/45 hover:text-sol-text/80">
            <ChevronRight className="h-2.5 w-2.5 transition-transform group-open/steps:rotate-90" />
            {plural(turns.length, "step")}
          </summary>
          <div className="mt-1.5"><InsightTurns turns={turns} /></div>
        </details>
      )}
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
    <div className="mt-2 space-y-3 pb-1">
      {story.body && (
        // The article's screenshots open full size in the lightbox, one gallery per story.
        <ImageGalleryProvider key={story.story_key}>
          <MarkdownRenderer content={story.body} className="chg-article max-w-[46rem] text-[13.5px] leading-[1.7] text-sol-text/80 prose-p:my-2 prose-p:text-sol-text/80 prose-li:my-0.5 prose-li:text-sol-text/80 prose-headings:font-bold prose-headings:tracking-tight prose-headings:text-sol-text prose-h3:mb-2 prose-h3:mt-7 prose-h3:text-[17px] prose-h3:leading-snug prose-h4:mb-1 prose-h4:mt-4 prose-h4:text-[14.5px] [&>p:first-child]:mt-0 [&>p:first-child]:text-[14.5px] [&>p:first-child]:leading-[1.65] [&>p:first-child]:text-sol-text prose-code:rounded prose-code:bg-sol-bg-alt prose-code:px-1 prose-code:py-px prose-code:text-[12.5px] prose-code:font-medium prose-code:text-sol-text prose-code:before:content-none prose-code:after:content-none prose-blockquote:my-3 prose-blockquote:rounded-r-md prose-blockquote:border-l-2 prose-blockquote:border-sol-border/60 prose-blockquote:bg-sol-bg-alt/60 prose-blockquote:py-1 prose-blockquote:pl-4 prose-blockquote:pr-3 prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-sol-text/75 [&_blockquote_p:before]:content-none [&_blockquote_p:after]:content-none" />
        </ImageGalleryProvider>
      )}
      <RiskLine story={story} full />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <People story={story} />
        <Provenance story={story} />
        <ReleaseTag story={story} />
      </div>
      <details className="group/commits border-t border-dashed border-sol-border/40 pt-3">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-semibold text-sol-text/80 hover:text-sol-text">
          <ChevronRight className="h-3 w-3 transition-transform group-open/commits:rotate-90" />
          {plural(story.commit_shas.length, "commit")}
          <DiffStat additions={story.insertions} deletions={story.deletions} files={story.files_changed} themed />
        </summary>
        <ul className="mt-1.5 space-y-1">
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
      </details>

      {(story.conversation_ids.length > 0 || story.pr_ids.length > 0 || story.private_session_count > 0) && (
        <section>
          <h4 className="mb-1.5 text-[12px] font-semibold text-sol-text/80">How it was made</h4>
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
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-semibold text-sol-text/80 hover:text-sol-text">
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
            Files <span className="font-mono text-[10px] font-normal text-sol-text/45">{areas.reduce((n, a) => n + a.touches, 0)}</span>
          </summary>
          <div className="mt-1.5 space-y-1.5">
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
        </details>
      )}

      <p className="flex items-center gap-1.5 font-mono text-[10px] text-sol-text/45">
        <KeyHint action="changes.open" /> opens {story.conversation_ids.length ? "the session" : "the largest commit"}
        <MetaDot />
        <KeyHint action="changes.copyLink" /> copies a link
      </p>
    </div>
  );
}

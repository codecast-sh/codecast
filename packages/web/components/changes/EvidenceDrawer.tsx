// A story's evidence (spec 3, level 3): its commits in mono with their
// diffstats, the sessions and pull requests behind it, and its files grouped
// by area. The commits come from the shared `commits` collection, so a
// commit the /commit page already cached paints at once; the feeder mounts
// only while the drawer is open.
import Link from "next/link";
import { useMemo } from "react";
import { areaOf } from "@codecast/shared/changes";
import { useStoryEvidence, useSyncStoryEvidence, type StoryRow } from "../../hooks/useSyncChanges";
import { DiffStat, MetaDot } from "../entityDisplay";
import { EntityIdPill } from "../EntityIdPill";
import { CommitLinks } from "../repo/CommitLinks";
import { AreaTag, Tip, clockOf } from "./StoryParts";
import { areaColor } from "./areaColor";
import { KeyHint } from "./useChangesKeys";

export const commitPath = (repository: string, sha: string) => `/commit/${repository}/${sha}`;

/** Files touched per area: from the commits' file lists when they came with them, else the story's counts. */
function filesByArea(story: StoryRow, commits: readonly any[]): { area: string; touches: number; paths: string[] }[] {
  const byArea = new Map<string, Set<string>>();
  for (const c of commits) {
    for (const f of (c.files ?? []) as { filename: string }[]) {
      const area = areaOf(f.filename);
      const set = byArea.get(area) ?? new Set<string>();
      set.add(f.filename);
      byArea.set(area, set);
    }
  }
  if (byArea.size) {
    return [...byArea.entries()]
      .map(([area, paths]) => ({ area, touches: paths.size, paths: [...paths].sort() }))
      .sort((a, b) => b.touches - a.touches || a.area.localeCompare(b.area));
  }
  return Object.entries(story.area_counts)
    .map(([area, touches]) => ({ area, touches, paths: [] }))
    .sort((a, b) => b.touches - a.touches || a.area.localeCompare(b.area));
}

export function EvidenceDrawer({ story }: { story: StoryRow }) {
  const feed = useSyncStoryEvidence(String(story._id));
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
              <li key={c.sha} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[11px]">
                <Link href={commitPath(story.repository, c.sha)} className="shrink-0 text-sol-text/70 underline-offset-2 hover:text-sol-text hover:underline">
                  {c.sha.slice(0, 7)}
                </Link>
                <Tip text={rest.join("\n").trim() ? <span className="whitespace-pre-line">{c.message}</span> : subject}>
                  <span className="min-w-0 flex-1 truncate text-sol-text/85">{subject}</span>
                </Tip>
                <DiffStat additions={c.insertions} deletions={c.deletions} files={c.files_changed} />
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
                ? `${missing} ${missing === 1 ? "commit is" : "commits are"} not readable here`
                : commits.length ? `${missing} more loading` : "Loading commits"}
            </li>
          )}
        </ul>
      </section>

      {(story.conversation_ids.length > 0 || story.pr_ids.length > 0 || story.private_session_count > 0) && (
        <section>
          <h4 className="mb-1.5 text-[12px] font-semibold text-sol-text/80">Sessions and pull requests</h4>
          <div className="flex flex-wrap items-center gap-1.5">
            {story.conversation_ids.map((id) => (
              <EntityIdPill key={String(id)} type="session" id={String(id)} />
            ))}
            {story.pr_ids.map((id) => (
              <EntityIdPill key={String(id)} type="pr" id={String(id)} />
            ))}
            {story.private_session_count > 0 && (
              <span className="font-mono text-[10px] text-sol-text/45">
                {story.private_session_count} {story.private_session_count === 1 ? "session is" : "sessions are"} not shared with the team
              </span>
            )}
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
                {a.paths.length > 0 && (
                  <div className="mt-0.5 border-l pl-3 font-mono text-[10px] leading-relaxed text-sol-text/55" style={{ borderColor: areaColor(a.area) }}>
                    {a.paths.slice(0, 12).map((p) => <div key={p} className="truncate">{p}</div>)}
                    {a.paths.length > 12 && <div className="text-sol-text/40">{a.paths.length - 12} more</div>}
                  </div>
                )}
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

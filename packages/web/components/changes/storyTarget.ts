// Where a story leads when the reader opens it: the session that made it,
// else its largest commit. Read at the moment of the click, from whatever
// commits the store holds then.
import { storyCommits, type StoryRow } from "../../hooks/useSyncChanges";
import { useInboxStore } from "../../store/inboxStore";

export const commitPath = (repository: string, sha: string) => `/commit/${repository}/${sha}`;

/** The story's largest commit the store knows the size of, else its first. */
export function largestCommitHref(story: Pick<StoryRow, "repository" | "commit_shas" | "team_id">): string | null {
  const sizes = new Map<string, number>();
  for (const c of storyCommits(story, Object.values(useInboxStore.getState().commits ?? {}))) sizes.set(c.sha, (c.insertions ?? 0) + (c.deletions ?? 0));
  const sha = [...story.commit_shas].sort((a, b) => (sizes.get(b) ?? -1) - (sizes.get(a) ?? -1))[0];
  return sha ? commitPath(story.repository, sha) : null;
}

export function storyTargetHref(story: StoryRow): string | null {
  const session = story.conversation_ids[0];
  return session ? `/conversation/${session}` : largestCommitHref(story);
}

import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { findEntityInStore } from "../lib/liveEntities";
import { useSyncCollection } from "./useSyncCollection";

const select = (row: unknown) => row ? [row] : [];

export function useRepoObject(
  type: "pr" | "commit" | null,
  rawId: string,
  args: { id?: string; repository?: string; number?: number; sha?: string } | null,
) {
  const pullRequest = useSyncCollection("pullRequests", api.pull_requests.webGet,
    type === "pr" && args ? { ...args, id: args.id as Id<"pull_requests"> | undefined } : "skip", { select });
  const commit = useSyncCollection("commits", api.commits.webGet,
    type === "commit" && args ? { ...args, id: args.id as Id<"commits"> | undefined } : "skip", { select });
  const entity = useInboxStore((s) => type ? findEntityInStore(s, type, rawId) : undefined);
  const feed = type === "pr" ? pullRequest : commit;
  return { entity, ready: type !== null && feed.ready };
}

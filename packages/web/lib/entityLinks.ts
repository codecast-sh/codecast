/**
 * Entity link knowledge now lives in `@codecast/shared/entities` so the CLI's
 * `cast link` command and the web entity pills share one source of truth for
 * "what URL addresses this object". This module re-exports it unchanged so the
 * existing `@/lib/entityLinks` import sites keep working.
 */
export * from "@codecast/shared/entities";
import { parseRepoObjectId } from "@codecast/shared/entities";

/**
 * The repository a pull request named by number alone belongs to: the
 * session's own. A session with none (started in a home directory, see
 * sessionRepository) takes the one repository the conversation knows a PR of
 * that number in, else the one repository all its known PRs are in. Null when
 * several could claim it. The known PRs are only what the reader holds, so a
 * long transcript can name a PR whose link is not loaded.
 */
export function pullRequestRepository(
  number: number,
  known: ReadonlySet<string> | undefined,
  repository: string | null | undefined,
): string | null {
  if (repository) return repository.toLowerCase();
  const claims = new Set<string>();
  const repos = new Set<string>();
  for (const id of known ?? []) {
    const ref = parseRepoObjectId(id);
    if (ref?.type !== "pr") continue;
    repos.add(ref.repository);
    if (ref.number === number) claims.add(ref.repository);
  }
  const candidates = claims.size ? claims : repos;
  return candidates.size === 1 ? [...candidates][0] : null;
}

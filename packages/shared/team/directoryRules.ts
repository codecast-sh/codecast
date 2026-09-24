/** The fields of a folder rule (directory_team_mappings) that decide which
 *  rule governs a path. The server resolves sharing with this, and
 *  `cast sharing` names the rule a folder on this machine is under with it. */
export type DirectoryRuleFacts = {
  path_prefix: string;
  /** A "never share" lock. */
  private?: boolean;
  /** The repository the mapped checkout is a clone of (repositoryKeyOfRemote). */
  repository?: string;
};

/**
 * The rule that governs a path: the longest path rule covering it, else a
 * rule on another checkout of the same repository. A path lock beats a
 * repository rule the way any path rule does, and among repository rules a
 * lock wins over a share, because a lock on any checkout is the owner's word
 * on the whole repository.
 */
export function matchDirectoryMapping<M extends DirectoryRuleFacts>(
  userMappings: M[],
  conversationPath: string | undefined,
  repository?: string | null,
): M | null {
  let bestMatch: M | null = null;
  if (conversationPath) {
    for (const mapping of userMappings) {
      if (
        conversationPath === mapping.path_prefix ||
        conversationPath.startsWith(mapping.path_prefix + "/")
      ) {
        if (!bestMatch || mapping.path_prefix.length > bestMatch.path_prefix.length) {
          bestMatch = mapping;
        }
      }
    }
  }
  if (!bestMatch && repository) {
    for (const mapping of userMappings) {
      if (mapping.repository !== repository) continue;
      if (!bestMatch || (!!mapping.private && !bestMatch.private) || (!!mapping.private === !!bestMatch.private && mapping.path_prefix.length > bestMatch.path_prefix.length)) bestMatch = mapping;
    }
  }
  return bestMatch;
}

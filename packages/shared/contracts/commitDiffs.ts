/**
 * Whether a commit row holds its files' diffs, rather than only their names.
 *
 * A push names files with no patch field at all, and a checkout's publish
 * names them with numstat counts and no patch either. A fetch (GitHub, or a
 * checkout answering the read) writes a patch on every file, empty where there
 * is no diff to show (a binary, a pure rename). So only a patch field, empty or
 * not, means the diff is here; counted lines alone still need the fetch.
 */
export function commitCarriesDiffs(files: ReadonlyArray<{ patch?: string }> | undefined): boolean {
  return (files ?? []).some((f) => f.patch !== undefined);
}

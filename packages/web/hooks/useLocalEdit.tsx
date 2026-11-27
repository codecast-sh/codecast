// The local-checkout side of "Open in editor" on repository surfaces (a pull
// request's files and threads, a commit, a comparison): this machine's own
// checkout of the repository, and the Edit actions that open a file there.

import { useCallback, useMemo } from "react";
import { useRepoWorktrees } from "./useRepoBrowse";
import { useInboxStore } from "../store/inboxStore";
import { localDeviceIdOf } from "./useLocalDeviceId";
import { firstChangedLine, localCheckout, type OpenInEditorOptions } from "../lib/filesPane";
import { OpenInEditorButton } from "../components/OpenInEditorButton";
import type { DiffFile } from "../components/FileDiffLayout";

type DiffAgainst = NonNullable<OpenInEditorOptions["diffAgainst"]>;

/** This machine's checkout of `repository` on `refName` (localCheckout), once
 *  the published checkouts have arrived. */
export function useLocalCheckout(repository: string, refName: string) {
  const checkouts = useRepoWorktrees(repository).data?.checkouts;
  const deviceId = useInboxStore(localDeviceIdOf);
  return checkouts ? localCheckout(checkouts, deviceId, refName) : null;
}

export const joinCheckout = (root: string, path: string) => `${root}/${path.replace(/^\/+/, "")}`;

/**
 * The per-file "Edit" a repository diff (FileDiffLayout's `fileAction`) puts in
 * each file header: the file in this machine's checkout at its first changed
 * line, with the editor's diff against `diffAgainst` when the checkout holds
 * the revision the page shows (`diffFor` decides from the checkout, null for
 * the file alone). A removed file has nothing to open. Undefined when this
 * machine has no checkout, so the headers carry nothing.
 */
export function useLocalEditAction(
  repository: string,
  refName: string,
  diffFor: (checkout: { onRef: boolean; head?: string }) => DiffAgainst | null,
): ((filename: string, file: DiffFile) => React.ReactNode) | undefined {
  const local = useLocalCheckout(repository, refName);
  const diff = local ? diffFor(local) : null;
  const root = local?.root;
  const diffKey = diff ? `${diff.ref}\n${diff.label ?? ""}` : "";
  const action = useCallback(
    (_original: string, file: DiffFile) =>
      !root || file.status === "removed" || file.status === "deleted" ? null : (
        // The file's current name: a renamed file lives under its new one.
        <OpenInEditorButton label="Edit" target={{ path: joinCheckout(root, file.filename), line: firstChangedLine(file.patch) }} diffAgainst={diff ?? undefined} />
      ),
    // diff is keyed by its content: diffFor builds a new object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root, diffKey],
  );
  return root ? action : undefined;
}

/**
 * The Edit a review thread carries: the lines it is about, in this machine's
 * checkout of `refName`, so a person answers a note by fixing the line.
 * Undefined unless a worktree here is on `refName`: in any other tree the
 * thread's line numbers name different lines.
 */
export function useLocalEditAt(repository: string, refName: string): ((path: string, line: number, endLine?: number) => React.ReactNode) | undefined {
  const local = useLocalCheckout(repository, refName);
  const root = local?.onRef ? local.root : undefined;
  return useMemo(
    () => (root ? (path: string, line: number, endLine?: number) => <OpenInEditorButton label="Edit" target={{ path: joinCheckout(root, path), line, endLine }} /> : undefined),
    [root],
  );
}

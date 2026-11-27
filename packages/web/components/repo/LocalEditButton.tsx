"use client";

// "Open in editor" from a repository surface (a blob page, a pull request's
// files, a commit, a comparison): the same file in this machine's own checkout
// of the repository, in the code editor, optionally with the editor's diff
// against the ref the surface compares with. Not drawn when this machine has
// no checkout of the repository.

import { joinCheckout, useLocalCheckout } from "../../hooks/useLocalEdit";
import { OpenInEditorButton } from "../OpenInEditorButton";

export function LocalEditButton({ repository, refName, path, line }: { repository: string; refName: string; path: string; line?: number }) {
  const local = useLocalCheckout(repository, refName);
  if (!local) return null;
  return (
    <OpenInEditorButton
      target={{ path: joinCheckout(local.root, path), line }}
      label="Open in editor"
      className="h-7 rounded-md border border-sol-border/60 px-2 text-[12px] text-sol-text-muted"
    />
  );
}

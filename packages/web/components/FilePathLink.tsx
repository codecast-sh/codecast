"use client";

// A mention of a local file or directory, rendered as a link into the Files
// surface. The parser (lib/remarkEntityIds → lib/filePathLinks) finds the
// mention; this component knows the conversation it sits in, so a relative
// path like `lib/pageLayout.tsx` resolves against that session's working
// directory before it leaves the page.
//
// Plain click opens the file in the code editor BESIDE the conversation, at
// the line and column, in the Files pane already on stage when there is one
// (lib/filesPane openInEditor), and links that conversation to the editor.
// Modified clicks keep the Link compat's tab/window behaviour; right-click
// offers the rest (a split, the folder, Finder, new tab).

import { useCallback, useContext, type ReactNode } from "react";
import Link from "next/link";
import { FilePathContext, filePathHref } from "../lib/filePathLinks";
import { openSessionChangedPath } from "../lib/sessionChangedFiles";
import { canOpenFilesBeside, openInEditor } from "../lib/filesPane";
import { requestFilePathMenu } from "../lib/filePathMenu";
import { useVaultStore } from "../store/vaultStore";
import { useTabContext } from "../lib/tabParams";

export function FilePathLink({
  path,
  line,
  column,
  children,
  className,
  onClick,
}: {
  path: string;
  line?: number;
  column?: number;
  children: ReactNode;
  className?: string;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const ctx = useContext(FilePathContext);
  const fromLeaf = useTabContext()?.leafId ?? null;
  const href = filePathHref(path, line, ctx, column);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if ((ctx?.foreign || useVaultStore.getState()?.connection === "no-daemon") && openSessionChangedPath(path, ctx)) {
        e.preventDefault();
        return;
      }
      if (!canOpenFilesBeside()) return; // the Link takes the tab there
      e.preventDefault();
      openInEditor({ path, line, column, ctx }, { fromLeaf });
    },
    [path, line, column, ctx, fromLeaf, onClick],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      requestFilePathMenu(e, { path, line, column, href, ctx, fromLeaf });
    },
    [path, line, column, href, ctx, fromLeaf],
  );

  return (
    <Link
      href={href}
      className={`fs-link${className ? ` ${className}` : ""}`}
      title={`Open ${path}${line ? `:${line}` : ""} in the editor`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {children}
    </Link>
  );
}

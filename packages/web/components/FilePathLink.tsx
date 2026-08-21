"use client";

// A mention of a local file or directory, rendered as a link into the Files
// surface. The parser (lib/remarkEntityIds → lib/filePathLinks) finds the
// mention; this component knows the conversation it sits in, so a relative
// path like `lib/pageLayout.tsx` resolves against that session's working
// directory before it leaves the page.
//
// Plain click opens the file BESIDE the conversation when the stage allows
// (lib/filesPane); modified clicks keep the Link compat's tab/window
// behaviour; right-click offers the rest (folder, Finder, new tab).

import { useCallback, useContext, type ReactNode } from "react";
import Link from "next/link";
import { FilePathContext, filePathHref } from "../lib/filePathLinks";
import { canOpenFilesBeside, openFilesBeside } from "../lib/filesPane";
import { requestFilePathMenu } from "../lib/filePathMenu";

export function FilePathLink({
  path,
  line,
  children,
  className,
  onClick,
}: {
  path: string;
  line?: number;
  children: ReactNode;
  className?: string;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const ctx = useContext(FilePathContext);
  const href = filePathHref(path, line, ctx);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!canOpenFilesBeside()) return; // the Link takes the tab there
      e.preventDefault();
      openFilesBeside(href);
    },
    [href, onClick],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      requestFilePathMenu(e, { path, line, href, ctx });
    },
    [path, line, href, ctx],
  );

  return (
    <Link
      href={href}
      className={`fs-link${className ? ` ${className}` : ""}`}
      title={`Open ${path} in Files`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {children}
    </Link>
  );
}

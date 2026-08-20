"use client";

// A mention of a local file or directory, rendered as a link into the Files
// surface. The parser (lib/remarkEntityIds → lib/filePathLinks) finds the
// mention; this component knows the conversation it sits in, so a relative
// path like `lib/pageLayout.tsx` resolves against that session's working
// directory before it leaves the page.

import { useContext, type ReactNode } from "react";
import Link from "next/link";
import { FilePathContext, filePathHref } from "../lib/filePathLinks";

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
  return (
    <Link
      href={href}
      className={`fs-link${className ? ` ${className}` : ""}`}
      title={`Open ${path} in Files`}
      onClick={onClick}
    >
      {children}
    </Link>
  );
}

"use client";
// A link to a goal, project, role or person at its address. Every reference
// that is not a pill (a map card's handle, a proposal's author, a role named
// in a role's settings) goes through here.
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { objectHref, type OrgObjectKind } from "@codecast/shared/entities";

export function OrgObjectLink({ kind, objRef, className, style, title, children, stop, ...data }: {
  kind: OrgObjectKind;
  /** The object's short ref (`or-7`, `pj-…`, `in-2`) or a person's handle. */
  objRef: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  children: ReactNode;
  /** The click is the link's alone (a card or a row around it has its own). */
  stop?: boolean;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <Link
      href={objectHref(kind, objRef)}
      onClick={stop ? (e) => e.stopPropagation() : undefined}
      className={className}
      style={style}
      title={title}
      {...data}
    >
      {children}
    </Link>
  );
}

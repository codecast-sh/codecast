"use client";
// A link to a goal, project, role or person that never leaves the Org screen
// (cohesive build spec §3.4, D5b, D15): inside the screen a plain click
// pushes the object's sheet and the conversation on the left stays put;
// outside it, or with a modifier held, it is the object's address. Every
// in-screen reference that is not a pill (a map card's handle, a proposal's
// author, a role named in a sheet's settings) goes through here.
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { objectHref, type OrgObjectKind } from "@codecast/shared/entities";
import { isPlainClick, useOrgOpen } from "./orgOpenContext";

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
  const ctx = useOrgOpen();
  return (
    <Link
      href={objectHref(kind, objRef)}
      onClick={(e) => {
        if (stop) e.stopPropagation();
        if (!ctx || !isPlainClick(e)) return;
        e.preventDefault();
        ctx.open(kind, objRef);
      }}
      className={className}
      style={style}
      title={title}
      {...data}
    >
      {children}
    </Link>
  );
}

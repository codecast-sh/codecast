import React from "react";
import { cn } from "../lib/utils";

// A short id (pl-754, ct-4102, jx7c6zk) is one token: it never breaks at its
// hyphen and never gives up width to a sibling in a flex row. Every surface
// that prints one bare goes through here.
export function ShortId({ id, className, ...rest }: { id?: string | null } & Omit<React.HTMLAttributes<HTMLSpanElement>, "id">) {
  if (!id) return null;
  return <span className={cn("font-mono whitespace-nowrap shrink-0", className)} {...rest}>{id}</span>;
}

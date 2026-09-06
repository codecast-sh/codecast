"use client";

import React, { createContext, useContext, useMemo } from "react";

// Which objects the surrounding chrome has ALREADY named.
//
// A "message from <session>" card names its sender in the header, so every
// mention of that sender inside the body is a repeat and renders compact,
// exactly as if the body had named it once already. The remark plugin counts
// mentions within one markdown body; this context carries the count across
// the header/body seam, which markdown cannot see.
const EstablishedRefs = createContext<ReadonlySet<string>>(new Set());

export function EstablishedRefsProvider({ ids, children }: { ids: Array<string | null | undefined>; children: React.ReactNode }) {
  const parent = useContext(EstablishedRefs);
  const key = ids.filter(Boolean).join(" ");
  const set = useMemo(() => {
    const next = new Set(parent);
    for (const id of key.split(" ")) if (id) next.add(id.trim().toLowerCase());
    return next;
  }, [parent, key]);
  return <EstablishedRefs.Provider value={set}>{children}</EstablishedRefs.Provider>;
}

/** True when the enclosing chrome already introduced this id. */
export function useIsEstablishedRef(id: string | null | undefined): boolean {
  const set = useContext(EstablishedRefs);
  return !!id && set.has(id.trim().toLowerCase());
}

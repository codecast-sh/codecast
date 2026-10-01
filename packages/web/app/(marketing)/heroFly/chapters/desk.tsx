"use client";

/**
 * What the desk chapters (inbox, conversation, fan out, anywhere) share: a
 * router of the hero's own, so the real views' links and location reads never
 * touch the visitor's page.
 */

import type { ReactNode } from "react";
import { MemoryRouter, UNSAFE_LocationContext } from "react-router";

/**
 * The views' `Link`s and `useLocation` calls get a memory router at "/inbox":
 * row highlights read the hero's location, and anything that still navigates
 * moves only this router. The page's own router is masked first, since a
 * router refuses to mount inside another.
 */
export function DeskRouter({ children }: { children: ReactNode }) {
  return (
    <UNSAFE_LocationContext.Provider value={null as never}>
      <MemoryRouter initialEntries={["/inbox"]}>{children}</MemoryRouter>
    </UNSAFE_LocationContext.Provider>
  );
}

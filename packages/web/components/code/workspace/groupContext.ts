// The editor group a component renders in. The code editor binds its view to
// the group (so workspace commands know which group a vim command came from,
// and the breadcrumbs know which view to read), and focuses itself only in the
// focused group. Outside a workspace there is no group and the editor behaves
// as a lone editor.

import { createContext, useContext } from "react";

export interface CodeGroupContextValue {
  /** Unique per mounted group (a workspace mounts its groups under its own
   *  instance key, so the same vault open in two panes never collides). */
  key: string;
  groupId: string;
  /** The workspace's focused group. */
  active: boolean;
}

export const CodeGroupContext = createContext<CodeGroupContextValue | null>(null);

export function useCodeGroup(): CodeGroupContextValue | null {
  return useContext(CodeGroupContext);
}

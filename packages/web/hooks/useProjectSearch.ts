import { useSyncExternalStore } from "react";
import { projectSearch, type ProjectSearchState } from "../lib/code/search/controller";

/** The controller's state, re-read whenever it notifies. */
export function useProjectSearch(): ProjectSearchState {
  useSyncExternalStore(projectSearch.subscribe, projectSearch.getVersion, projectSearch.getVersion);
  return projectSearch.get();
}

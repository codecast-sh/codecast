import type { KeyboardEvent } from "react";
import { projectSearch, type ProjectSearchState } from "./controller";
import type { ResultRow } from "./model";

/** Alt-C, Alt-W, Alt-R toggle case, word and regex from any search field
 *  (VS Code's keys; `code` because Option on a Mac types a character). */
export function handleSearchOptionKey(e: KeyboardEvent): boolean {
  if (!e.altKey || e.metaKey || e.ctrlKey) return false;
  const o = projectSearch.get().options;
  const flip = { KeyC: { caseSensitive: !o.caseSensitive }, KeyW: { word: !o.word }, KeyR: { regex: !o.regex } }[e.code];
  if (!flip) return false;
  e.preventDefault();
  projectSearch.set({ options: flip });
  projectSearch.rerun();
  return true;
}

/** Enter in the search box: open the selected match, else the first. */
export function openActiveOrFirst(state: ProjectSearchState): boolean {
  const matches = state.results?.matches() ?? [];
  const m = matches.find((x) => x.key === state.active) ?? matches[0];
  if (!m) return false;
  projectSearch.open(m as Extract<ResultRow, { kind: "match" }>);
  return true;
}

// The results editor as a workspace tab (lib/code/workspace/virtualTabs.ts):
// EditorGroup draws this for the search results tab, so it takes part in tabs,
// splits and Cmd-W like a file. The editor itself (CodeMirror, the
// multibuffer) loads only on first open.

import { lazy, Suspense, useState } from "react";

const SearchResultsEditor = lazy(() => import("./SearchResultsEditor"));

export function SearchResultsTab({ onClose }: { onClose(): void }) {
  // Bumped to build the editor again on the current search (Discard edits).
  const [generation, setGeneration] = useState(0);
  return (
    <Suspense fallback={null}>
      <SearchResultsEditor key={generation} onClose={onClose} onRebuild={() => setGeneration((g) => g + 1)} />
    </Suspense>
  );
}

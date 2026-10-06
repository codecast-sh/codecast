// Two runs side by side: GET /compare?a=&b=, diffRuns over
// both scores, both replies and both prompts.

import type { EvalsView } from "../../../client";
import { useEvalsHost, useEvalsPaths, useEvalsResource } from "../../hooks";
import { CompareView } from "../CompareView";

export function ComparePage({ view }: { view: Extract<EvalsView, { view: "compare" }> }) {
  const { EmptyState } = useEvalsHost().ui;
  const paths = useEvalsPaths();
  const res = useEvalsResource("GET /compare", { query: { a: view.a, b: view.b } });
  const data = res.data && res.data.a.id === view.a && res.data.b.id === view.b ? res.data : null;
  if (!data) {
    if (res.status === 404) {
      return <EmptyState title="One of these runs is not in the index" description={`${view.a} or ${view.b} names no run. Open a run and use "compare with" to pick a second rep.`} action={{ label: "Open the wall", href: paths.href.home() }} />;
    }
    if (res.error) return <EmptyState title="These two runs could not be read" description={res.error} />;
    return (
      <div className="ev-page ev-note" data-evals-page="compare" data-evals-loading>
        Reading both runs...
      </div>
    );
  }
  return (
    <div data-evals-page="compare">
      <CompareView data={data} />
    </div>
  );
}

// Two runs side by side: GET /compare?a=&b=, the platform's diffRuns over
// both scores, both replies and both prompts.

import { EmptyState } from "../../EmptyState";
import { useEvalsResource } from "../../../lib/evals/hooks";
import { evalsHref, type EvalsView } from "../evalsPaths";
import { CompareView } from "../CompareView";

export function ComparePage({ view }: { view: Extract<EvalsView, { view: "compare" }> }) {
  const res = useEvalsResource("GET /compare", { query: { a: view.a, b: view.b } });
  const data = res.data && res.data.a.id === view.a && res.data.b.id === view.b ? res.data : null;
  if (!data) {
    if (res.status === 404) {
      return <EmptyState title="One of these runs is not in the index" description={`${view.a} or ${view.b} names no run folder. Open a run and use "compare with" to pick a second rep.`} action={{ label: "Open the wall", href: evalsHref.home() }} />;
    }
    return (
      <div className="ev-page text-[12px] ev-quiet" data-evals-page="compare" data-evals-loading>
        {res.error ?? "Reading both runs..."}
      </div>
    );
  }
  return (
    <div data-evals-page="compare">
      <CompareView data={data} />
    </div>
  );
}

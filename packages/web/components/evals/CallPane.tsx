// One model call of a rep (`callN/`): the request it made, the system and user
// prompt the model saw, the reply, why it stopped, the tokens and the cost.
// Each prompt can be diffed against the same freeze in the previous prompt
// epoch, which is exactly what changed in what the model was shown. Codecast's
// own: the host renders it through useRunPanels (runPanels.tsx).

import type { CallDetail, TokenUsage } from "@codecast/shared/contracts/evalsApi";
import { usd } from "@platform/evals/client";
import { TextPane } from "@platform/evals/react";

const n = (v: number | null) => (v === null ? "n/a" : v.toLocaleString());

export function TokenLine({ tokens, costUsd, realMs }: { tokens: TokenUsage; costUsd: number; realMs?: number | null }) {
  return (
    <div className="ev-tokens" data-ev-tokens>
      <span>
        <b>{n(tokens.input)}</b> in
      </span>
      <span>
        <b>{n(tokens.output)}</b> out
      </span>
      <span>
        <b>{n(tokens.cacheRead)}</b> cache read
      </span>
      <span>
        <b>{n(tokens.cacheWrite)}</b> cache write
      </span>
      <span>
        <b>{usd(costUsd)}</b>
      </span>
      {realMs !== null && realMs !== undefined && (
        <span>
          <b>{(realMs / 1000).toFixed(1)}s</b> wall
        </span>
      )}
    </div>
  );
}

/** One call. A dry rep's call never reached a model: its reply is the prompt echoed back and its output tokens an estimate, so neither shows as real. */
export function CallPane({ call, runId, dry = false, previousEpochRun, previousWhy }: { call: CallDetail; runId: string; dry?: boolean; previousEpochRun: string | null; previousWhy?: string }) {
  const diff = (file: string) => ({ file, previous: previousEpochRun, current: runId, why: previousWhy });
  return (
    <section className="ev-card ev-call" data-ev-call={call.n}>
      <header className="ev-call-head">
        <span className="ev-title">Call {call.n}</span>
        <span className="ev-chip" title="Model">{call.request.model}</span>
        <span className="ev-chip" title="max_tokens">max_tokens {call.request.max_tokens.toLocaleString()}</span>
        <span className="ev-chip" title="Temperature the replay asked for">temperature {call.request.temperature ?? "default"}</span>
        {dry ? <span className="ev-chip" title="The tool rendered the request and called no model">dry render, no model called</span> : call.stopReason && <span className="ev-chip" title="Why the model stopped">{call.stopReason}</span>}
        {call.isError && <span className="ev-chip ev-chip--live">the call errored</span>}
      </header>
      {call.harnessFailure && <div className="ev-judge" style={{ borderLeftColor: "var(--ev-magenta)" }}>{call.harnessFailure}</div>}
      {!dry && <TokenLine tokens={call.tokens} costUsd={call.costUsd} realMs={call.realMs} />}
      {call.system !== null && <TextPane name={`${call.dir}/system.md`} text={call.system} diff={diff(`${call.dir}/system.md`)} />}
      <TextPane name={`${call.dir}/prompt.md`} text={call.prompt} diff={diff(`${call.dir}/prompt.md`)} />
      {dry ? <div className="ev-empty-note" data-ev-dry-reply>No reply: a dry render stops before the model. The prompt above is exactly what a live rep sends.</div> : <TextPane name="reply" text={call.reply} open reply />}
    </section>
  );
}

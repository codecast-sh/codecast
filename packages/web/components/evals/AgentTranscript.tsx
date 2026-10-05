// An agent rep (`agentN/`): the brief it opened on, every turn as text,
// thinking and tool calls read from stream.jsonl, the follow-up turns the
// harness sent (thenN.md), what the agent said out loud, and the knobs the
// dry run used (args.json).

import type { AgentDetail, AgentItem } from "@codecast/shared/contracts/evalsApi";
import { TokenLine } from "./CallPane";
import { TextPane } from "./parts";

function toolInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return o.command;
    if (typeof o.file_path === "string") return o.file_path;
    if (typeof o.pattern === "string") return o.pattern;
  }
  return typeof input === "string" ? input : JSON.stringify(input);
}

function Item({ item }: { item: AgentItem }) {
  if (item.kind === "text") return <div className="ev-item-text">{item.text}</div>;
  if (item.kind === "thinking") return <div className="ev-item-think">{item.text}</div>;
  return (
    <div className={`ev-tool${item.isError ? " ev-tool--error" : ""}`} data-ev-tool={item.name}>
      <div className="ev-tool-call">
        <span className="ev-tool-name">{item.name}</span>
        <span className="min-w-0 break-all">{toolInput(item.input)}</span>
      </div>
      {item.output !== null && <pre className="ev-tool-out">{item.output || "(no output)"}</pre>}
    </div>
  );
}

const argWords = (v: unknown) => (v === null || v === undefined ? "none" : Array.isArray(v) ? v.join(", ") || "none" : String(v));

export function AgentTranscript({ agent, runId, previousEpochRun, previousWhy }: { agent: AgentDetail; runId: string; previousEpochRun: string | null; previousWhy?: string }) {
  const diff = (file: string) => ({ file, previous: previousEpochRun, current: runId, why: previousWhy });
  return (
    <div className="flex flex-col gap-3" data-ev-agent={agent.n}>
      <div className="ev-call-head">
        <span className="ev-title">Agent {agent.n}</span>
        <span className="ev-chip" title="Model">{agent.model}</span>
        <span className="ev-chip">{agent.turns.length} turn{agent.turns.length === 1 ? "" : "s"}</span>
      </div>
      <TokenLine tokens={agent.tokens} costUsd={agent.costUsd} />
      {agent.brief !== null && <TextPane name="brief.md" text={agent.brief} />}
      <TextPane name={`${agent.dir}/prompt.md`} text={agent.prompt} diff={diff(`${agent.dir}/prompt.md`)} />
      <section className="ev-card overflow-hidden" data-ev-turns>
        {agent.turns.map((items, i) => (
          <div key={i} className="ev-turn" data-ev-turn={i + 1}>
            <span className="ev-turn-n">turn {i + 1}</span>
            <div className="ev-turn-items">
              {i > 0 && agent.then[i - 1] !== undefined && (
                <div className="ev-turn-ask" title={`${agent.dir}/then${i + 1}.md: what the harness sent into the same session`}>
                  {agent.then[i - 1]}
                </div>
              )}
              {items.length ? items.map((item, j) => <Item key={j} item={item} />) : <span className="ev-quiet text-[12px]">Nothing recorded for this turn.</span>}
            </div>
          </div>
        ))}
        {!agent.turns.length && <div className="ev-empty-note">stream.jsonl holds no turns.</div>}
      </section>
      {agent.then.map((t, i) => (
        <TextPane key={i} name={`${agent.dir}/then${i + 2}.md`} text={t} diff={diff(`${agent.dir}/then${i + 2}.md`)} />
      ))}
      {agent.said.length > 0 && (
        <section className="ev-section">
          <h2 className="ev-title">What it said out loud</h2>
          {agent.said.map((s, i) => (
            <TextPane key={i} name={`said ${i + 1}`} text={s} open={i === agent.said.length - 1} reply />
          ))}
        </section>
      )}
      <section className="ev-section">
        <h2 className="ev-title">args.json</h2>
        <dl className="ev-card ev-args" data-ev-args>
          <dt>model</dt>
          <dd>{agent.args.model}</dd>
          <dt>serve</dt>
          <dd>{argWords(agent.args.serve)}</dd>
          <dt>guard</dt>
          <dd>{argWords(agent.args.guard)}</dd>
          <dt>tools</dt>
          <dd>{argWords(agent.args.tools)}</dd>
          <dt>maxTurns</dt>
          <dd>{argWords(agent.args.maxTurns)}</dd>
          <dt>maxOutputTokens</dt>
          <dd>{argWords(agent.args.maxOutputTokens)}</dd>
          <dt>one call</dt>
          <dd>{agent.args.call ? "yes (--call)" : "no, an agent"}</dd>
        </dl>
      </section>
    </div>
  );
}

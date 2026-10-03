// One model call of a rep (`callN/`): the request it made, the system and user
// prompt the model saw, the reply, why it stopped, the tokens and the cost.
// Each prompt can be diffed against the same freeze in the previous prompt
// epoch, which is exactly what changed in what the model was shown.

import { useState, type ReactNode } from "react";
import { Check, Copy, GitCompare } from "lucide-react";
import { toast } from "sonner";
import type { CallDetail, TokenUsage } from "@codecast/shared/contracts/evalsApi";
import { copyToClipboard } from "../../lib/utils";
import { PromptDiff, usd } from "./parts";

export function Caret() {
  return (
    <svg className="ev-caret" viewBox="0 0 12 12" aria-hidden>
      <path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const sizeWords = (text: string) => {
  const lines = text.split("\n").length;
  return `${lines.toLocaleString()} line${lines === 1 ? "" : "s"}, ${text.length.toLocaleString()} chars`;
};

/** A small copy button; the text it copies shows on hover. */
export function CopyButton({ text, what, label = "copy", icon }: { text: string; what: string; label?: string; icon?: ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ev-btn"
      aria-label={`Copy ${what}`}
      title={text.length <= 200 ? text : undefined}
      onClick={async (e) => {
        e.preventDefault();
        await copyToClipboard(text);
        setDone(true);
        toast.success("Copied");
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check /> : icon ?? <Copy />} {label}
    </button>
  );
}

/**
 * A collapsible text file: its name, its size and a copy button on the fold,
 * its text below. `diff` adds the "against the previous epoch" toggle: the
 * button is there whenever the file is a prompt, disabled with its reason when
 * no earlier epoch ran this freeze.
 */
export function TextPane({ name, text, open = false, reply = false, diff, tools }: { name: string; text: string; open?: boolean; reply?: boolean; diff?: { file: string; previous: string | null; current: string; why?: string }; tools?: ReactNode }) {
  const [diffing, setDiffing] = useState(false);
  return (
    <details className="ev-pane" open={open} data-ev-pane={name}>
      <summary>
        <Caret />
        <span className="ev-pane-name">{name}</span>
        <span className="ev-pane-size">{sizeWords(text)}</span>
        <span className="ev-pane-tool">
          {tools}
          {diff && (
            <button
              type="button"
              className="ev-btn"
              aria-pressed={diffing}
              disabled={!diff.previous}
              title={diff.previous ? "What changed in this file since the previous prompt epoch, on the same freeze" : diff.why ?? "No earlier prompt epoch ran this freeze"}
              onClick={(e) => {
                e.preventDefault();
                setDiffing((d) => !d);
              }}
            >
              <GitCompare /> diff against the previous epoch
            </button>
          )}
          <CopyButton text={text} what={name} />
        </span>
      </summary>
      {diffing && diff?.previous ? (
        <div style={{ borderTop: "1px solid var(--ev-rule)" }}>
          <PromptDiff a={diff.previous} b={diff.current} file={diff.file} />
        </div>
      ) : (
        <pre className={`ev-pane-text${reply ? " ev-pane-text--reply" : ""}`}>{text}</pre>
      )}
    </details>
  );
}

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

export function CallPane({ call, runId, previousEpochRun, previousWhy }: { call: CallDetail; runId: string; previousEpochRun: string | null; previousWhy?: string }) {
  const diff = (file: string) => ({ file, previous: previousEpochRun, current: runId, why: previousWhy });
  return (
    <section className="ev-card ev-call" data-ev-call={call.n}>
      <header className="ev-call-head">
        <span className="ev-title">Call {call.n}</span>
        <span className="ev-chip" title="Model">{call.request.model}</span>
        <span className="ev-chip" title="max_tokens">max_tokens {call.request.max_tokens.toLocaleString()}</span>
        <span className="ev-chip" title="Temperature the replay asked for">temperature {call.request.temperature ?? "default"}</span>
        {call.stopReason && <span className="ev-chip" title="Why the model stopped">{call.stopReason}</span>}
        {call.isError && <span className="ev-chip ev-chip--live">the call errored</span>}
      </header>
      {call.harnessFailure && <div className="ev-judge" style={{ borderLeftColor: "var(--sol-magenta)" }}>{call.harnessFailure}</div>}
      <TokenLine tokens={call.tokens} costUsd={call.costUsd} realMs={call.realMs} />
      {call.system !== null && <TextPane name={`${call.dir}/system.md`} text={call.system} diff={diff(`${call.dir}/system.md`)} />}
      <TextPane name={`${call.dir}/prompt.md`} text={call.prompt} diff={diff(`${call.dir}/prompt.md`)} />
      <TextPane name="reply" text={call.reply} open reply />
    </section>
  );
}

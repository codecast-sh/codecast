import { useMemo, useState } from "react";
import { Braces, SquareCheck } from "lucide-react";
import { structuredPayloadKeysFromRaw, structuredResultModel, type StructuredField, type StructuredRecord, type StructuredSection, type StructuredTone } from "@codecast/shared/render";
import { entityRemarkPlugins } from "../../../lib/remarkEntityIds";
import { MESSAGE_MD_COMPONENTS, MESSAGE_MD_REHYPE } from "../../messageMarkdown";
import { FilePathLink } from "../../FilePathLink";
import { renderAnsi, safeString } from "../../../lib/conversationFormat";
import { failureLine } from "../../../lib/modernRow";
import { useIsModernStyle } from "../../../hooks/useVisualStyle";
import { ReactMarkdown } from "../markdown";
import { Button } from "../../ui/button";
import { ModernQuietBlock } from "./ModernQuietBlock";
import type { ToolCall, ToolResult } from "../types";

// ── StructuredOutput (a workflow subagent's typed result) ───────────────────
// The payload is what the whole session was run to produce, so it reads as the
// session's result: the status as a pill, prose as prose, findings as rows with
// their file, lists as lists (structuredResultModel decides from the shape).
// The raw JSON stays one press away. A rejected payload (schema validation) is
// the error the agent saw; it retries, and the next call carries the result.

const RESULT_TONE: Record<StructuredTone, { pill: string; frame: string; text: string }> = {
  good: { pill: "bg-sol-green/15 border-sol-green/35 text-sol-green", frame: "border-sol-green/30 bg-sol-green/[0.04]", text: "text-sol-green" },
  warn: { pill: "bg-sol-yellow/15 border-sol-yellow/35 text-sol-yellow", frame: "border-sol-yellow/30 bg-sol-yellow/[0.04]", text: "text-sol-yellow" },
  bad: { pill: "bg-sol-red/15 border-sol-red/35 text-sol-red", frame: "border-sol-red/30 bg-sol-red/[0.05]", text: "text-sol-red" },
  neutral: { pill: "bg-sol-bg-alt border-sol-border/50 text-sol-text-muted", frame: "border-sol-cyan/25 bg-sol-cyan/[0.04]", text: "text-sol-cyan" },
};

function ResultProse({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none text-sol-text break-words ${className}`}>
      <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MESSAGE_MD_COMPONENTS}>{text}</ReactMarkdown>
    </div>
  );
}

function ResultPill({ text, tone }: { text: string; tone: StructuredTone }) {
  return <span className={`px-1.5 py-px rounded border text-mark font-semibold uppercase tracking-wide whitespace-nowrap ${RESULT_TONE[tone].pill}`}>{text.replace(/_/g, " ")}</span>;
}

function ResultFields({ fields }: { fields: StructuredField[] }) {
  return (
    <>
      {fields.map((f) => (
        // A long value wraps inside the card instead of being clipped by it.
        <span key={f.label} className="text-meta min-w-0 break-words">
          <span className="text-sol-text-dim whitespace-nowrap">{f.label} </span>
          <span className={f.tone ? RESULT_TONE[f.tone].text : "text-sol-text-muted"}>{f.value}</span>
        </span>
      ))}
    </>
  );
}

function ResultRecord({ rec }: { rec: StructuredRecord }) {
  return (
    <li className="flex gap-2.5 py-2 first:pt-1 last:pb-0.5">
      {rec.badge && <span className="shrink-0 pt-0.5"><ResultPill text={rec.badge.text} tone={rec.badge.tone} /></span>}
      <div className="min-w-0 flex-1 space-y-1">
        {rec.location && (
          <FilePathLink path={rec.location.path} line={rec.location.line} className="block font-mono text-meta text-sol-text-dim hover:text-sol-blue truncate">
            {rec.location.display}
          </FilePathLink>
        )}
        {rec.title && <ResultProse text={rec.title} />}
        {rec.texts.map((t) => (
          <div key={t.label} className="flex gap-2 text-sol-text-muted">
            <span className="shrink-0 text-meta text-sol-text-dim pt-0.5">{t.label}</span>
            <ResultProse text={t.text} className="text-sol-text-muted" />
          </div>
        ))}
        {rec.fields.length > 0 && <div className="flex flex-wrap gap-x-3 gap-y-0.5"><ResultFields fields={rec.fields} /></div>}
      </div>
    </li>
  );
}

function ResultSection({ section }: { section: StructuredSection }) {
  const count = section.kind === "records" || section.kind === "list" ? section.items.length : undefined;
  return (
    <section>
      <div className="flex items-baseline gap-1.5 mb-1">
        <span className="text-meta font-semibold text-sol-text-muted">{section.label}</span>
        {count !== undefined && <span className="text-meta tabular-nums text-sol-text-dim">{count || "none"}</span>}
      </div>
      {section.kind === "text" ? (
        <ResultProse text={section.text} />
      ) : section.kind === "fields" ? (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5"><ResultFields fields={section.fields} /></div>
      ) : section.kind === "list" ? (
        count ? (
          <ul className={`space-y-0.5 ${section.paths ? "" : "list-disc pl-4 marker:text-sol-text-dim"}`}>
            {section.items.map((item, i) => (
              <li key={i} className={section.paths ? "font-mono text-meta text-sol-text-muted truncate" : "text-sm text-sol-text"}>
                {section.paths ? <FilePathLink path={item} className="hover:text-sol-blue">{item}</FilePathLink> : <ResultProse text={item} />}
              </li>
            ))}
          </ul>
        ) : null
      ) : count ? (
        <ul className="divide-y divide-sol-border/25">
          {section.items.map((rec, i) => <ResultRecord key={i} rec={rec} />)}
        </ul>
      ) : null}
    </section>
  );
}

export function StructuredResultBlock({ tool, result }: { tool: ToolCall; result?: ToolResult }) {
  const [showJson, setShowJson] = useState(false);
  const modern = useIsModernStyle();
  // Partial JSON while the call streams in fails to parse: the card waits.
  const payload = useMemo(() => {
    try {
      const p = JSON.parse(tool.input);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }, [tool.input]);
  const model = useMemo(() => (payload ? structuredResultModel(payload) : null), [payload]);
  const rejected = !!result?.is_error;
  const tone: StructuredTone = rejected ? "bad" : model?.status?.tone ?? "neutral";
  const t = RESULT_TONE[tone];
  if (modern) return <ModernStructuredResult tool={tool} result={result} payload={payload} model={model} showJson={showJson} onToggleJson={() => setShowJson((v) => !v)} />;

  return (
    <div data-cc-feed-card data-structured-result className={`my-2 rounded-lg border ${t.frame} overflow-hidden`}>
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        <SquareCheck className={`w-3.5 h-3.5 shrink-0 ${t.text}`} />
        <span className={`text-xs font-semibold ${t.text}`}>{rejected ? "Result rejected" : "Result"}</span>
        {model?.status && !rejected && <ResultPill text={model.status.text} tone={model.status.tone} />}
        {model && !rejected && <ResultFields fields={model.fields} />}
        {!payload && !rejected && <span className="text-meta text-sol-text-dim">{structuredPayloadKeysFromRaw(tool.input) || "returning a result"}</span>}
        {payload && (
          <button
            type="button"
            onClick={() => setShowJson((v) => !v)}
            aria-pressed={showJson}
            className={`ml-auto text-meta font-mono px-1.5 py-0.5 rounded border transition-colors ${showJson ? "border-sol-cyan/40 text-sol-cyan bg-sol-cyan/10" : "border-sol-border/40 text-sol-text-dim hover:text-sol-text-muted"}`}
          >
            JSON
          </button>
        )}
      </div>
      {rejected && result?.content && (
        <pre className="px-3 pb-2 text-xs font-mono whitespace-pre-wrap break-words text-sol-red">{renderAnsi(safeString(result.content))}</pre>
      )}
      {showJson && payload ? (
        <div className="max-h-96 overflow-auto px-3 pb-2">
          <ResultProse text={"```json\n" + JSON.stringify(payload, null, 2) + "\n```"} />
        </div>
      ) : model && !rejected && model.sections.length > 0 ? (
        <div className="px-3 pb-3 pt-1 space-y-3">
          {model.sections.map((s) => <ResultSection key={s.label} section={s} />)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The result in the Modern style: content a person reads, so a quiet block
 * (ModernQuietBlock). The header is "Result" with the verdict at its right in
 * its tone; the panel holds the fields, the sections and, one press away at
 * its foot, the raw JSON. A rejected payload is a red row whose panel is the
 * error the agent saw.
 */
function ModernStructuredResult({ tool, result, payload, model, showJson, onToggleJson }: {
  tool: ToolCall;
  result?: ToolResult;
  payload: Record<string, unknown> | null;
  model: ReturnType<typeof structuredResultModel> | null;
  showJson: boolean;
  onToggleJson: () => void;
}) {
  const rejected = !!result?.is_error;
  const status = model?.status && !rejected ? model.status : null;
  const body = rejected ? (
    result?.content ? <pre className="text-meta font-mono whitespace-pre-wrap break-words text-sol-red">{renderAnsi(safeString(result.content))}</pre> : null
  ) : showJson && payload ? (
    <ResultProse text={"```json\n" + JSON.stringify(payload, null, 2) + "\n```"} />
  ) : model && (model.fields.length > 0 || model.sections.length > 0) ? (
    <div className="space-y-3">
      {model.fields.length > 0 && <div className="flex flex-wrap gap-x-3 gap-y-0.5"><ResultFields fields={model.fields} /></div>}
      {model.sections.map((s) => <ResultSection key={s.label} section={s} />)}
    </div>
  ) : null;
  return (
    <ModernQuietBlock
      family="result"
      data-structured-result
      icon={SquareCheck}
      label={rejected ? "Result rejected" : "Result"}
      tone={rejected ? "error" : undefined}
      text={payload ? undefined : structuredPayloadKeysFromRaw(tool.input) || "returning a result"}
      status={rejected ? failureLine(result?.content) || "rejected" : status ? status.text.replace(/_/g, " ") : undefined}
      statusClass={status ? `font-medium ${RESULT_TONE[status.tone].text}` : ""}
      watch={`${tool.input}${showJson}`}
      footer={payload && !rejected ? (
        <Button type="button" size="sm" variant="ghost" aria-pressed={showJson} onClick={onToggleJson} title={showJson ? "Show the result" : "Show the raw JSON"}>
          <Braces aria-hidden />JSON
        </Button>
      ) : undefined}
    >
      {body}
    </ModernQuietBlock>
  );
}

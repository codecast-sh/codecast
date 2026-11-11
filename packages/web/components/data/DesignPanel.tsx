// Design: redo the dashboard in another format on the same blocks and data.
// Picking a format writes it into the doc's draft at once (so the person sees
// the story immediately, built from the blocks and a summary of live KPI
// values), and can hand the draft to an agent to write the headline, the
// summary and a line per step. Save or Discard on the draft bar settles it.
import { Bot } from "lucide-react";
import { dashboard, type ArtifactElement, type ArtifactOp } from "@codecast/shared/artifacts";
import { PanelShell, Field } from "./CheckPanel";
import { useCommittedDraft } from "./ArgsEditor";
import { pickAskTarget, sendAsk, type AskDoc } from "../live/AskAgentControl";

const FORMATS: Array<{ id: dashboard.StoryFormat; label: string; art: React.ReactNode }> = [
  {
    id: "dashboard",
    label: "Dashboard",
    art: (
      <svg viewBox="0 0 120 68" className="w-full h-full">
        <rect x="8" y="8" width="24" height="14" rx="3" className="fill-current opacity-30" />
        <rect x="36" y="8" width="24" height="14" rx="3" className="fill-current opacity-30" />
        <rect x="64" y="8" width="24" height="14" rx="3" className="fill-current opacity-30" />
        <rect x="92" y="8" width="20" height="14" rx="3" className="fill-current opacity-30" />
        <rect x="8" y="26" width="52" height="34" rx="3" className="fill-current opacity-20" />
        <polyline points="12,52 22,46 32,48 42,38 56,32" className="stroke-current" fill="none" strokeWidth="2" />
        <rect x="64" y="26" width="48" height="34" rx="3" className="fill-current opacity-20" />
        <rect x="68" y="32" width="34" height="5" rx="2" className="fill-current opacity-70" />
        <rect x="68" y="41" width="24" height="5" rx="2" className="fill-current opacity-40" />
        <rect x="68" y="50" width="16" height="5" rx="2" className="fill-current opacity-40" />
      </svg>
    ),
  },
  {
    id: "scrolly",
    label: "Scrollyteller",
    art: (
      <svg viewBox="0 0 120 68" className="w-full h-full">
        <rect x="10" y="12" width="34" height="6" rx="2" className="fill-current opacity-80" />
        <rect x="10" y="22" width="28" height="3" rx="1.5" className="fill-current opacity-35" />
        <rect x="10" y="28" width="30" height="3" rx="1.5" className="fill-current opacity-35" />
        <rect x="52" y="8" width="58" height="52" rx="4" className="fill-current opacity-20" />
        <polyline points="58,50 70,44 80,46 92,32 104,22" className="stroke-current" fill="none" strokeWidth="2" />
        <rect x="114" y="10" width="2" height="48" rx="1" className="fill-current opacity-20" />
        <rect x="114" y="16" width="2" height="14" rx="1" className="fill-current opacity-70" />
      </svg>
    ),
  },
  {
    id: "short",
    label: "Visual short",
    art: (
      <svg viewBox="0 0 120 68" className="w-full h-full">
        <rect x="10" y="8" width="100" height="46" rx="4" className="fill-current opacity-20" />
        <rect x="20" y="36" width="8" height="12" rx="1.5" className="fill-current opacity-45" />
        <rect x="32" y="28" width="8" height="20" rx="1.5" className="fill-current opacity-45" />
        <rect x="44" y="20" width="8" height="28" rx="1.5" className="fill-current opacity-80" />
        <circle cx="80" cy="31" r="10" className="fill-current opacity-35" />
        <path d="M77 26 L85 31 L77 36 Z" className="fill-current" />
        <rect x="10" y="59" width="30" height="2.5" rx="1.25" className="fill-current opacity-80" />
        <rect x="42" y="59" width="30" height="2.5" rx="1.25" className="fill-current opacity-25" />
        <rect x="74" y="59" width="36" height="2.5" rx="1.25" className="fill-current opacity-25" />
      </svg>
    ),
  },
];

/** A first summary built from the KPIs' live values: "{b_x} spend · {b_y} sessions". */
export function autoSummary(elements: readonly ArtifactElement[]): string | undefined {
  const kpis = dashboard.orderedBlocks(elements).filter((b) => b.kind === "kpi" && b.title).slice(0, 3);
  if (!kpis.length) return undefined;
  return kpis.map((b) => `{${b.key}} ${String(b.title).toLowerCase()}`).join(" · ");
}

export function storyPrompt(format: dashboard.StoryFormat): string {
  const name = format === "scrolly" ? "a Scrollyteller" : "a Visual short";
  return [
    `Redo this dashboard as ${name}, on the same data. The format is already set in the draft; write the story into it:`,
    `1. \`cast data story <doc> ${format} --headline "<short, concrete claim the data supports>" --summary "<one sentence built from {b_key} values>"\`.`,
    `2. For each block worth a step, \`cast data say <doc> <key> "<what it shows, as a claim>" "<one line of evidence with {b_key} values>"\`; \`--skip\` the rest. Lead with the numbers, then the trend that explains them.`,
    "3. Never type a number: reference KPIs as {b_key} so every figure stays live and checked. Add a KPI first if a figure you need has none.",
    "4. Run `cast data check <doc>` and fix anything broken. Leave the draft for the person to Save.",
  ].join("\n");
}

export function DesignPanel({
  doc,
  format,
  elements,
  canEdit,
  writeDraft,
  write,
  onClose,
}: {
  doc: AskDoc;
  format: dashboard.StoryFormat;
  elements: ArtifactElement[];
  canEdit: boolean;
  writeDraft: (ops: ArtifactOp[]) => void;
  /** Writes where edits go now: the open draft, else the dashboard. */
  write: (ops: ArtifactOp[]) => void;
  onClose: () => void;
}) {
  const layoutEl = elements.find((e) => e.key === dashboard.LAYOUT_KEY);
  const setLayout = (fields: Record<string, string | null>) =>
    write([layoutEl ? { k: dashboard.LAYOUT_KEY, set: fields } : { k: dashboard.LAYOUT_KEY, put: { kind: "layout", format: format, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null)) } as any }]);
  const pick = (f: dashboard.StoryFormat) => {
    if (!canEdit || f === format) return;
    const layout = elements.find((e) => e.key === dashboard.LAYOUT_KEY);
    const summary = layout?.summary ? undefined : autoSummary(elements);
    const fields = { format: f, ...(summary && f !== "dashboard" ? { summary } : {}) };
    writeDraft([layout ? { k: dashboard.LAYOUT_KEY, set: fields } : { k: dashboard.LAYOUT_KEY, put: { kind: "layout", ...fields } }]);
  };
  const ask = () =>
    pickAskTarget("Who writes the story?", (target) => {
      sendAsk(doc, { prompt: storyPrompt(format === "dashboard" ? "scrolly" : format), draft: true }, target);
    });
  return (
    <PanelShell title="Design" onClose={onClose}>
      <div className="grid grid-cols-1 gap-2" role="radiogroup" aria-label="Format">
        {FORMATS.map((f) => {
          const on = f.id === format;
          return (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!canEdit}
              onClick={() => pick(f.id)}
              data-format-pick={f.id}
              className={`group flex items-center gap-3 rounded-xl border p-2 text-left transition-colors disabled:opacity-50 ${on ? "border-sol-blue bg-sol-blue/10" : "border-sol-border/50 hover:border-sol-border hover:bg-sol-bg-alt/50"}`}
            >
              <span className={`w-[96px] h-[54px] rounded-lg bg-sol-bg-alt/70 p-1 shrink-0 ${on ? "text-sol-blue" : "text-sol-text-muted group-hover:text-sol-text-secondary"}`}>{f.art}</span>
              <span className={`text-sm font-medium ${on ? "text-sol-blue" : "text-sol-text"}`}>{f.label}</span>
            </button>
          );
        })}
      </div>
      {canEdit ? (
        <Field label="Words">
          <LayoutText label="Headline" value={String(layoutEl?.headline ?? "")} placeholder={doc.title} onCommit={(v) => setLayout({ headline: v || null })} />
          <LayoutText label="Summary" value={String(layoutEl?.summary ?? "")} placeholder="{b_key} so far, {b_key.delta} on last week" multiline onCommit={(v) => setLayout({ summary: v || null })} />
        </Field>
      ) : null}
      {format !== "dashboard" && canEdit ? (
        <button type="button" onClick={ask} data-ask-story className="w-full inline-flex items-center justify-center gap-2 h-8 rounded-md text-sm font-medium bg-sol-text text-sol-bg hover:opacity-90">
          <Bot className="w-4 h-4" /> Ask an agent to write it
        </button>
      ) : null}
    </PanelShell>
  );
}

function LayoutText({ label, value, placeholder, multiline, onCommit }: { label: string; value: string; placeholder?: string; multiline?: boolean; onCommit: (v: string) => void }) {
  const { draft, setDraft, onFocus, onBlur } = useCommittedDraft(value);
  const props = {
    value: draft,
    placeholder,
    "aria-label": label,
    onFocus,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => {
      onBlur();
      if (draft !== value) onCommit(draft.trim());
    },
    className: "w-full rounded-md bg-sol-bg border border-sol-border/60 px-2 py-1.5 text-sm text-sol-text outline-none focus:border-sol-blue",
  };
  return (
    <label className="block space-y-1 mt-2">
      <span className="text-meta text-sol-text-dim">{label}</span>
      {multiline ? <textarea {...props} rows={3} className={`${props.className} resize-y leading-6`} /> : <input {...props} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />}
    </label>
  );
}

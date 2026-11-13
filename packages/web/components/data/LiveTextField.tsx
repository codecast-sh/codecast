// Prose that may hold live values: a text block, a summary, a story line.
// "Live value" inserts a KPI's value, change or direction at the caret as a
// token, so nobody types an internal key. Words that type a number or state
// a direction outside a token are refused on save, the same rule the CLI
// applies, since they go wrong the day the data turns.
import { useRef, useState } from "react";
import { Hash } from "lucide-react";
import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import { useCommittedDraft } from "../../hooks/useCommittedDraft";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { held, textRefusal } from "./liveTextDrafts";

const PARTS = [
  { part: "", label: "Value" },
  { part: ".delta", label: "Change" },
  { part: ".trend", label: "Direction" },
  { part: ".vs", label: "Compared with" },
] as const;

/** The text as a reader sees it: each token drawn as its value today, so the box's raw keys are never the only view. */
function ReadsAs({ text, preview }: { text: string; preview: (key: string, part: dashboard.TokenPart) => string }) {
  const parts = text.split(/(\{b_[A-Za-z0-9_]+(?:\.(?:value|delta|trend|vs))?\})/);
  if (parts.length < 2) return null;
  return (
    <div className="text-meta text-sol-text-muted break-words" data-reads-as>
      {parts.map((p, i) => {
        const m = p.match(/^\{(b_[A-Za-z0-9_]+)(?:\.(value|delta|trend|vs))?\}$/);
        if (!m) return <span key={i}>{p}</span>;
        return (
          <span key={i} className="px-1 rounded bg-sol-blue/10 text-sol-text">
            {preview(m[1], (m[2] ?? "value") as dashboard.TokenPart) || "…"}
          </span>
        );
      })}
    </div>
  );
}

export function LiveTextField({ label, value, kpis, multiline, placeholder, onCommit, holdKey, preview }: { label: string; value: unknown; kpis: ArtifactElement[]; multiline?: boolean; placeholder?: string; onCommit: (v: string) => void; holdKey?: string; preview?: (key: string, part: dashboard.TokenPart) => string }) {
  const shown = value === undefined || value === null ? "" : String(value);
  const keys = kpis.map((k) => k.key);
  const problem = (v: string) => textRefusal(v, keys);
  const { draft, setDraft: setDraftRaw, onFocus, onBlur } = useCommittedDraft(shown);
  // Saved after a pause in typing, not only on blur: leaving the page or reloading never drops what was typed. One write per pause keeps typing cheap.
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCommit = useRef<(v: string) => void>(() => {});
  useMountEffect(() => () => {
    if (idle.current) clearTimeout(idle.current);
  });
  // Every keystroke is kept (synchronously, so a reload a moment after typing keeps it) until the saved value catches up or the field is emptied.
  const setDraft = (v: string) => {
    setDraftRaw(v);
    if (holdKey) held.set(holdKey, v);
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => latestCommit.current(v), 900);
  };
  useMountEffect(() => {
    const kept = holdKey ? held.get(holdKey) : undefined;
    if (kept === undefined || kept === shown) return;
    setDraftRaw(kept);
    // Words typed before a reload that never reached the save go out now; refused words stay held, with their refusal showing.
    idle.current = setTimeout(() => latestCommit.current(kept), 0);
  });
  useWatchEffect(() => {
    if (holdKey && held.get(holdKey) === shown) held.delete(holdKey);
  }, [shown, holdKey]);
  const box = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const error = problem(draft);
  const commit = (v: string) => !problem(v) && v !== shown && onCommit(v);
  latestCommit.current = commit;

  const insert = (token: string) => {
    const at = caret.current ?? draft.length;
    const before = draft.slice(0, at);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${pad}${token}${draft.slice(at)}`;
    setDraft(next);
    setOpen(false);
    commit(next);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      const pos = at + pad.length + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const props = {
    ref: box,
    value: draft,
    placeholder,
    "aria-label": label,
    "aria-invalid": error ? true : undefined,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => setDraft(e.target.value),
    onFocus,
    onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      caret.current = e.currentTarget.selectionStart;
    },
    onBlur: (e: React.FocusEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      caret.current = e.target.selectionStart;
      onBlur();
      commit(draft);
    },
    className: `w-full rounded-md bg-sol-bg border px-2 text-sm text-sol-text outline-none focus:border-sol-blue ${error ? "border-sol-red/70" : "border-sol-border/60"} ${multiline ? "py-1.5 resize-y leading-6" : "h-8"}`,
  };

  return (
    <div className="space-y-1" data-live-text-field>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-meta text-sol-text-dim">{label}</span>
        {kpis.length ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button type="button" onMouseDown={(e) => e.preventDefault()} className="inline-flex items-center gap-1 h-6 px-1.5 rounded text-meta text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt">
                <Hash className="w-3 h-3" /> Live value
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-1.5" onOpenAutoFocus={(e) => e.preventDefault()}>
              <div className="max-h-72 overflow-y-auto">
                {kpis.map((k) => (
                  <div key={k.key} className="px-1 py-1 border-b border-sol-border/30 last:border-0">
                    <div className="px-1 text-xs font-medium text-sol-text break-words">{String(k.title || k.key)}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {/* A KPI with no comparison has only its value: a change, direction or "compared with" would read empty. */}
                      {(k.compare ? PARTS : PARTS.slice(0, 1)).map((p) => {
                        // Each part shows what it would read as today, so the right one is picked by its words, not its name.
                        const now = preview?.(k.key, p.part ? (p.part.slice(1) as dashboard.TokenPart) : "value");
                        return (
                          <button key={p.part} type="button" onClick={() => insert(`{${k.key}${p.part}}`)} title={p.label} className="h-6 px-1.5 rounded text-meta text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt max-w-full truncate" data-insert-token={`${k.key}${p.part}`}>
                            {now || p.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      {multiline ? <textarea {...props} rows={4} /> : <input {...props} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />}
      {preview && !error ? <ReadsAs text={draft} preview={preview} /> : null}
      {error ? <span className="block text-meta text-sol-red">{error}</span> : null}
    </div>
  );
}

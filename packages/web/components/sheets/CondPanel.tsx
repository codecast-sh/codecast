// The conditional color rules of a tab, in the shell's side panel: every rule
// with its range, condition and color, a delete on each, and a form to add
// one. Reads only the rule and tab elements, so it costs nothing on a big sheet.
import { useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { COND_RULES, PALETTE, buildModel, condLabel, condOps, condTakesValue, parseRectA1, rectA1, type CondRule, type PaletteColor } from "./sheetCore";
import { useLiveElements, type LiveHandle } from "../live/useLiveArtifact";
import { tint } from "./cellPaint";
import "./formulaAssist.css";

const RULE_NAMES: Record<CondRule, string> = {
  gt: "Greater than",
  lt: "Less than",
  between: "Between",
  eq: "Is exactly",
  ne: "Is not",
  empty: "Is empty",
  filled: "Is not empty",
  contains: "Text contains",
  before: "Date before",
  after: "Date after",
  sign: "Gains and losses",
  scale: "Color scale",
  formula: "Custom formula",
};

export function CondPanel({ live, tabId, tabName, selection, onClose }: { live: LiveHandle; tabId: string; tabName: string; selection: () => string; onClose: () => void }) {
  const els = useLiveElements(live.docId, { kinds: ["cf", "tab"] });
  const model = useMemo(() => buildModel(els), [els]);
  const rules = model.conds.filter((c) => c.tab === tabId);
  const [range, setRange] = useState(selection);
  const [rule, setRule] = useState<CondRule>("eq");
  const [value, setValue] = useState("");
  const [color, setColor] = useState<PaletteColor>("red");
  const [error, setError] = useState<string | null>(null);
  /** The rule being edited (its key), or null while adding. */
  const [editing, setEditing] = useState<string | null>(null);
  const edit = (c: (typeof rules)[number]) => {
    setEditing(c.key);
    setRange(rectA1(c.rect));
    setRule(c.rule);
    setValue(c.value === undefined ? "" : String(c.value));
    setColor(c.color ?? "yellow");
    setError(null);
  };
  const stopEditing = () => {
    setEditing(null);
    setValue("");
  };
  const add = () => {
    const rect = parseRectA1(range.trim().toUpperCase());
    if (!rect) return setError("Range like B2:B40");
    try {
      live.apply(condOps(model, tabId, rect, rule, condTakesValue(rule) ? value.trim() : undefined, color, editing ?? undefined));
      stopEditing();
      setError(null);
    } catch (x) {
      setError(x instanceof Error ? x.message : "Couldn't add that rule");
    }
  };
  return (
    <div className="sheet-cond" data-sheet-cond-panel data-owns-keys>
      <div className="sheet-cond-head">
        <span>Conditional colors</span>
        <code>{tabName}</code>
        <span className="flex-1" />
        <button type="button" className="sheet-dv-x" aria-label="Close" onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      <div className="sheet-cond-list">
        {rules.length === 0 && <span className="sheet-fn-empty">No rules on this tab</span>}
        {rules.map((c) => (
          <div key={c.key} className={`sheet-cond-row${editing === c.key ? " is-editing" : ""}`} data-sheet-cond-rule role="button" tabIndex={0} onClick={() => edit(c)} onKeyDown={(e) => e.key === "Enter" && edit(c)}>
            <span className="sheet-cond-swatch" style={{ background: c.rule === "scale" ? `linear-gradient(90deg, ${tint(c.color ?? "green", 6)}, ${tint(c.color ?? "green", 45)})` : tint(c.color ?? (c.rule === "sign" ? "green" : "yellow"), 40) }} />
            <span className="sheet-cond-text">
              <span>{condLabel(c)}</span>
              <code>{rectA1(c.rect)}</code>
            </span>
            <button type="button" className="sheet-dv-x" aria-label="Delete rule" onClick={(e) => { e.stopPropagation(); if (editing === c.key) stopEditing(); live.apply([{ k: c.key, del: true }]); }}><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>
      <form
        className="sheet-cond-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="sheet-cond-field">
          <input value={range} onChange={(e) => setRange(e.target.value)} aria-label="Range" spellCheck={false} placeholder="B2:B40" />
          <button type="button" className="sheet-picker-clear" onClick={() => setRange(selection())}>Use selection</button>
        </div>
        <select value={rule} onChange={(e) => setRule(e.target.value as CondRule)} aria-label="Condition">
          {COND_RULES.map((r) => <option key={r} value={r}>{RULE_NAMES[r]}</option>)}
        </select>
        {condTakesValue(rule) && (
          <input value={value} onChange={(e) => setValue(e.target.value)} aria-label="Value" spellCheck={false} placeholder={rule === "formula" ? '=$B2="Offer"' : rule === "before" || rule === "after" ? "today, or 2026-12-01" : rule === "contains" || rule === "eq" || rule === "ne" ? "Rejected" : rule === "between" ? "10, 20" : "100"} />
        )}
        <div className="sheet-cond-colors" role="radiogroup" aria-label="Color">
          {PALETTE.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={`sheet-dv-swatch${color === c ? " is-on" : ""}`} style={{ background: tint(c, 40) }} onClick={() => setColor(c)} />
          ))}
        </div>
        {error && <span className="sheet-cond-error" role="alert">{error}</span>}
        <div className="sheet-dv-foot">
          {editing && <button type="button" className="sheet-picker-clear" onClick={stopEditing}>Cancel</button>}
          <span className="flex-1" />
          <button type="submit" className="sheet-dv-apply sheet-cond-add">{editing ? "Save rule" : <><Plus className="w-3.5 h-3.5" /> Add rule</>}</button>
        </div>
      </form>
    </div>
  );
}

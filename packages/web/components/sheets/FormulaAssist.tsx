// Formula help while typing, shared by the in-cell editor and the formula
// bar: function names that match the word at the caret (with what each does),
// the signature of the call the caret sits in with the current argument
// marked, and the full function list behind the fx mark.
import { useState } from "react";
import { FN_CATEGORIES, FUNCTION_DOCS, FUNCTION_NAMES, argHelp, argIndexFor, argLabel, type FnCategory } from "@codecast/shared/artifacts/sheets";
import type { FormulaAssist } from "./useFormulaAssist";
import "./formulaAssist.css";

/** The suggestion list, or the signature of the call at the caret. Positioned by the caller. */
export function AssistPopup({ assist, style }: { assist: FormulaAssist; style: React.CSSProperties }) {
  const { matches, pick, call } = assist;
  if (matches.length) {
    const doc = FUNCTION_DOCS[matches[pick]];
    return (
      <div className="sheet-assist" style={style} data-sheet-assist role="listbox">
        {matches.map((name, i) => (
          <button
            key={name}
            type="button"
            role="option"
            aria-selected={i === pick}
            className={i === pick ? "is-picked" : undefined}
            onMouseDown={(e) => {
              e.preventDefault();
              assist.accept(name);
            }}
          >
            <span className="sheet-assist-name">{name}</span>
            <span className="sheet-assist-about">{FUNCTION_DOCS[name]?.about}</span>
          </button>
        ))}
        {doc && <Signature name={matches[pick]} arg={-1} />}
      </div>
    );
  }
  if (!call) return null;
  return (
    <div className="sheet-assist sheet-assist-hint" style={style} data-sheet-arg-hint>
      <Signature name={call.name} arg={argIndexFor(call.name, call.arg)} />
      {argHelp(call.name, argIndexFor(call.name, call.arg)) ? (
        <span className="sheet-assist-arg">{argHelp(call.name, argIndexFor(call.name, call.arg))}</span>
      ) : (
        <span className="sheet-assist-about">{FUNCTION_DOCS[call.name].about}</span>
      )}
    </div>
  );
}

function Signature({ name, arg }: { name: string; arg: number }) {
  const args = FUNCTION_DOCS[name]?.args ?? [];
  return (
    <code className="sheet-assist-sig">
      {name}(
      {args.map((a, i) => (
        <span key={i}>
          {i > 0 && ", "}
          <span className={i === arg ? "is-arg" : undefined}>{argLabel(a)}</span>
        </span>
      ))}
      )
    </code>
  );
}

/** Every function by category, searchable. Picking one starts or extends the formula. */
export function FunctionList({ onPick }: { onPick: (name: string) => void }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<FnCategory | null>(null);
  const want = q.trim().toUpperCase();
  const names = FUNCTION_NAMES.filter((n) => {
    const doc = FUNCTION_DOCS[n];
    if (cat && doc?.cat !== cat) return false;
    return !want || n.includes(want) || doc?.about.toUpperCase().includes(want);
  });
  return (
    <div className="sheet-fn-list" data-sheet-fn-list data-owns-keys>
      <input
        autoFocus
        className="sheet-fn-search"
        placeholder="Search functions"
        aria-label="Search functions"
        value={q}
        spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && names[0]) {
            e.preventDefault();
            onPick(names[0]);
          }
        }}
      />
      <div className="sheet-fn-cats" role="tablist">
        {[null, ...FN_CATEGORIES].map((c) => (
          <button key={c ?? "all"} type="button" role="tab" aria-selected={cat === c} className={cat === c ? "is-on" : undefined} onClick={() => setCat(c)}>
            {c ?? "All"}
          </button>
        ))}
      </div>
      <div className="sheet-fn-rows">
        {names.map((n) => (
          <button key={n} type="button" className="sheet-fn-row" onClick={() => onPick(n)}>
            <Signature name={n} arg={-1} />
            <span className="sheet-assist-about">{FUNCTION_DOCS[n]?.about}</span>
          </button>
        ))}
        {names.length === 0 && <span className="sheet-fn-empty">No match</span>}
      </div>
    </div>
  );
}

// What a cell's error means and, when one is safe, a fix: the formula it
// would become, put into the editor so the person sees it and presses Enter.
import { ERROR_DOCS, errorFix } from "@codecast/shared/artifacts/sheets";

/** Engine messages that only restate the error's title. */
const RESTATES = new Set(["division by zero", "circular reference"]);

export function ErrorCard({ code, message, input, onFix }: { code: string; message?: string; input: string; onFix?: (text: string) => void }) {
  const doc = ERROR_DOCS[code];
  const fix = onFix ? errorFix(code, message, input) : null;
  return (
    <div className="sheet-error-card" data-sheet-error-card>
      <div className="sheet-error-card-head">
        <span className="sheet-error-code">{code}</span>
        <span className="sheet-error-title">{doc?.title ?? "Error"}</span>
      </div>
      {message && !RESTATES.has(message) && <div className="sheet-error-message">{message}</div>}
      {doc && !fix && <div className="sheet-error-hint">{doc.fix}</div>}
      {fix && (
        <button type="button" className="sheet-error-fix" data-sheet-error-fix onClick={() => onFix!(fix.text)}>
          <span>{fix.label}</span>
          <code>{fix.text}</code>
        </button>
      )}
    </div>
  );
}

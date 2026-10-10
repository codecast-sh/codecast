// The `line` fenced block (docs/architecture/line-workspace.md LW3): a small
// JSON spec that names one line widget, so an agent's reply anywhere markdown
// renders can show a step, a prompt, a diff, decisions, a before/after table,
// a run's path or the graph, live from the store. Pure: the spec is read and
// checked here, and components/line/widgets/LineFence draws it.
//
//   ```line
//   {"widget":"step","project":"pr-12","graph":"agentwatch","step":"dissolve"}
//   ```

// The widgets and what each needs live in the shared contract, which also
// writes them into the brief of the session that answers the line's chat.
import { LINE_FENCE_LANG, LINE_WIDGETS, LINE_WIDGET_NEEDS, type LineWidgetKind } from "@codecast/shared/contracts/lineChat";
export { LINE_FENCE_LANG, LINE_WIDGETS, type LineWidgetKind };

/** One row of a before/after table an agent writes out: a case, what the step said, what it says now. */
export type BeforeAfterSpecRow = { case: string; before: string; after: string; ref?: string | null };

export type LineFenceSpec = {
  widget: LineWidgetKind;
  /** The project, as the line pages name it (short id or row id). */
  project: string;
  graph: string | null;
  step: string | null;
  run: string | null;
  /** A prompt diff's two texts; `before` absent is the step's current text. */
  before: string | null;
  after: string | null;
  /** A decisions list: how many, and one outcome only. */
  limit: number | null;
  outcome: string | null;
  /** A before/after table's rows, when the agent carries them in the spec. */
  rows: BeforeAfterSpecRow[] | null;
  /** The widget's own title, when the agent gives one. */
  title: string | null;
};

export type LineFenceRead = { ok: true; spec: LineFenceSpec } | { ok: false; why: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

function rowsOf(v: unknown): BeforeAfterSpecRow[] | null {
  if (!Array.isArray(v)) return null;
  const rows = v.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    const c = str(o.case);
    if (!c) return [];
    return [{ case: c, before: text(o.before) ?? "", after: text(o.after) ?? "", ref: str(o.ref) }];
  });
  return rows.length ? rows : null;
}

/** A fence's body read as a widget spec, or why it cannot be one. */
export function readLineFence(code: string): LineFenceRead {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return { ok: false, why: "The block is not JSON." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "The block is not a JSON object." };
  const o = raw as Record<string, unknown>;
  const widget = str(o.widget) as LineWidgetKind | null;
  if (!widget || !LINE_WIDGETS.includes(widget)) return { ok: false, why: `Unknown widget ${widget ? `"${widget}"` : "(none named)"}.` };
  const project = str(o.project);
  if (!project) return { ok: false, why: "No project named." };
  const limit = typeof o.limit === "number" && Number.isFinite(o.limit) ? Math.max(1, Math.min(50, Math.round(o.limit))) : null;
  const spec: LineFenceSpec = {
    widget,
    project,
    graph: str(o.graph),
    step: str(o.step),
    run: str(o.run),
    before: text(o.before),
    after: text(o.after),
    limit,
    outcome: str(o.outcome),
    rows: rowsOf(o.rows),
    title: str(o.title),
  };
  const missing = LINE_WIDGET_NEEDS[widget].find((k) => spec[k] == null);
  if (missing) return { ok: false, why: `A ${widget} widget needs "${missing}".` };
  return { ok: true, spec };
}

// Labels: the names a sim report prints instead of 32-char ids
// (docs/architecture/multiplayer-sim-harness.md, section 3.9).
//
// The world registers the names it chose (`ada`, `acme`, `ada/s`,
// `task:acme/t1`). Rows a real mutation creates get `table#n` through the
// backend's onInsert hook, numbered per table in insert order, so a replayed
// seed names them the same way. Pure: no store, no convex.

// The id shape the sim mints (convexIdFor) and real Convex ids share.
const ID_PATTERN = /\b[a-z0-9]{32}\b/g;

export class SimLabels {
  private byId = new Map<string, string>();
  private byLabel = new Map<string, string>();
  private inserted = new Map<string, number>();

  // A label names one id and an id carries one label. Registering the same
  // pair twice is a no-op; anything else is a world bug worth stopping on.
  register(id: string, label: string): void {
    const heldLabel = this.byId.get(id);
    const heldId = this.byLabel.get(label);
    if (heldLabel === label && heldId === id) return;
    if (heldLabel !== undefined) throw new Error(`sim labels: ${id} is already "${heldLabel}", cannot also be "${label}"`);
    if (heldId !== undefined) throw new Error(`sim labels: "${label}" already names ${heldId}, cannot also name ${id}`);
    this.byId.set(id, label);
    this.byLabel.set(label, id);
  }

  // The backend's onInsert hook. A row the world already named keeps its name;
  // it still takes its number, so later rows of the table keep theirs.
  onInsert(table: string, id: string): void {
    const n = (this.inserted.get(table) ?? 0) + 1;
    this.inserted.set(table, n);
    if (!this.byId.has(id)) this.register(id, `${table}#${n}`);
  }

  label(id: string): string {
    return this.byId.get(id) ?? id.slice(0, 8);
  }

  // The id behind a label, for the DSL's point checks (`shows("ada/s")`).
  id(label: string): string {
    const id = this.byLabel.get(label);
    if (id === undefined) throw new Error(`sim labels: no row is labelled "${label}"; known: ${[...this.byLabel.keys()].sort().join(", ") || "(none)"}`);
    return id;
  }

  has(label: string): boolean {
    return this.byLabel.has(label);
  }

  // Every id-shaped token in `text`, replaced by its label.
  relabel(text: string): string {
    return text.replace(ID_PATTERN, (id) => this.label(id));
  }

  entries(): [id: string, label: string][] {
    return [...this.byId];
  }

  // A run's recorded labels (world.json, result.json), for a reader. A pair
  // that would clash with one already taken is skipped rather than thrown on.
  static from(byId: Record<string, string>): SimLabels {
    const labels = new SimLabels();
    for (const [id, label] of Object.entries(byId)) if (!labels.byId.has(id) && !labels.byLabel.has(label)) labels.register(id, label);
    return labels;
  }
}

// Whether a delivery is one `--trace <label>` prints: its channel, label and
// producer carry the label's id raw, or the label once ids are relabelled.
// The runner (dsl.ts) and the Evals sim run page both decide by this.
export function traceMatches(d: { channel: string; label: string; producer: string }, trace: string, labels: SimLabels): boolean {
  const text = `${d.channel} ${d.label} ${d.producer}`;
  return (labels.has(trace) && text.includes(labels.id(trace))) || labels.relabel(text).includes(trace);
}

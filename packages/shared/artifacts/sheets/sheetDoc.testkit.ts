// A tiny in-memory sheet doc for tests: apply ops, run verbs, read elements.
import { applyOp, toElement, type ArtifactElement, type ArtifactOp, type ElementState } from "../core";
import { artifactView } from "../spec";
import { sheetSpec } from "../sheet";

/** A tiny in-memory doc: apply ops, read elements. */
export function doc(initial: ArtifactOp[] = []) {
  const state = new Map<string, ElementState>();
  const apply = (ops: ArtifactOp[]) => {
    for (const op of ops) state.set(op.k, applyOp(state.get(op.k), op));
  };
  apply(initial);
  const elements = (): ArtifactElement[] => [...state].filter(([, s]) => !s.deleted).map(([k, s]) => toElement(k, s));
  const view = () => artifactView("sheet", "Pre-orders", elements());
  const verb = (name: string, args: string[], stdin?: string) => {
    const r = sheetSpec.verbs![name].run(view(), args, stdin);
    apply(r.ops);
    return r;
  };
  const input = (key: string) => state.get(key)?.fields.input;
  return { apply, elements, view, verb, input, state };
}

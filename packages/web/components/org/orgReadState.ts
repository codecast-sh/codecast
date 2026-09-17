// What the org canvas says about the tree read, as one pure decision so the
// page cannot paint an empty chart for a read that failed. The health read
// already tells a failure apart from "no flags" (StaffingPane FlagList); this
// is the same honesty for org.tree.
//
//   missing  the function is not deployed on this backend
//   refused  the server answered null: the viewer may not read this workspace
//   error    the read failed (a server limit, a thrown query) and no cached
//            tree stands in; carries the message and offers a retry
//   stale    the read failed but a cached tree paints; the page says so
//   loading  no answer yet and nothing cached
//   empty    an answer with nobody in it
//   ok       a tree to draw
export type OrgTreeReadState =
  | { kind: "ok" | "loading" | "empty" | "missing" | "refused" }
  | { kind: "error" | "stale"; message: string };

export function orgTreeReadState(input: { hasTree: boolean; hasNodes: boolean; ready: boolean; missing: boolean; refused: boolean; error?: { message?: string } | null }): OrgTreeReadState {
  const { hasTree, hasNodes, ready, missing, refused, error } = input;
  if (missing && !hasTree) return { kind: "missing" };
  // A read that failed for any reason other than "not deployed".
  if (error && !missing) return { kind: hasTree && hasNodes ? "stale" : "error", message: readableReadError(error.message) };
  if (refused && !hasTree) return { kind: "refused" };
  if (!ready && !hasTree) return { kind: "loading" };
  return hasTree && hasNodes ? { kind: "ok" } : { kind: "empty" };
}

/** A Convex error reads "[CONVEX Q(org:tree)] [Request ID: …] Server Error\n
 *  Uncaught Error: <the sentence>\n  at …": keep the sentence. */
export function readableReadError(message: string | undefined): string {
  const text = (message ?? "").trim();
  if (!text) return "the server did not say why";
  const uncaught = /Uncaught (?:\w*Error): ([^\n]+)/.exec(text);
  const line = (uncaught ? uncaught[1] : text.split("\n")[0]).replace(/\[CONVEX [^\]]+\]\s*/g, "").replace(/\[Request ID: [^\]]+\]\s*/g, "").trim();
  return line.length > 200 ? `${line.slice(0, 197)}…` : line || "the server did not say why";
}

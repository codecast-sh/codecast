// A call as `cast calls` names it, resolved to the id the server stores, for
// `cast call`, and for task, plan and priority create's --from-call.
import { parseCallRef } from "@codecast/shared/entities";
import { isServerCallRef } from "./callSnap.js";

/** The call a reference names, or a thrown error whose `code` says why not
 *  ("not_found", "ambiguous"). A short id (cl-42) or full id resolves on the
 *  server; anything else is a unique prefix of a recent call's id. */
export async function findCallIdIn(post: (urlPath: string, body: Record<string, unknown>) => Promise<any>, ref: string): Promise<string> {
  if (parseCallRef(ref) || isServerCallRef(ref)) return ref.toLowerCase();
  const rows: any[] = await post("/cli/calls/list", { limit: 200 });
  const exact = rows.find((r) => r._id === ref);
  if (exact) return exact._id;
  const matches = rows.filter((r) => r._id.startsWith(ref));
  if (matches.length === 1) return matches[0]._id;
  // `try` holds the commands the sentence names, for a caller that answers
  // in JSON (`cast call snap --json`).
  const err = (code: "not_found" | "ambiguous", message: string, tries: string[]) => Object.assign(new Error(message), { code, try: tries });
  if (matches.length > 1) throw err("ambiguous", `"${ref}" matches ${matches.length} recent calls; use more characters, or the short id from \`cast calls\``, ["cast calls"]);
  // A short id typed without its prefix (`107` for cl-107) is the likeliest
  // miss: say the spelling that works, and whether that call is there.
  if (/^\d+$/.test(ref)) {
    const short = `cl-${Number(ref)}`;
    const there = rows.some((r) => r.short_id === short);
    throw err("not_found", `No recent call matches "${ref}"${there ? `; did you mean ${short}?` : `; a call's short id is written ${short}.`} \`cast calls\` lists them`, there ? [`cast call ${short}`, "cast calls"] : ["cast calls"]);
  }
  throw err("not_found", `No recent call matches "${ref}"; \`cast calls\` lists them`, ["cast calls"]);
}

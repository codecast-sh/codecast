// What a scope gain would move, read BEFORE the person accepts it
// (org-roles-run-work.md R1): "12 sessions now report to @growth and leave
// your needs input". Only the server can count it (the org scan), so this is
// an enrichment read, and it never throws into the surface that shows it. A
// surface asks for every row it shows in ONE call: the server scans the
// workspace's sessions once for all of them (orgInit.previewTakeovers).
import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { takeoverPhrase } from "@codecast/shared/contracts/orgProposal";
import { useQueryNoThrow } from "./useQueryNoThrow";

/** `seat`: the session the role will be seated on, which therefore never
 *  moves. `says`: the handle the sentence names when the role has no row yet
 *  (a hire being typed); it is not sent, so typing a name asks nothing again. */
export type TakeoverAsk = { key: string; handle?: string; add?: string[]; seat?: string; says?: string };
export type TakeoverPreview = { phrase: string; count: number; kept_in_front: number; over_cap: number };

/** `byKey` is keyed by the asker's own key; a row that would move nothing has
 *  no entry, so "is there anything to say" is one lookup. `ready` is false
 *  until the server has answered what was asked (an error counts as an
 *  answer: the surface then goes on without a number). */
export function useTakeoverPreviews(workspace: { kind: "team" | "user"; id: string } | null | undefined, asks: TakeoverAsk[]): { byKey: Record<string, TakeoverPreview>; ready: boolean } {
  // The args are rebuilt only when what is ASKED changes, so the subscription
  // survives the parent's re-renders and a change of the words alone.
  const sent = JSON.stringify(asks.map(({ handle, add, seat }) => ({ ...(handle ? { handle } : {}), ...(add?.length ? { add } : {}), ...(seat ? { seat } : {}) })));
  const args = useMemo(() => ({ ...(workspace?.kind === "team" ? { team_id: workspace.id as any } : {}), items: JSON.parse(sent) }), [sent, workspace?.kind, workspace?.id]);
  const asking = !!workspace && asks.length > 0;
  const { data, error } = useQueryNoThrow(api.orgInit.takeoverPreview, asking ? args : "skip");
  const said = JSON.stringify(asks.map((a) => [a.key, a.says ?? a.handle ?? ""]));
  return useMemo(() => {
    const byKey: Record<string, TakeoverPreview> = {};
    (JSON.parse(said) as Array<[string, string]>).forEach(([key, handle], i) => {
      const r = data?.[i];
      if (!r || r.sessions.length === 0) return;
      const counts = { sessions: r.sessions.length, kept_in_front: r.kept_in_front.length, over_cap: r.over_cap };
      byKey[key] = { phrase: takeoverPhrase(handle, counts, false), count: counts.sessions, kept_in_front: counts.kept_in_front, over_cap: counts.over_cap };
    });
    return { byKey, ready: !asking || data !== undefined || !!error };
  }, [data, error, said, asking]);
}

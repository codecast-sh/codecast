// Calls a finding names by id ("Call 94373d15-a72c-4fd2-84c1-3bf5d900e5ac (Oct 9 14:02Z, Eric S)"), read as the
// connected app's call view (contracts/productView.ts, `union:call/<id>`) so the finding's reader can open the call
// itself rather than show a raw id. A Slack message ts a finder notes in passing ("(slack msg 1791554755.009459)")
// names nothing a reader can open, so it is left out of the words. Pure.
import type { ProductViewRef } from "@codecast/shared/contracts/productView";

/** The app whose call view a finding's call id opens. */
export const CALL_APP = "union";
const CALL_ID = /\b[Cc]all\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;
const SLACK_TS = /\s*\(\s*slack (?:msg|message)\s+\d{9,}\.\d+\s*\)/gi;

const callRef = (id: string): ProductViewRef => ({ app: CALL_APP, view: "call", id, at: null });

/** Every call a text names by id, once each, in the order named. */
export function callsIn(text: string): ProductViewRef[] {
  const ids = [...new Set([...text.matchAll(CALL_ID)].map((m) => m[1]))];
  return ids.map(callRef);
}

/** A text as words and call references: "Call <id>" becomes "Call " and the call's reference. */
export function textWithCalls(text: string): Array<string | ProductViewRef> {
  const t = text.replace(SLACK_TS, "");
  const out: Array<string | ProductViewRef> = [];
  let at = 0;
  for (const m of t.matchAll(CALL_ID)) {
    const id = m[1];
    const start = (m.index ?? 0) + m[0].length - id.length;
    out.push(t.slice(at, start), callRef(id));
    at = start + id.length;
  }
  out.push(t.slice(at));
  return out.filter((x) => x !== "");
}

/** A text where it cannot hold a control (a row's one line): each call id cut to its first eight characters, which is
 *  how a person names it, and no Slack ts. */
export function callWordsShort(text: string): string {
  return text.replace(SLACK_TS, "").replace(CALL_ID, (m, id: string) => m.replace(id, id.slice(0, 8)));
}

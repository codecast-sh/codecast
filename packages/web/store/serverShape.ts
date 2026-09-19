/** Write a field patch onto a draft row the way the server will echo it. A
 *  clear travels on the wire as null, "" or [] (the dispatch args stay as
 *  given), but the server drops the field, so the echo carries it ABSENT. The
 *  field lock the middleware records takes the draft value; storing the clear
 *  as undefined makes that lock equal to the echo and lets it retire. Stored
 *  as null or [] it would re-assert the clear over every push until the
 *  settle window. Skips undefined (not part of the patch); bumps updated_at. */
export function writeAsServerShape(row: Record<string, any>, fields: Record<string, any>): void {
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    row[k] = v === null || v === "" || (Array.isArray(v) && v.length === 0) ? undefined : v;
  }
  row.updated_at = Date.now();
}

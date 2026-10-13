// One heading for a failure cause whose runs say it in different words. A cause is
// its key (runReport failCause: what happened, at which step, by which check), never
// its sentence: runs of one cause that differ in a detail ("Out of time, 1.5h" and
// "Out of time, 3h") are one heading that says what they share.

/** The words every label shares, as a heading: whole when they agree, else their shared clause, else their shared
 *  leading words and "stopped". A shared " at <Step>" tail is kept. */
export function causeHeading(labels: ReadonlyArray<string>): string {
  const all = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
  if (all.length <= 1) return all[0] ?? "Failed";
  const tail = / at [A-Z][\w ]*$/.exec(all[0])?.[0];
  const at = tail && all.every((l) => l.endsWith(tail)) ? tail : "";
  const heads = at ? all.map((l) => l.slice(0, -at.length)) : all;
  let n = 0;
  while (heads.every((l) => n < l.length && l[n] === heads[0][n])) n++;
  const common = heads[0].slice(0, n);
  // The shared clause: up to the last ":" or "," they share ("Out of time, 1.5h" + "Out of time, 3h" -> "Out of time").
  const cut = Math.max(common.lastIndexOf(":"), common.lastIndexOf(","));
  const clause = cut > 0 ? common.slice(0, cut).trim() : "";
  if (clause) return `${clause}${at}`;
  // Only whole leading words shared ("Implement blocked: …" + "Implement ended without a report"): the step stopped.
  const space = common.lastIndexOf(" ");
  const words = space > 0 ? common.slice(0, space).trim() : "";
  return words ? `${words} stopped${at}` : `${heads[0].split(/[:,]/)[0].trim()}${at}`;
}

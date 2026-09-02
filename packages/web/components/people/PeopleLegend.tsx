/** THE GESTURE, WRITTEN DOWN. A face is a key and a link, and nothing about a
 *  circle says so — so every surface that draws faces says it, in one line,
 *  always. Its own module so the strip and the panel can both import it
 *  without importing each other. */
export function PeopleLegend({ inline = false }: { inline?: boolean }) {
  return (
    <div className={inline ? "people-legend people-legend-inline" : "people-legend"}>
      <b>CLICK</b> a face for <b>Talk</b> · <b>Ring</b> · <b>Message</b>
    </div>
  );
}

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InsightTurns } from "../EvidenceDrawer";

// The evidence drawer quotes a session's turns as ask/did pairs (spec 3,
// level 3): empty turns drop out, at most four show with a count of the rest,
// and a long did is cut to 160 characters.
test("a session's turns render as asked/did pairs, capped and clipped", () => {
  const long = "x".repeat(400);
  const turns = [
    { ask: "Ship the drawer", did: ["Wrote it", long] },
    { ask: "  ", did: [] },
    { ask: "Second", did: ["two"] },
    { ask: "Third", did: [] },
    { ask: "Fourth", did: ["four"] },
    { ask: "Fifth", did: ["five"] },
  ];
  const html = renderToStaticMarkup(<InsightTurns turns={turns} />);
  expect(html).toContain("Ship the drawer");
  expect(html).toContain("Wrote it");
  expect(html).toContain("Fourth");
  expect(html).not.toContain("Fifth");
  expect(html).toContain("1 more turn in the session");
  expect(html).not.toContain(long);
  expect(html).toContain(`${"x".repeat(159)}...`.slice(-20));
  expect((html.match(/>asked</g) ?? []).length).toBe(4);
});

test("no turns, no list", () => {
  expect(renderToStaticMarkup(<InsightTurns turns={[{ ask: "", did: [] }]} />)).toBe("");
});

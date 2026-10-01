import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoStage, GridStage } from "../StageViews";
import { StageHostProvider, type StageHost } from "../stageHost";
import { rosterWithGuests } from "../../../lib/calls/roomGuests";

// A guest on the stage: the same views a member's huddle and a guest's page
// draw (StageViews), fed a member's roster with the room's guests folded in.
// The guest wears the mark and is offered the host's actions; a teammate is
// neither, and the views read nothing but what they are handed.

const seats = [{ user_id: "u-sam", user_name: "Sam Lee" }];
const roster = rosterWithGuests(seats, [{ guest_id: "g1", identity: "guest:g1", name: "Ada Lovelace", joined_at: 1 }]);

const host: StageHost = {
  getRoom: () => null,
  personActions: ({ identity, variant }) => <i data-action={identity} data-variant={variant} />,
};

const draw = (el: React.ReactElement) => renderToStaticMarkup(<StageHostProvider value={host}>{el}</StageHostProvider>);

test("audio only: a guest's face says guest; a teammate's does not", () => {
  const html = draw(<AutoStage roster={roster} cameras={[]} screens={[]} speaking={new Set()} phase="connected" />);
  expect(html.match(/>guest</g)?.length).toBe(1);
  expect(html.indexOf("Ada")).toBeLessThan(html.indexOf(">guest<"));
  expect(html).toContain('data-action="guest:g1"');
  expect(html).toContain('data-action="u-sam"');
});

test("grid: the host decides the actions (a member's stage offers Remove only for a guest)", () => {
  const html = draw(<GridStage roster={roster} cameras={[]} screens={[]} speaking={new Set(["guest:g1"])} />);
  expect(html).toContain('data-action="guest:g1"');
  // The speaking ring follows the guest's identity like anyone's.
  expect(html).toMatch(/ring-sol-cyan[^"]*"[^>]*>(?:(?!data-action).)*Ada/s);
});

test("without a host (a guest's own page) the views draw and offer nothing", () => {
  const html = renderToStaticMarkup(<AutoStage roster={roster} cameras={[]} screens={[]} speaking={new Set()} phase="connected" />);
  expect(html).toContain("Ada");
  expect(html).toContain(">guest<");
  expect(html).not.toContain("data-action");
});

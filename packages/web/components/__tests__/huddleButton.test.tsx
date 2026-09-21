import { afterAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The empty room's affordance, pinned at both scales.
//
// A header pill competes for the one line that carries the session's title, so
// the compact form is the headphones alone and says what it is in its tooltip;
// the chat page, which has room, keeps the word. The session room is the one
// room whose second party never takes a seat, so its tooltip promises the
// thing that makes the button worth pressing: the agent hears you as you talk.
//
// Static markup only. The occupied branch is OccupancyChip's (faces and a
// join verb) and is not what these questions are about.

let CALLS_ENABLED = true;
let OCCUPANCY: Record<string, unknown[]> = {};

const realTeamFeatures = { ...(await import("../../lib/teamFeatures")) };
const realStore = { ...(await import("../../store/inboxStore")) };
afterAll(() => {
  mock.module("../../lib/teamFeatures", () => realTeamFeatures);
  mock.module("../../store/inboxStore", () => realStore);
});

mock.module("../../lib/teamFeatures", () => ({
  ...realTeamFeatures,
  useCallsAvailable: () => CALLS_ENABLED,
}));
mock.module("../../store/inboxStore", () => ({
  ...realStore,
  useInboxStore: (selector: (st: any) => unknown) => selector({ callOccupancy: OCCUPANCY }),
  useTrackedStore: () => ({ callOccupancy: OCCUPANCY, call: { roomKey: null } }),
}));

const { HuddleButton, SessionHuddleButton } = await import("../calls/OccupancyChip");

/** The rendered button's tooltip — the same string its aria-label carries. */
function title(markup: string): string {
  return /title="([^"]*)"/.exec(markup)?.[1] ?? "";
}

describe("the huddle button on an empty room", () => {
  test("the header scale is the headphones alone", () => {
    const markup = renderToStaticMarkup(<HuddleButton roomKey="channel:ch1" compact />);
    expect(markup).not.toContain("Huddle");
    expect(markup).not.toContain("Ring");
    expect(markup).toContain("<svg");
  });

  test("the chat page keeps the word beside it", () => {
    const markup = renderToStaticMarkup(<HuddleButton roomKey="channel:ch1" />);
    expect(markup).toContain("<span>Huddle</span>");
  });

  test("a room with people to ring says Ring, at the scale that has room", () => {
    expect(renderToStaticMarkup(<HuddleButton roomKey="dm:ua:ub" ring={["ub"]} />)).toContain(
      "<span>Ring</span>",
    );
  });

  // The word is gone at header scale, so the tooltip is the only place left
  // that says what the button does. Losing it would leave an unlabelled icon.
  test("dropping the word does not drop the label", () => {
    const markup = renderToStaticMarkup(<HuddleButton roomKey="channel:ch1" compact />);
    expect(title(markup)).toContain("Start a huddle and buzz everyone in the channel");
    expect(markup).toContain(`aria-label="${title(markup)}"`);
  });

  test("ringing several people reads as everyone, one person as them", () => {
    const one = renderToStaticMarkup(<HuddleButton roomKey="dm:ua:ub" ring={["ub"]} compact />);
    const many = renderToStaticMarkup(
      <HuddleButton roomKey="dm:ua:ub:uc" ring={["ub", "uc"]} compact />,
    );
    expect(title(one)).toContain("ring them");
    expect(title(many)).toContain("ring everyone here");
  });

  test("a session's button promises the agent is listening", () => {
    const markup = renderToStaticMarkup(<SessionHuddleButton conversationId="conv1" />);
    expect(title(markup)).toContain("Talk to this session");
    expect(markup).not.toContain("Huddle");
  });

  test("calling switched off draws nothing at all", () => {
    CALLS_ENABLED = false;
    expect(renderToStaticMarkup(<HuddleButton roomKey="channel:ch1" compact />)).toBe("");
    expect(renderToStaticMarkup(<SessionHuddleButton conversationId="conv1" />)).toBe("");
    CALLS_ENABLED = true;
  });
});

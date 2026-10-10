// A hosted receipt's made line ("Set up the routine Morning stretch") with the
// resolver answered by fixtures: a live routine is a link with its state, and
// one deleted since reads as its name from the step, "· Deleted", never the
// machine id the resolver falls back to.
// Run: bun test components/conversation/HostedMadeLine.mount.test.tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ConvexProvider } from "convex/react";
import { heroConvexStub } from "../../app/(marketing)/heroFly/convexStub";
import { EntityFixtureContext, type EntityFixture } from "../../lib/entityDisplay";
import { HostedMadeLine } from "./HostedMadeLine";

function render(fixtures: Record<string, EntityFixture>) {
  return renderToStaticMarkup(
    <ConvexProvider client={heroConvexStub}>
      <MemoryRouter>
        <EntityFixtureContext.Provider value={fixtures}>
          <HostedMadeLine words="Set up the routine" name="Weekday morning stretch" refId="tr-1448" />
        </EntityFixtureContext.Provider>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("HostedMadeLine", () => {
  test("a live routine links by its own name", () => {
    const html = render({ "tr-1448": { type: "trigger", entity: { _id: "x", short_id: "tr-1448", display_title: "Morning stretch", status: "active" } } });
    expect(html).toContain("Morning stretch</a>");
    expect(html).not.toContain("Deleted");
  });

  test("a paused routine says so after its link", () => {
    const html = render({ "tr-1448": { type: "trigger", entity: { _id: "x", short_id: "tr-1448", display_title: "Morning stretch", status: "paused" } } });
    expect(html).toContain(" · Paused");
  });

  test("a routine deleted since reads as its name, unlinked, and Deleted", () => {
    const html = render({});
    expect(html).toContain("Weekday morning stretch");
    expect(html).toContain(" · Deleted");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("tr-1448<");
  });
});

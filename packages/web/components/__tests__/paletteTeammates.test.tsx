import { describe, expect, test, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Command as CommandPrimitive } from "cmdk";

// TeammateItem reads the router only through the palette's own navigation
// callback, never at render time — a stub is enough for a static render.
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  usePathname: () => "/",
}));

const { TeammateItem } = await import("../CommandPalette");

// Never connects: static rendering fires no effects and opens no sockets.
const client = new ConvexReactClient("https://example.convex.cloud");

const NOW = Date.now();

function render(row: Parameters<typeof TeammateItem>[0]["row"], following = false) {
  return renderToStaticMarkup(
    <ConvexProvider client={client}>
      <CommandPrimitive>
        <CommandPrimitive.List>
          <TeammateItem row={row} className="row" onOpen={() => {}} following={following} />
        </CommandPrimitive.List>
      </CommandPrimitive>
    </ConvexProvider>,
  );
}

const ann = { _id: "u-ann", name: "Ann", presence_state: "active" };

describe("palette Teammates row", () => {
  test("a teammate in a session: their name, the session title, how long they have been there", () => {
    const html = render({
      member: ann,
      id: "u-ann",
      name: "Ann",
      conversationId: "c1",
      title: "Fix the auth race",
      inStore: true,
      online: true,
      since: NOW - 5 * 60_000,
      score: 0,
    });
    expect(html).toContain(">Ann<");
    expect(html).not.toContain("Follow");
    expect(html).toContain("Fix the auth race");
    expect(html).toContain("for 5m");
    // The row drills into the person, not the session.
    expect(html).toContain('data-palette-type="person"');
    expect(html).toContain('data-palette-id="u-ann"');
    expect(html).not.toContain("aria-disabled=\"true\"");
  });

  test("a session the store lacks is named plainly until its row arrives", () => {
    const html = render({
      member: ann,
      id: "u-ann",
      name: "Ann",
      conversationId: "c2",
      title: undefined,
      inStore: false,
      online: true,
      since: NOW,
      score: 0,
    });
    expect(html).toContain(">Ann<");
    expect(html).toContain("a session");
    // Under a minute there is no duration tag.
    expect(html).not.toContain("for ");
  });

  test("a teammate around but in no session, or offline, says so under the name", () => {
    const base = { member: ann, id: "u-ann", name: "Ann", conversationId: null, title: undefined, inStore: false, since: undefined, score: 1 };
    const around = render({ ...base, online: true });
    expect(around).toContain("around, not in a session");
    expect(around).toContain('aria-disabled="false"');
    expect(render({ ...base, online: false })).toContain("offline");
  });

  test("a teammate this window already follows says so", () => {
    const html = render({ member: ann, id: "u-ann", name: "Ann", conversationId: null, inStore: false, online: true, score: 0 } as any, true);
    expect(html).toContain("following · around, not in a session");
  });
});

import { describe, expect, test, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";

// ActionSubmenu only reads router/pathname for navigation actions, never at
// render time — a stub is enough for a static render.
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  usePathname: () => "/",
}));

const { ActionSubmenu } = await import("../CommandPalette");

// Never connects: static rendering fires no effects and opens no sockets.
const client = new ConvexReactClient("https://example.convex.cloud");

function render(teamMembers: any[], currentUser: any) {
  return renderToStaticMarkup(
    <ConvexProvider client={client}>
      <ActionSubmenu
        mode="assign"
        targets={[{ _id: "t1", short_id: "ct-1", labels: [] }]}
        targetType="task"
        onClose={() => {}}
        onBack={() => {}}
        teamMembers={teamMembers}
        currentUser={currentUser}
      />
    </ConvexProvider>,
  );
}

describe("assign submenu with a nameless team member", () => {
  // Prod crash 2026-08-25: a roster row without `name` made the option label
  // undefined, and the search filter's label.toLowerCase() took down the
  // palette through its ErrorBoundary. Names must go through the app's one
  // naming rule (memberDisplayName), which always returns a string.
  test("renders the fallback name instead of crashing", () => {
    const me = { _id: "u1", name: "Ashot" };
    const nameless = { _id: "u2", github_username: "ghost-dev" };
    const html = render([me, nameless], me);
    expect(html).toContain("Ashot (you)");
    expect(html).toContain("ghost-dev");
    expect(html).not.toContain("undefined");
  });

  test("a member with no fields at all still gets a label", () => {
    const html = render([{ _id: "u3" }], null);
    expect(html).toContain("Unknown");
  });
});

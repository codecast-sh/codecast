// Zen hides the top bar and the sidebar, the only two places the workspace
// switcher otherwise lives. Its "corner" variant is the crest alone, the size
// of zen's toggle, and still names the workspace it is on.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamSwitcherButton } from "../TeamSwitcher";

describe("the workspace switcher in zen's corner", () => {
  test("is a crest-sized button that names the workspace, with no label text", () => {
    const html = renderToStaticMarkup(<TeamSwitcherButton team={undefined} label="Acme" variant="corner" />);
    expect(html).toContain('data-cc-team-trigger="corner"');
    expect(html).toContain('aria-label="Workspace: Acme. Switch workspace"');
    expect(html).toContain("size-7");
    expect(html).not.toContain("data-cc-team-label");
  });

  test("carries the dot for something new in another workspace", () => {
    const html = renderToStaticMarkup(<TeamSwitcherButton team={undefined} label="Acme" variant="corner" elsewhereNew={2} />);
    expect(html).toContain("data-cc-team-elsewhere");
  });

  test("the bar variant still shows the workspace name", () => {
    const html = renderToStaticMarkup(<TeamSwitcherButton team={undefined} label="Acme" />);
    expect(html).toContain("data-cc-team-label");
    expect(html).toContain('data-cc-team-trigger="bar"');
  });
});

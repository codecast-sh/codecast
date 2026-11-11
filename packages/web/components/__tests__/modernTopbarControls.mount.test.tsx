// The top bar in the Modern style: its icon buttons are 28px with the control
// radius and the one focus ring, the status chips share the control radius,
// the search field is the text field's face, and the New button is the
// outline button. Classic draws exactly the classes it drew before the Modern
// looks (the snapshot was taken from the unmodified bar; `modern:` classes
// are left out of it).
import { describe, expect, test } from "bun:test";
import { installModernDom, styleValue, classicClasses, wears } from "../../test-helpers/modernDom";

installModernDom("https://app.test/inbox");

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ThemeContext } = await import("../ThemeProvider");
const { TopbarRow } = await import("../TopbarRow");
const { TopbarButton, TopbarChip, TopbarTray } = await import("../TopbarButton");
const { SearchField } = await import("../search/SearchField");
const { NewMenu } = await import("../NewMenu");
const { modernButton, modernField } = await import("../ui/modernLook");

function Bar() {
  return (
    <TopbarRow
      nav={<TopbarButton aria-label="Hide sidebar"><svg /></TopbarButton>}
      workspace={null}
      search={<><SearchField value="" expanded={false} /><NewMenu /></>}
      status={<TopbarTray><TopbarChip aria-label="Sync">Synced</TopbarChip><TopbarChip tone="var(--sol-red)" alert>Daemon</TopbarChip></TopbarTray>}
      actions={<TopbarButton aria-label="Notifications" active><svg /></TopbarButton>}
      panels={<TopbarButton aria-label="Toggle sessions panel"><svg /></TopbarButton>}
    />
  );
}

async function render(style: "classic" | "modern") {
  document.documentElement.classList.toggle("modern-style", style === "modern");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<ThemeContext.Provider value={styleValue(style)}><MemoryRouter><Bar /></MemoryRouter></ThemeContext.Provider>));
  const byLabel = (l: string) => host.querySelector(`[aria-label="${l}"]`);
  return { host, byLabel, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

describe("the top bar in Modern", () => {
  test("Classic draws the classes it drew before the Modern looks", async () => {
    const { host, unmount } = await render("classic");
    expect(classicClasses(host)).toMatchSnapshot();
    await unmount();
  });

  test("icon buttons, chips, the search field and New wear the Modern looks", async () => {
    const { host, byLabel, unmount } = await render("modern");
    for (const l of ["Hide sidebar", "Notifications", "Toggle sessions panel"]) {
      const b = byLabel(l);
      expect(b?.className).toContain("modern:size-control-sm");
      expect(b?.className).toContain("modern:rounded-control");
      expect(b?.className).toContain("modern:focus-visible:outline-[color:var(--focus-ring)]");
    }
    expect(byLabel("Sync")?.className).toContain("modern:rounded-control");
    expect(wears(host.querySelector("input"), modernField)).toBe(true);
    expect(wears(byLabel("New"), modernButton({ variant: "outline", size: "sm" }))).toBe(true);
    await unmount();
  });
});

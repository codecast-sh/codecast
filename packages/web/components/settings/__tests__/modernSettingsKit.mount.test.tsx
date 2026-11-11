// The settings kit (components/settings/ui.tsx) in the Modern style: every
// settings page draws through it, so the section header is sentence case on a
// white card, the option group's pills are chips, a link row hovers with the
// one focus ring, and SettingsBadge is the Badge's soft tint. Classic draws
// exactly the classes it drew before the Modern looks (the snapshot was taken
// from the unmodified kit; `modern:` classes are left out of it).
import { describe, expect, test } from "bun:test";
import { installModernDom, styleValue, classicClasses, wears } from "../../../test-helpers/modernDom";

installModernDom("https://app.test/settings");

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ThemeContext } = await import("../../ThemeProvider");
const { SettingsPanel, SettingsSection, SettingsRow, SettingsLinkRow, SettingsField, SettingsCallout, SettingsOptionGroup, SettingsBadge } = await import("../ui");
const { modernChip, modernPill } = await import("../../ui/modernLook");

const noop = () => {};
const Icon = (p: any) => <svg {...p} />;

function Kit() {
  return (
    <SettingsPanel>
      <SettingsSection title="General" icon={Icon as any} description="How the app behaves." actions={<button type="button">Reset</button>}>
        <SettingsRow label="Theme" description="Light or dark">
          <SettingsOptionGroup label="Theme" variant="pill" value="light" onChange={noop} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        </SettingsRow>
        <SettingsRow label="Plan"><SettingsBadge tone="cyan">Pro</SettingsBadge><SettingsBadge tone="muted">managed</SettingsBadge></SettingsRow>
        <SettingsLinkRow label="Devices" value="3 devices" onClick={noop} />
      </SettingsSection>
      <SettingsSection title="Mode" padded>
        <SettingsOptionGroup label="Mode" value="a" onChange={noop} options={[{ value: "a", label: "Auto", description: "Picks for you", mono: "--auto" }, { value: "b", label: "Manual" }]} />
        <SettingsField label="Name" hint="Shown to your team"><input /></SettingsField>
        <SettingsCallout tone="warning">Careful</SettingsCallout>
      </SettingsSection>
    </SettingsPanel>
  );
}

async function render(style: "classic" | "modern") {
  document.documentElement.classList.toggle("modern-style", style === "modern");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<ThemeContext.Provider value={styleValue(style)}><Kit /></ThemeContext.Provider>));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

describe("the settings kit in Modern", () => {
  test("Classic draws the classes it drew before the Modern looks", async () => {
    const { host, unmount } = await render("classic");
    expect(classicClasses(host)).toMatchSnapshot();
    await unmount();
  });

  test("headers, cards, option pills and badges wear the Modern looks", async () => {
    const { host, unmount } = await render("modern");
    const title = host.querySelector("[data-cc-settings-title]");
    expect(title?.className).toContain("modern:normal-case");
    expect(title?.className).toContain("modern:tracking-normal");
    const card = host.querySelector("section > div.rounded-xl");
    expect(card?.className).toContain("modern:rounded-card");
    expect(card?.className).toContain("modern:bg-sol-card");
    const pills = [...host.querySelectorAll('[aria-label="Theme"] button')];
    expect(wears(pills[0], modernChip({ active: true }))).toBe(true);
    expect(wears(pills[1], modernChip({ active: false }))).toBe(true);
    const badges = [...host.querySelectorAll("span")].filter((s) => s.textContent === "Pro" || s.textContent === "managed");
    expect(wears(badges[0], modernPill({ tone: "cyan" }))).toBe(true);
    expect(wears(badges[1], modernPill({ tone: "neutral" }))).toBe(true);
    const cards = [...host.querySelectorAll('[aria-label="Mode"] button')];
    expect(cards[0].className).toContain("modern:rounded-control");
    expect(cards[0].className).toContain("modern:border-sol-cyan");
    await unmount();
  });
});

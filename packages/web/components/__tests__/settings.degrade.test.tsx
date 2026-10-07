// EVERY SETTINGS SECTION OPENS WHEN ITS BACKEND IS MISSING.
//
// The settings modal opened on each of its sections over a convex transport
// that answers every query "Could not find public function" (test-helpers/
// missingBackend.tsx), the live site between a web push and its convex
// deploy. A section reads the viewer's profile, devices, teams, connections
// and the like; a query failing may cost a section its data, never the
// modal: each section still shows its heading and a body that says what it
// could not load (no endless "Loading…", no empty answer the server never
// gave), and no panel falls into an ErrorBoundary.
// Run: cd packages/web && bun test --isolate components/__tests__/settings.degrade.test.tsx
import { describe, expect, test } from "bun:test";
import type { SettingsSectionId } from "../../lib/settingsSections";
import { describeFailures, installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

const { mountSurface } = installDom("https://app.test/inbox");
await installMissingBackend();
await seedViewer();

const { useInboxStore } = await import("../../store/inboxStore");
// The machine roster is persisted, so a viewer who has a daemon has it cached.
useInboxStore.getState().setMachineRoster([{ device_id: "degrade-laptop", label: "Dana's laptop", platform: "darwin", is_remote: false, online: true, last_seen: Date.now(), local_project_roots: ["/Users/dana/src"] }] as any);
const { MemoryRouter } = await import("react-router");
const { SettingsModal } = await import("../settings/SettingsModal");

// Keyed by the section union, so a section added to the modal and left out
// here is a type error, not a section nobody degrades.
const SECTIONS: Record<SettingsSectionId, true> = {
  general: true,
  accounts: true,
  plan: true,
  notifications: true,
  sounds: true,
  calls: true,
  team: true,
  sync: true,
  privacy: true,
  integrations: true,
  agents: true,
  "agent-library": true,
  harness: true,
  daemon: true,
  "provider-keys": true,
  "claude-accounts": true,
  cli: true,
  devices: true,
  migrate: true,
  desktop: true,
  apps: true,
};

describe("settings sections with every query missing", () => {
  for (const section of Object.keys(SECTIONS) as SettingsSectionId[]) {
    test(section, async () => {
      useInboxStore.getState().openSettingsModal(section);
      const modal = await mountSurface(<MemoryRouter><SettingsModal /></MemoryRouter>);
      try {
        expect(describeFailures(modal)).toBe("");
        const dialog = modal.container.querySelector('[role="dialog"][aria-label="Settings"]');
        expect(dialog).not.toBeNull();
        expect(dialog!.querySelector("h2")?.textContent?.length).toBeGreaterThan(0);
        // The section's own body rendered something of its own.
        const body = dialog!.querySelector("header + div");
        const text = body?.textContent?.trim() ?? "";
        expect(text.length).toBeGreaterThan(0);
        // A failed read is said, not shown as a wait that never ends or as
        // an empty answer the server never gave.
        expect(text).not.toMatch(/Loading[^.]*…/);
        expect(text).not.toMatch(/\b0 members/);
      } finally {
        await modal.unmount();
      }
    }, 60_000);
  }
});

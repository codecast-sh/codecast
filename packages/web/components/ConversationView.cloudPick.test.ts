import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Source guards for the composer's cloud selection (ct-49427): the selected
// machine is the single source of truth for "run in the cloud". Every
// transition goes through the pure helpers in lib/sessionMachines (tested
// there), the placement decision goes through the shared predicate, and the
// store flag is never read back as truth.
const source = readFileSync(new URL("./ConversationView.tsx", import.meta.url), "utf8");
const start = source.indexOf("function ProjectSwitcher(");
const end = source.indexOf("\n}\n", source.indexOf("<SessionModeToggles", start)) + 3;
const switcher = source.slice(start, end);
const between = (from: string, to: string) => {
  const a = switcher.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = switcher.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return switcher.slice(a, b);
};

test("a chip pick and the toggle derive the selection from the pure helpers", () => {
  expect(between("const handleMachinePick = useCallback(", "const toggleCloudMode")).toContain("machineSelectionAfterPick(");
  expect(between("const toggleCloudMode = useCallback(", "const setSessionTargetDevice")).toContain("machineSelectionAfterCloudToggle(");
});

test("cloud mode is derived from the routed machine, never read from the store", () => {
  expect(switcher).toContain("const cloudMode = routedMachine ? isCloudHost(routedMachine) : lastCloudModeRef.current;");
  expect(switcher).not.toContain("useInboxStore((s) => s.cloudSessionMode)");
  // The store flag is a write-only mirror, reset when the composer unmounts.
  expect(switcher).toContain("useWatchEffect(() => { setCloudSessionMode(cloudMode); }, [cloudMode, setCloudSessionMode]);");
  expect(switcher).toContain("useWatchEffect(() => () => { setCloudSessionMode(false); }, [setCloudSessionMode]);");
});

test("handleSwitch decides placement and builds its payload with the pure helpers", () => {
  const handleSwitch = between("const handleSwitch = useCallback(", "const updateClientUI");
  // Both decisions live in lib/sessionMachines and are tested there with
  // inputs and outputs; the composer only feeds them.
  expect(handleSwitch).toContain("cloudParkNeeded({ target, locals, path: trimmed })");
  expect(handleSwitch).toContain("switchReconfigureArgs({");
  expect(switcher).not.toContain("cloudPlacementFor(");
  // The workspace and seed picks are read at call time, not from the closure:
  // the shared toggle sets the flag and re-parks in the same tick.
  expect(handleSwitch).toContain('const cloudShared = useInboxStore.getState().cloudSharedCheckout;');
  expect(handleSwitch).toContain("cloudStartFrom: resolveCloudStartFrom(useInboxStore.getState().clientState.ui),");
  // The shared toggle re-parks an existing row (only when the folder would park) so the
  // isolated cloud_spawn in flight is superseded rather than left to build a worktree.
  const toggle = between("onToggleShared={() => {", "{!picking && recentProjects.length > 0");
  expect(toggle).toContain("setCloudSharedCheckout(isolated)");
  expect(toggle).toContain('storeSession?.cloud_placement === "pending"');
  expect(toggle).toContain("handleSwitch(currentPath, undefined, routedMachine.device_id, { onlyCloudPark: true })");
  // The start-from pick re-parks a pending row the same way (ct-49433).
  const startFrom = between("onSetStartFrom={(v) => {", "{!picking && recentProjects.length > 0");
  expect(startFrom).toContain("setCloudStartFrom(v)");
  expect(startFrom).toContain('storeSession?.cloud_placement === "pending"');
  expect(startFrom).toContain("handleSwitch(currentPath, undefined, routedMachine.device_id, { onlyCloudPark: true })");
  // Nothing in the composer spells the payload's cloud fields by hand.
  expect(switcher).not.toContain("cloud_device_id:");
});

test("leaving cloud mode never ships the cloud-locked isolated value, and the routed host is the park target", () => {
  const handleSwitch = between("const handleSwitch = useCallback(", "const updateClientUI");
  // `isolated` (= isolatedToggle || cloudMode) is display state; the payload
  // carries the user's real toggle, and switchReconfigureArgs drops it for a
  // park — so the un-park that runs while cloudMode is still true cannot ask
  // the laptop for a worktree.
  expect(handleSwitch).toContain("isolated: forceIsolated ?? isolatedToggle,");
  expect(handleSwitch).not.toMatch(/isolatedToggle : isolated\)/);
  const deps = handleSwitch.slice(handleSwitch.lastIndexOf("}, ["));
  expect(deps).not.toMatch(/[\[, ]isolated[,\]]/);
  // With more than one cloud host the folder pick re-targets the one the
  // dropdown routes to, not the first host on the roster.
  expect(handleSwitch).toContain("const routedHostId = routedMachine && isCloudHost(routedMachine) ? routedMachine.device_id : cloudHost?.device_id ?? null;");
  expect(handleSwitch).toContain("(cloudMode ? routedHostId : scopedDeviceId)");
});

test("the agent-box special case and the inline chip row are gone", () => {
  expect(switcher).not.toContain("d.bot_name !== undefined) useInboxStore.getState().setCloudSessionMode(false)");
  expect(switcher).not.toContain("deviceWakesOnUse(d)");
  expect(switcher).toContain("<MachineChips");
  expect(switcher).toContain("<SessionModeToggles");
  expect(switcher).toContain("cloudToggleEnabled={cloudToggleAvailable(machineChips, cloudMode)}");
});

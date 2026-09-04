import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useInboxStore } from "../inboxStore";
import { HYDRATION_CRITICAL_KEYS, REPLICATION_CLASSIFICATION } from "../clientSyncRegistry";
import { settingsDataKey } from "../../lib/settingsData";

describe("settings local cache", () => {
  beforeEach(() => useInboxStore.setState({ settingsData: {} }));

  test("hydrates before first paint and replicates to follower windows", () => {
    expect(HYDRATION_CRITICAL_KEYS).toContain("settingsData");
    expect(REPLICATION_CLASSIFICATION.settingsData).toBe("shared");
  });

  test("keeps each settings payload when another feeder refreshes", () => {
    const profiles = settingsDataKey("accountProfiles", "alice")!;
    const mappings = settingsDataKey("directoryMappings", "alice")!;
    const store = useInboxStore.getState();
    store.syncTable("settingsData", [{ _id: profiles, value: { devices: [{ device_id: "mac" }] } }]);
    store.syncTable("settingsData", [{ _id: mappings, value: [{ path_prefix: "/src" }] }]);
    expect(useInboxStore.getState().settingsData[profiles].value.devices).toHaveLength(1);
    expect(useInboxStore.getState().settingsData[mappings].value).toHaveLength(1);
  });

  test("reconciles changed, empty and revoked payloads without retaining stale rows", () => {
    const key = settingsDataKey("teamMembers", "alice", "team-a")!;
    const store = useInboxStore.getState();
    store.syncTable("settingsData", [{ _id: key, value: [{ _id: "member", role: "admin" }] }]);
    store.syncTable("settingsData", [{ _id: key, value: [{ _id: "member", role: "member" }] }]);
    expect(useInboxStore.getState().settingsData[key].value[0].role).toBe("member");
    store.syncTable("settingsData", [{ _id: key, value: [] }]);
    expect(useInboxStore.getState().settingsData[key].value).toEqual([]);
    store.syncTable("settingsData", [{ _id: key, value: null }]);
    expect(useInboxStore.getState().settingsData[key].value).toBeNull();
  });

  test("keeps identity and explicit team queries separate", () => {
    expect(settingsDataKey("teamMembers", "alice", "team-a")).not.toBe(settingsDataKey("teamMembers", "alice", "team-b"));
    expect(settingsDataKey("accountProfiles", "alice")).not.toBe(settingsDataKey("accountProfiles", "bob"));
    expect(settingsDataKey("accountProfiles", "alice", "team-a")).toBe(settingsDataKey("accountProfiles", "alice", "team-b"));
    expect(settingsDataKey("teamMembers", "alice", null)).toBeNull();
    expect(settingsDataKey("githubInstallations", "alice", null)).toBeNull();
    expect(settingsDataKey("connections", null, "team-a")).toBeNull();
  });

  test("reuses unchanged cached payloads when the feeder repeats an answer", () => {
    const key = settingsDataKey("accountProfiles", "alice")!;
    const payload = () => [{ _id: key, value: { devices: [{ device_id: "mac" }] } }];
    useInboxStore.getState().syncTable("settingsData", payload());
    const before = useInboxStore.getState().settingsData[key];
    useInboxStore.getState().syncTable("settingsData", payload());
    expect(useInboxStore.getState().settingsData[key]).toBe(before);
  });

  test("panels do not wait for cached user data or click-triggered imports", () => {
    const root = join(import.meta.dir, "../..");
    for (const panel of ["profile", "notifications", "agents", "accounts", "sync", "team", "cli"]) {
      const source = readFileSync(join(root, "app/settings", panel, "page.tsx"), "utf8");
      expect(source).not.toMatch(/useQuery\(\s*api\.(users\.(getCurrentUser|getSyncSettings|getAgentPermissionModes|getAgentDefaultParams)|teams\.(getTeam|getUserTeams|getActiveTeamContext))/);
    }
    const modal = readFileSync(join(root, "components/settings/SettingsModal.tsx"), "utf8");
    expect(modal).not.toContain("lazy(");
    expect(modal).not.toContain("<Suspense");
    const layout = readFileSync(join(root, "components/DashboardLayout.tsx"), "utf8");
    expect(layout).not.toContain("{s.settingsModalSection && (");
    expect(layout).toContain("useSyncSettings();");
  });
});

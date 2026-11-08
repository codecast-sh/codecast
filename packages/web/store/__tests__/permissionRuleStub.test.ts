import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { permissionRuleKey } from "@codecast/shared/contracts/permissionRules";

// A rule added in Settings shows at once as a stub; the server row that answers
// it must take the stub's place rather than draw beside it (registry altKey).
describe("a saved approval added in Settings", () => {
  const owner = {};
  const rule = { project: "/tmp/proj", scope: "team:t1", permission: "bash", pattern: "npm run build *", action: "allow" as const, label: "npm run build *" };

  beforeEach(() => {
    useInboxStore.setState({ permissionRules: {}, pending: {} } as any);
    useInboxStore.getState()._setDispatch(async () => null, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  it("is one row once the server's copy syncs back", () => {
    useInboxStore.getState().addPermissionRule(rule);
    expect(Object.keys(useInboxStore.getState().permissionRules)).toHaveLength(1);

    const serverRow = { _id: "k".padEnd(32, "0"), ...rule, rule_key: permissionRuleKey(rule), created_at: 1 };
    useInboxStore.getState().syncTable("permissionRules", [serverRow]);

    const rows = Object.values(useInboxStore.getState().permissionRules) as Array<{ _id: string }>;
    expect(rows.map((r) => r._id)).toEqual([serverRow._id]);
  });
});

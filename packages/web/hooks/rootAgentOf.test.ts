import { describe, expect, test } from "bun:test";
import { rootAgentOf, type AnchorRow } from "./useSyncAnchors";

// S22: the shell's chip, sidebar entry and /anchor page all draw the root role
// from the anchor rows. Every role's standing session is such a row, so the
// picker must take the row the server marks as the root, never the oldest lead.
const row = (o: Partial<AnchorRow>): AnchorRow => ({ _id: o._id ?? "a", scope_type: "team", team_id: "t1", bot_user_id: "b", host_user_id: "h", name: o.name ?? "x", bot_name: o.name ?? "x", bot_avatar: null, team_name: "Union", ...o } as AnchorRow);

describe("rootAgentOf", () => {
  const infra = row({ _id: "infra", name: "Infra lead", role: { _id: "r6", short_id: "or-6", name: "Infra lead", handle: "infra-lead", avatar: null, status: "paused" } as any });
  const chief = row({ _id: "chief", name: "Anchor", is_root: true, role: { _id: "r10", short_id: "or-10", name: "Chief of Staff", handle: "chief-of-staff", avatar: null, status: "active" } as any });
  const personal = row({ _id: "me", scope_type: "user", team_id: null, name: "Anchor", is_root: true, role: { _id: "r22", short_id: "or-22", name: "Chief of Staff", handle: "chief-of-staff", avatar: "snail", status: "active" } as any });

  test("the marked root wins over an older lead in the same team", () => {
    expect(rootAgentOf([infra, chief, personal], "t1")?._id).toBe("chief");
  });

  test("the personal root is the user scoped marked row", () => {
    expect(rootAgentOf([infra, chief, personal], null)?._id).toBe("me");
  });

  test("a workspace with leads and no root shows nothing rather than a lead", () => {
    expect(rootAgentOf([infra], "t1")).toBeNull();
  });

  test("rows from before the server mark still find the chief of staff by handle", () => {
    const unmarked = row({ _id: "chief-old", name: "Anchor", role: { _id: "r10", short_id: "or-10", name: "Chief of Staff", handle: "chief-of-staff", avatar: null, status: "active" } as any });
    expect(rootAgentOf([infra, unmarked], "t1")?._id).toBe("chief-old");
  });

  test("a seat that is no role's yet stands in for a root that is not hired", () => {
    const bare = row({ _id: "bare", name: "Anchor" });
    expect(rootAgentOf([infra, bare], "t1")?._id).toBe("bare");
  });
});

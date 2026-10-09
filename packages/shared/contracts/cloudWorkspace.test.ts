import { describe, expect, test } from "bun:test";
import { checkoutInUseMessage, isHttpOrigin, normalizeCloudWorkspace, otherSessionInCheckout, sharedCheckoutOccupant, type CheckoutOccupantRow } from "./cloudWorkspace";

const ROOT = "/home/ubuntu/work/app";
const row = (over: Partial<CheckoutOccupantRow> = {}): CheckoutOccupantRow => ({
  conversation_id: "conv_a", short_id: "abc1234", title: "shared one", status: "active",
  cloud_workspace: "shared", cloud_checkout_path: ROOT, project_path: ROOT, ...over,
});

describe("normalizeCloudWorkspace", () => {
  test("only the literal shared is shared; absent and garbage are isolated", () => {
    expect(normalizeCloudWorkspace("shared")).toBe("shared");
    expect(normalizeCloudWorkspace("isolated")).toBe("isolated");
    expect(normalizeCloudWorkspace(undefined)).toBe("isolated");
    expect(normalizeCloudWorkspace(null)).toBe("isolated");
    expect(normalizeCloudWorkspace("SHARED")).toBe("isolated");
    expect(normalizeCloudWorkspace(1)).toBe("isolated");
  });
});

describe("sharedCheckoutOccupant", () => {
  test("a sibling moved from the same laptop folder shares the checkout instead of holding it", () => {
    expect(sharedCheckoutOccupant([row()], { projectPath: ROOT, sharedWith: ["conv_a"] })).toBeNull();
    expect(sharedCheckoutOccupant([row()], { projectPath: ROOT, sharedWith: ["conv_other"] })?.conversation_id).toBe("conv_a");
  });
  test("a placed shared row holds its checkout; killed or completed rows do not", () => {
    expect(sharedCheckoutOccupant([row()], { projectPath: ROOT })?.conversation_id).toBe("conv_a");
    expect(sharedCheckoutOccupant([row({ inbox_killed_at: 5 })], { projectPath: ROOT })).toBeNull();
    expect(sharedCheckoutOccupant([row({ status: "completed" })], { projectPath: ROOT })).toBeNull();
  });

  test("exact path and basename matches; a different repo never matches", () => {
    expect(sharedCheckoutOccupant([row()], { projectPath: "/home/ubuntu/work/other" })).toBeNull();
    expect(sharedCheckoutOccupant([row()], { repoBasename: "app" })?.conversation_id).toBe("conv_a");
    expect(sharedCheckoutOccupant([row()], { repoBasename: "other" })).toBeNull();
    // Unclaimed shared row (no checkout path yet): its project_path stands in.
    expect(sharedCheckoutOccupant([row({ cloud_checkout_path: null, project_path: "/Users/me/app" })], { repoBasename: "app" })?.conversation_id).toBe("conv_a");
    expect(sharedCheckoutOccupant([row({ cloud_checkout_path: null, project_path: "/Users/me/app" })], { projectPath: ROOT })).toBeNull();
  });

  test("a pending shared row counts only while it carries no session_error", () => {
    expect(sharedCheckoutOccupant([row({ cloud_placement: "pending" })], { projectPath: ROOT })).not.toBeNull();
    expect(sharedCheckoutOccupant([row({ cloud_placement: "pending", session_error: "cast cloud start failed" })], { projectPath: ROOT })).toBeNull();
    // Once placed, an error on the row is a session problem, not a free checkout.
    expect(sharedCheckoutOccupant([row({ session_error: "crashed" })], { projectPath: ROOT })).not.toBeNull();
  });

  test("a merging claimer shares the checkout with moved sessions, never with a shared row on its own branch", () => {
    const moved = row({ conversation_id: "conv_m", cloud_workspace: null, cloud_checkout_path: null, project_path: ROOT });
    expect(sharedCheckoutOccupant([moved], { projectPath: ROOT, merging: true })).toBeNull();
    expect(sharedCheckoutOccupant([row()], { projectPath: ROOT, merging: true })?.conversation_id).toBe("conv_a");
  });

  test("legacy: any alive row whose project_path is the root (a moved session) occupies it", () => {
    const moved = row({ conversation_id: "conv_m", cloud_workspace: null, cloud_checkout_path: null, project_path: ROOT });
    expect(sharedCheckoutOccupant([moved], { projectPath: ROOT })?.conversation_id).toBe("conv_m");
    expect(sharedCheckoutOccupant([moved], { repoBasename: "app" })).toBeNull();
    expect(sharedCheckoutOccupant([{ ...moved, inbox_killed_at: 1 }], { projectPath: ROOT })).toBeNull();
    // An isolated worktree under the root is not the root.
    expect(sharedCheckoutOccupant([row({ cloud_workspace: "isolated", cloud_checkout_path: null, project_path: `${ROOT}/.codecast/worktrees/x` })], { projectPath: ROOT })).toBeNull();
  });

  test("excludeId skips the row being claimed; the first match wins", () => {
    expect(sharedCheckoutOccupant([row()], { projectPath: ROOT, excludeId: "conv_a" })).toBeNull();
    const rows = [row({ conversation_id: "conv_1", short_id: "first" }), row({ conversation_id: "conv_2", short_id: "second" })];
    expect(sharedCheckoutOccupant(rows, { projectPath: ROOT })?.short_id).toBe("first");
    expect(sharedCheckoutOccupant(rows, { projectPath: ROOT, excludeId: "conv_1" })?.short_id).toBe("second");
  });
});

describe("checkoutInUseMessage", () => {
  test("names the session and offers the two ways out", () => {
    expect(checkoutInUseMessage(ROOT, row())).toBe(
      "the host checkout /home/ubuntu/work/app is in use by session abc1234 (shared one) — run this session isolated, or finish/kill that one",
    );
    expect(checkoutInUseMessage(ROOT, { conversation_id: "conversations_abcdef", title: "  " })).toContain("session convers (untitled)");
  });
});

describe("isHttpOrigin", () => {
  test("a scheme and host, nothing more", () => {
    expect(isHttpOrigin("https://github.com")).toBe(true);
    expect(isHttpOrigin("http://localhost:3000")).toBe(true);
    expect(isHttpOrigin("https://github.com/")).toBe(false);
    expect(isHttpOrigin("https://github.com/login?token=SECRET")).toBe(false);
    expect(isHttpOrigin("ftp://example.com")).toBe(false);
    expect(isHttpOrigin("github.com")).toBe(false);
    expect(isHttpOrigin(undefined)).toBe(false);
  });
});

describe("otherSessionInCheckout", () => {
  const at = (id: string, p: string, over: Partial<CheckoutOccupantRow> = {}) => row({ conversation_id: id, cloud_workspace: null, cloud_checkout_path: null, project_path: p, ...over });
  test("a session in the checkout or a folder of it counts; the departing one, its own worktrees and ended rows do not", () => {
    expect(otherSessionInCheckout([at("me", ROOT)], ROOT, "me")).toBeNull();
    expect(otherSessionInCheckout([at("b", `${ROOT}/packages/web`)], ROOT, "me")?.conversation_id).toBe("b");
    expect(otherSessionInCheckout([at("b", `${ROOT}/.codecast/worktrees/x`)], ROOT, "me")).toBeNull();
    expect(otherSessionInCheckout([at("b", `${ROOT}-other`)], ROOT, "me")).toBeNull();
    expect(otherSessionInCheckout([at("b", ROOT, { inbox_killed_at: 1 })], ROOT, "me")).toBeNull();
    expect(otherSessionInCheckout([row()], ROOT, "me")?.conversation_id).toBe("conv_a");
  });
});

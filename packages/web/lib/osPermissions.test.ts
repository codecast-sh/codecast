import { test, expect, describe } from "bun:test";
import {
  COMPUTER_PERMISSION_KINDS,
  OS_PERMISSIONS,
  OS_PERMISSION_KINDS,
  browserPermissionToReadiness,
  getComputerPermissions,
  isPermissionActionable,
  permissionActionLabel,
  permissionHint,
} from "./osPermissions";

// These run outside a browser: isElectron() is false, so the browser branch
// of every surface-dependent helper is what's under test.

describe("registry", () => {
  test("every kind has a label, a reason and a required flag", () => {
    for (const k of OS_PERMISSION_KINDS) {
      expect(OS_PERMISSIONS[k].kind).toBe(k);
      expect(OS_PERMISSIONS[k].label.length).toBeGreaterThan(0);
      expect(OS_PERMISSIONS[k].why.length).toBeGreaterThan(0);
      expect(typeof OS_PERMISSIONS[k].required).toBe("boolean");
    }
  });

  test("notifications and microphone are the required pair", () => {
    expect(OS_PERMISSION_KINDS.filter((k) => OS_PERMISSIONS[k].required)).toEqual(["notifications", "microphone"]);
  });
});

describe("browser permission mapping", () => {
  test("Permissions API states map onto readiness", () => {
    expect(browserPermissionToReadiness("granted")).toBe("granted");
    expect(browserPermissionToReadiness("denied")).toBe("off");
    expect(browserPermissionToReadiness("prompt")).toBe("ask");
    expect(browserPermissionToReadiness(undefined)).toBe("unknown");
  });
});

describe("actions in a browser", () => {
  test("ask is actionable; a browser's off is not (no programmatic path)", () => {
    expect(isPermissionActionable("ask")).toBe(true);
    expect(isPermissionActionable("off")).toBe(false);
    expect(isPermissionActionable("granted")).toBe(false);
    expect(isPermissionActionable("unknown")).toBe(false);
    expect(isPermissionActionable("n/a")).toBe(false);
  });

  test("button label follows actionability", () => {
    expect(permissionActionLabel("ask")).toBe("Turn on");
    expect(permissionActionLabel("off")).toBeNull();
    expect(permissionActionLabel("granted")).toBeNull();
  });

  test("hints name the remedy for the surface, nothing when granted", () => {
    expect(permissionHint("microphone", "off")).toMatch(/blocked for this site/);
    expect(permissionHint("camera", "ask")).toMatch(/hasn't been allowed/);
    expect(permissionHint("notifications", "granted")).toBeNull();
    expect(permissionHint("screen", "n/a")).toBeNull();
  });
});

// The codecast computer grants. They live in the same registry and draw the
// same row, but they belong to a separate helper app — so the copy has to say
// so, and a browser has nothing to show.
describe("the codecast computer grants", () => {
  test("both kinds carry a label and a paragraph, and neither gates setup", () => {
    for (const k of COMPUTER_PERMISSION_KINDS) {
      expect(OS_PERMISSIONS[k].kind).toBe(k);
      expect(OS_PERMISSIONS[k].label.length).toBeGreaterThan(0);
      expect(OS_PERMISSIONS[k].why).toContain("codecast computer");
      expect(OS_PERMISSIONS[k].required).toBe(false);
    }
  });

  test("they are not part of the map the app polls for itself", () => {
    // The app's own four are read at boot and on a timer; these two are not,
    // because each one launches the helper.
    for (const k of COMPUTER_PERMISSION_KINDS) expect(OS_PERMISSION_KINDS).not.toContain(k as never);
  });

  test("a missing grant names the helper, never Codecast", () => {
    // The generic sentence would say "turned off for Codecast", which is the
    // one thing that is not true: the desktop app never holds these.
    for (const k of COMPUTER_PERMISSION_KINDS) {
      expect(permissionHint(k, "off")).toContain("codecast computer");
      expect(permissionHint(k, "off")).not.toContain("Codecast in System Settings");
      expect(permissionHint(k, "granted")).toBeNull();
    }
    expect(permissionHint("computerAccessibility", "off")).toMatch(/Accessibility/);
    expect(permissionHint("computerScreen", "off")).toMatch(/Screen Recording/);
  });

  test("a browser has no helper, so it reports nothing to set up", async () => {
    expect(await getComputerPermissions()).toEqual({ computerAccessibility: "n/a", computerScreen: "n/a" });
  });
});

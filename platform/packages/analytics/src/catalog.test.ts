import { describe, it, expect } from "bun:test";
import {
  createTrackGate,
  defineCatalog,
  resolveOptOut,
  SESSION_EVENT_CAP,
  validateEvent,
  type EventProps,
} from "./catalog";

const catalog = defineCatalog({
  install_command_copied: {
    location: { type: "string", max: 64 },
    platform: { type: "string", values: ["mac", "linux", "windows"] },
    with_token: { type: "boolean" },
  },
  tip_seen: {
    tip_id: { type: "string", max: 64 },
    type: { type: "string", max: 32, optional: true },
  },
  digest_heartbeat: {
    checks: { type: "number" },
    skips: { type: "counters", maxKeys: 4 },
  },
});

const copied = { location: "sidebar", platform: "mac", with_token: true };

describe("validateEvent", () => {
  it("passes an event that matches the catalog", () => {
    expect(validateEvent(catalog, "install_command_copied", copied)).toEqual({ ok: true, properties: copied });
  });

  it("drops an unknown event name", () => {
    const result = validateEvent(catalog, "install_command_copyed", copied);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("unknown event");
  });

  it("drops a name that only exists on the prototype chain", () => {
    expect(validateEvent(catalog, "constructor", {}).ok).toBe(false);
    expect(validateEvent(catalog, "toString", {}).ok).toBe(false);
  });

  it("drops an unknown property key", () => {
    const result = validateEvent(catalog, "install_command_copied", { ...copied, user_email: "a@b.c" });
    expect(result.ok === false && result.reason).toContain("unknown property user_email");
  });

  it("drops a missing required key and accepts a missing optional one", () => {
    expect(validateEvent(catalog, "tip_seen", {}).ok).toBe(false);
    expect(validateEvent(catalog, "tip_seen", { tip_id: "welcome" }).ok).toBe(true);
  });

  it("drops a wrong type", () => {
    expect(validateEvent(catalog, "install_command_copied", { ...copied, with_token: "yes" }).ok).toBe(false);
    expect(validateEvent(catalog, "digest_heartbeat", { checks: "3", skips: {} }).ok).toBe(false);
  });

  it("drops a number that is not finite", () => {
    expect(validateEvent(catalog, "digest_heartbeat", { checks: NaN, skips: {} }).ok).toBe(false);
    expect(validateEvent(catalog, "digest_heartbeat", { checks: Infinity, skips: {} }).ok).toBe(false);
  });

  it("drops a value outside a declared enum", () => {
    const result = validateEvent(catalog, "install_command_copied", { ...copied, platform: "bsd" });
    expect(result.ok === false && result.reason).toContain("not one of");
  });

  it("drops a string over its cap", () => {
    const result = validateEvent(catalog, "tip_seen", { tip_id: "x".repeat(65) });
    expect(result.ok === false && result.reason).toContain("longer than 64");
    expect(validateEvent(catalog, "tip_seen", { tip_id: "x".repeat(64) }).ok).toBe(true);
  });

  it("checks counter bags for shape and key count", () => {
    expect(validateEvent(catalog, "digest_heartbeat", { checks: 1, skips: { a: 1, b: 2 } }).ok).toBe(true);
    expect(validateEvent(catalog, "digest_heartbeat", { checks: 1, skips: { a: "1" } }).ok).toBe(false);
    expect(validateEvent(catalog, "digest_heartbeat", { checks: 1, skips: [] }).ok).toBe(false);
    expect(validateEvent(catalog, "digest_heartbeat", { checks: 1, skips: { a: 1, b: 1, c: 1, d: 1, e: 1 } }).ok).toBe(
      false,
    );
  });

  it("types the properties of an event from its spec", () => {
    const props: EventProps<(typeof catalog)["install_command_copied"]> = {
      location: "sidebar",
      platform: "mac",
      with_token: false,
    };
    expect(props.platform).toBe("mac");
    // @ts-expect-error "bsd" is not one of the declared platform values
    const bad: EventProps<(typeof catalog)["install_command_copied"]> = { ...props, platform: "bsd" };
    expect(bad.platform).toBe("bsd");
  });
});

describe("resolveOptOut", () => {
  it("is off by default", () => {
    expect(resolveOptOut({ env: {} })).toEqual({ optedOut: false, reason: null });
  });

  it("honours DO_NOT_TRACK", () => {
    expect(resolveOptOut({ env: { DO_NOT_TRACK: "1" } })).toEqual({ optedOut: true, reason: "do_not_track" });
    expect(resolveOptOut({ env: { DO_NOT_TRACK: "TRUE" } }).optedOut).toBe(true);
    expect(resolveOptOut({ doNotTrack: true }).reason).toBe("do_not_track");
  });

  it("ignores a DO_NOT_TRACK value that is not a recognised flag", () => {
    expect(resolveOptOut({ env: { DO_NOT_TRACK: "0" } }).optedOut).toBe(false);
    expect(resolveOptOut({ env: { DO_NOT_TRACK: "" } }).optedOut).toBe(false);
  });

  it("opts out of CI by flag and by presence", () => {
    expect(resolveOptOut({ env: { CI: "true" } })).toEqual({ optedOut: true, reason: "ci" });
    expect(resolveOptOut({ env: { GITHUB_ACTIONS: "1" } }).reason).toBe("ci");
    expect(resolveOptOut({ env: { JENKINS_URL: "https://ci.example" } }).reason).toBe("ci");
    expect(resolveOptOut({ env: { CI: "false" } }).optedOut).toBe(false);
  });

  it("honours an app's own kill switch variable", () => {
    expect(resolveOptOut({ env: { CODECAST_TELEMETRY_DISABLED: "1" }, extraVars: ["CODECAST_TELEMETRY_DISABLED"] }).optedOut).toBe(
      true,
    );
  });
});

describe("createTrackGate", () => {
  const silent = () => {};

  it("passes a valid event and counts it", () => {
    const gate = createTrackGate({ catalog, warn: silent });
    expect(gate.check("install_command_copied", copied).ok).toBe(true);
    expect(gate.sent).toBe(1);
  });

  it("does not count a dropped event", () => {
    const gate = createTrackGate({ catalog, warn: silent });
    gate.check("nope", {});
    gate.check("tip_seen", {});
    expect(gate.sent).toBe(0);
  });

  it("stops at the session cap", () => {
    const gate = createTrackGate({ catalog, sessionCap: 3, warn: silent });
    for (let i = 0; i < 3; i++) expect(gate.check("tip_seen", { tip_id: "t" }).ok).toBe(true);
    const overflow = gate.check("tip_seen", { tip_id: "t" });
    expect(overflow.ok).toBe(false);
    expect(overflow.ok === false && overflow.reason).toContain("session event cap (3)");
    expect(gate.sent).toBe(3);
  });

  it("defaults the cap to 1000 events per session", () => {
    const gate = createTrackGate({ catalog, warn: silent });
    for (let i = 0; i < SESSION_EVENT_CAP; i++) gate.check("tip_seen", { tip_id: "t" });
    expect(gate.sent).toBe(SESSION_EVENT_CAP);
    expect(gate.check("tip_seen", { tip_id: "t" }).ok).toBe(false);
  });

  it("warns once about the cap however many events overflow", () => {
    const warnings: string[] = [];
    const gate = createTrackGate({ catalog, sessionCap: 1, warn: (m) => warnings.push(m) });
    for (let i = 0; i < 50; i++) gate.check("tip_seen", { tip_id: "t" });
    expect(warnings.filter((m) => m.includes("session event cap")).length).toBe(1);
  });

  it("warns once per event name per minute about a drop", () => {
    const warnings: string[] = [];
    const gate = createTrackGate({ catalog, warn: (m) => warnings.push(m) });
    for (let i = 0; i < 20; i++) gate.check("tip_seen", { tip_id: 5 as never });
    expect(warnings.length).toBe(1);
  });

  it("passes nothing when opted out, cap and catalog notwithstanding", () => {
    const gate = createTrackGate({ catalog, optedOut: true, warn: silent });
    expect(gate.check("install_command_copied", copied).ok).toBe(false);
    expect(gate.sent).toBe(0);
  });

  it("reset starts a new session's count", () => {
    const gate = createTrackGate({ catalog, sessionCap: 1, warn: silent });
    gate.check("tip_seen", { tip_id: "t" });
    expect(gate.check("tip_seen", { tip_id: "t" }).ok).toBe(false);
    gate.reset();
    expect(gate.check("tip_seen", { tip_id: "t" }).ok).toBe(true);
  });

  it("accepts anything when no catalog is configured", () => {
    const gate = createTrackGate({ warn: silent });
    expect(gate.check("whatever", { anything: true }).ok).toBe(true);
  });
});

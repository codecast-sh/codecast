import { describe, it, expect } from "bun:test";
import { createTrackGate, resolveOptOut, validateEvent } from "@platform/analytics/catalog";
import { CODECAST_EVENTS, TELEMETRY_DISABLED_VAR } from "./events";

const gate = () => createTrackGate({ catalog: CODECAST_EVENTS, warn: () => {} });

describe("the codecast event catalog", () => {
  it("accepts every event exactly as its call site sends it", () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["install_command_copied", { location: "settings_cli", platform: "unix", with_token: true }],
      ["install_script_viewed", { location: "landing", platform: "windows" }],
      ["desktop_download_clicked", { location: "download_page_auto" }],
      ["ios_app_clicked", { location: "landing_chip" }],
      ["install_script_downloaded", { script: "sh" }],
      ["desktop_dmg_downloaded", { version: "1.1.100" }],
      ["setup_token_generated", {}],
      ["cli_authed", { method: "setup_token" }],
      ["cli_daemon_connected", { cli_version: "1.1.100", cli_platform: "darwin-arm64" }],
      ["first_session_synced", { agent_type: "claude_code" }],
      ["nux_tour_opened", {}],
      ["nux_tour_step", { step: 2 }],
      ["nux_tour_finished", { step: 4 }],
      ["nux_tour_skipped", { step: 1 }],
      ["tip_seen", { tip_id: "w-palette", type: "whisper" }],
      ["tip_seen", { tip_id: "m-first-session", type: "milestone" }],
      ["tip_dismissed", { tip_id: "w-search", type: "whisper" }],
      ["tip_completed", { tip_id: "w-search", type: "whisper" }],
      ["inline_tip_dismissed", { tip_id: "i-compose" }],
      ["tips_level_changed", { level: "subtle" }],
      ["synclog_apply", { direct: 12, refetch: 3, ratio: 0.8 }],
      ["synclog_crawl_healed", { namespace: "tasks", count: 2 }],
      [
        "inbox_digest_heartbeat",
        {
          scope: "mine",
          platform: "web",
          checks: 10,
          mismatches: 0,
          heals: 0,
          heals_missing: 0,
          max_payload_age_ms: 1200,
          disabled: 0,
          probes: 1,
          skips: { scope_uncovered: 3, version_skew: 0 },
        },
      ],
      [
        "inbox_drift",
        {
          scope: "mine",
          platform: "desktop",
          missing: 1,
          extra: 0,
          bucket_deltas: 2,
          fold_deltas: 0,
          payload_age_ms: 900,
          epoch: 41,
        },
      ],
      ["inbox_drift_persistent", { scope: "mine", platform: "web", heals_in_window: 3, window_ms: 300000 }],
      ["inbox_digest_version_skew", { scope: "mine", platform: "web", payload_v: 4, client_v: 5 }],
    ];
    for (const [name, properties] of calls) {
      const result = validateEvent(CODECAST_EVENTS, name, properties);
      expect(result.ok ? "ok" : `${name}: ${result.reason}`).toBe("ok");
    }
  });

  it("drops a misspelled event name", () => {
    expect(validateEvent(CODECAST_EVENTS, "desktop_download_click", { location: "sidebar" }).ok).toBe(false);
  });

  it("drops a property nobody declared, which is how user text would arrive", () => {
    const result = validateEvent(CODECAST_EVENTS, "tip_seen", { tip_id: "w-palette", prompt: "my secret prompt" });
    expect(result.ok === false && result.reason).toContain("unknown property prompt");
  });

  it("caps free-form strings", () => {
    expect(validateEvent(CODECAST_EVENTS, "desktop_download_clicked", { location: "x".repeat(65) }).ok).toBe(false);
  });

  it("holds the agent list and the auth methods to their unions", () => {
    expect(validateEvent(CODECAST_EVENTS, "first_session_synced", { agent_type: "claude_code" }).ok).toBe(true);
    expect(validateEvent(CODECAST_EVENTS, "first_session_synced", { agent_type: "amp" }).ok).toBe(false);
    expect(validateEvent(CODECAST_EVENTS, "cli_authed", { method: "magic_link" }).ok).toBe(false);
  });

  it("stops a session at 1000 events", () => {
    const g = gate();
    for (let i = 0; i < 1000; i++) expect(g.check("nux_tour_step", { step: i }).ok).toBe(true);
    expect(g.check("nux_tour_step", { step: 1000 }).ok).toBe(false);
    expect(g.sent).toBe(1000);
  });
});

// The gate runs on every node surface (Convex, the web server), so these are
// the variables that turn codecast telemetry off there. The browser has no env
// and reads navigator.doNotTrack instead.
describe("the opt out codecast's node surfaces honour", () => {
  it("sends nothing under DO_NOT_TRACK, in CI, or under the codecast kill switch", () => {
    for (const env of [
      { DO_NOT_TRACK: "1" },
      { CI: "true" },
      { GITHUB_ACTIONS: "1" },
      { [TELEMETRY_DISABLED_VAR]: "1" },
    ]) {
      const { optedOut } = resolveOptOut({ env, extraVars: [TELEMETRY_DISABLED_VAR] });
      expect(`${Object.keys(env)[0]}: ${optedOut}`).toBe(`${Object.keys(env)[0]}: true`);
    }
  });

  it("sends normally on a developer's machine", () => {
    expect(resolveOptOut({ env: { HOME: "/Users/dev" }, extraVars: [TELEMETRY_DISABLED_VAR] }).optedOut).toBe(false);
  });

  it("drops every event once opted out, valid ones included", () => {
    const g = createTrackGate({ catalog: CODECAST_EVENTS, optedOut: true, warn: () => {} });
    expect(g.check("cli_authed", { method: "browser" }).ok).toBe(false);
    expect(g.sent).toBe(0);
  });
});

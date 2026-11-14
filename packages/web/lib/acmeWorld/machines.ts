// Alex's machines as the device-scoped screens read them (Agent features,
// Settings > Devices, Provider Keys, Claude Accounts): the laptop and the
// acme-linux cloud machine from ./extras, with the feature switches their
// heartbeats report, plus an acme-mac cloud Mac that sleeps until a session
// moves to it. A command a screen sends a machine (a setup check, a sign-in
// probe) is answered the way the machine would answer it, through the
// watched-command outcome. Mobile's Metro reaches this file, so imports stay
// relative.

import type { AcmePart } from "./parts";
import { MACHINES } from "./extras";
import { HOUR, MIN, cid } from "./world";

export const LAPTOP_ID = "acme-mbp-alex";
export const LINUX_ID = "acme-linux";
export const MAC_ID = "acme-mac";

/** The features switched on on Alex's laptop: the hands-on-the-machine set and the everyday ones. */
const LAPTOP_SNIPPETS = Object.fromEntries(
  ["browser", "computer", "check", "vault", "limits", "skills", "memory", "messaging", "tasks", "state", "pr", "decide", "publish", "visual", "triggers", "workflows", "orchestration"].map((s) => [s, true]),
);

export const MACHINE_ROSTER = (now: number) => {
  const [laptop, linux] = MACHINES(now) as any[];
  return [
    { ...laptop, cli_version: "1.1.240", settings: { snippets: LAPTOP_SNIPPETS, stable_mode: "team", stable_global: false, hooks_enabled: true, auto_update: true } },
    {
      ...linux,
      cli_version: "1.1.240",
      cloud_host: { ...linux.cloud_host, instance_type: "t3.xlarge", hourly_usd: 0.1664, disk_monthly_usd: 6.4, disk_gib: 80, idle_stop_minutes: 30, images: [], logins_held: [], at: now - MIN },
      settings: { snippets: { ...LAPTOP_SNIPPETS, computer: false }, stable_mode: "team", hooks_enabled: true, auto_update: true } },
    {
      device_id: MAC_ID,
      label: "acme-mac",
      platform: "darwin",
      last_seen: now - 6 * HOUR,
      is_remote: true,
      online: false,
      local_project_roots: ["~/src"],
      cli_version: "1.1.240",
      settings: { snippets: LAPTOP_SNIPPETS, stable_mode: "team", hooks_enabled: true },
    },
  ];
};

/* ── Commands a screen sends a machine, and the machine's answers ─────────── */

/** How each tool's setup stands on the laptop. `?acme-setup=pending` in the
 *  address shows the macOS grants not yet given (the Computer card's steps). */
function setupStatus(tool: string, forSession: boolean) {
  // A session's own card (a blocked step) always finds the step not done yet.
  const pending = forSession || (typeof location !== "undefined" && new URLSearchParams(location.search).get("acme-setup") === "pending");
  // `installed` stays unreported while pending: a known-missing extension hides the Pair step.
  if (tool === "browser") return { tool, ready: !pending, ...(pending ? {} : { installed: true }), paired: !pending, connected: !pending, chrome_running: true };
  return { tool, ready: !pending, accessibility: !pending, screen_recording: !pending, supported: true };
}

const outcomes = new Map<string, unknown>();
let commandSeq = 0;
/** A command id for this outcome; Convex-shaped, unique per send so each watch reads fresh. */
function sent(outcome: unknown) {
  const id = cid(`cmd${++commandSeq}x${Date.now().toString(36)}`);
  outcomes.set(id, outcome);
  return id;
}

export const MACHINE_ANSWERS: Record<string, (args: any) => unknown> = {
  "devices:listDevices": () => MACHINE_ROSTER(Date.now()),
  "devices:enqueueAgentToolSetupCommand": (args) => ({ command_id: sent({ state: "done", setup: setupStatus(String(args?.tool), !!args?.conversation_id) }) }),
  // The laptop's Codex sign-in, as Connect Codex checks it.
  "devices:enqueueCloudAgentLoginCommand": () => ({ command_id: sent({ state: "done", login: "signed_in", account: "alex@acme.dev", plan: "ChatGPT Plus" }) }),
  "devices:watchedCommandOutcome": (args) => outcomes.get(String(args?.command_id)) ?? { state: "pending" },
};

export const MACHINES_PART: AcmePart = {
  name: "machines",
  answers: MACHINE_ANSWERS,
  // The roster in the store from the first frame, for an app whose feeder does not
  // run in its fixture mode (the phone's store shots); the web feeder answers the same rows.
  seed: (s, now) => s.setMachineRoster(MACHINE_ROSTER(now)),
};

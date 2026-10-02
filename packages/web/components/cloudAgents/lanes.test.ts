import { afterEach, describe, expect, test } from "bun:test";
import { CLOUD_AGENT_PROVIDERS, cloudAgentLaunchKey, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { lastCloudLaunch } from "./lanes";

const before = useInboxStore.getState().sessions;
afterEach(() => useInboxStore.setState({ sessions: before }));

function launched(...rows: { model: string; at: number }[]) {
  useInboxStore.setState({ sessions: Object.fromEntries(rows.map((r, i) => [`s${i}`, { _id: `s${i}`, agent_type: "codex", model: r.model, started_at: r.at }])) as never });
}

/** The Agents API lane's default launch. */
const API = cloudAgentLaunchKey(CLOUD_AGENT_PROVIDERS.codex_api, { model: CLOUD_AGENT_PROVIDERS.codex_api.defaultModel ?? "" });
const only = (id: string) => (lane: CloudAgentProviderSpec) => lane.id === id;

describe("lastCloudLaunch", () => {
  test("starts where the person last ran", () => {
    launched({ model: "cloud", at: 1 }, { model: API, at: 2 });
    expect(lastCloudLaunch("codex")).toBe(API);
  });

  test("a lane the machine can't drive now gives way to one it can: its newest launch, else its default", () => {
    launched({ model: "cloud:ask", at: 1 }, { model: API, at: 2 });
    expect(lastCloudLaunch("codex", undefined, only("codex"))).toBe("cloud");
    launched({ model: API, at: 2 });
    expect(lastCloudLaunch("codex", undefined, only("codex"))).toBe(CLOUD_AGENT_PROVIDERS.codex.modelPrefix);
    // No lane it can drive: still where the person last ran, for the connect button to show there.
    expect(lastCloudLaunch("codex", undefined, () => false)).toBe(API);
  });
});

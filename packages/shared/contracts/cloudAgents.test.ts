import { describe, expect, test } from "bun:test";
import { CLOUD_AGENT_PROVIDERS, cloudAgentCredentialError, cloudAgentModel, cloudAgentProviderForLaunch, cloudAgentProviderOfSession, cloudAgentProvidersFor } from "./cloudAgents";
import { CLOUD_SESSION_SOURCES } from "./cloudSessionSync";
import { CURSOR_MODEL_OPTIONS } from "./modelOptions";

describe("cloud agent providers", () => {
  test("a launch model key picks the provider and its model; anything else is a local launch", () => {
    expect(cloudAgentModel("cursor", "cloud")).toBe("");
    expect(cloudAgentModel("cursor", "cloud:composer-2.5")).toBe("composer-2.5");
    expect(cloudAgentModel("cursor", "composer-2.5")).toBeNull();
    expect(cloudAgentModel("cursor", "cloudy")).toBeNull();
    expect(cloudAgentModel("cursor", undefined)).toBeNull();
    // The key names a provider only for its own agent type.
    expect(cloudAgentModel("codex", "cloud")).toBeNull();
    expect(cloudAgentProviderForLaunch("cursor", "cloud:x")?.id).toBe("cursor");
    // Every cloud option Cursor lists resolves; no local one does.
    for (const m of CURSOR_MODEL_OPTIONS) expect(cloudAgentModel("cursor", m.key) !== null).toBe(m.key.startsWith("cloud"));
  });

  test("a session is a provider's by agent type and id prefix", () => {
    expect(cloudAgentProviderOfSession("cursor", "bc-f778d439-1bd2")?.label).toBe("Cursor Cloud");
    expect(cloudAgentProviderOfSession("cursor", "0f9e-local-chat")).toBeNull();
    expect(cloudAgentProviderOfSession("codex", "bc-f778d439")).toBeNull();
    expect(CLOUD_AGENT_PROVIDERS.cursor.agentUrl("bc-1")).toBe("https://cursor.com/agents/bc-1");
    expect(cloudAgentProvidersFor("cursor").map((s) => s.id)).toEqual(["cursor"]);
    expect(cloudAgentProvidersFor("claude_code")).toEqual([]);
  });

  test("the daemon's credential cards are recognized, other auth errors are not", () => {
    expect(cloudAgentCredentialError("cursor", "Cursor Cloud needs a Cursor API key on this machine.")?.id).toBe("cursor");
    expect(cloudAgentCredentialError("cursor", "Cursor rejected the API key on this machine (Invalid User API Key).")?.id).toBe("cursor");
    expect(cloudAgentCredentialError("cursor", "Not logged in: run cursor-agent login")).toBeNull();
    expect(cloudAgentCredentialError("codex", "Cursor API key")).toBeNull();
  });

  test("each provider's sync source exists", () => {
    for (const spec of Object.values(CLOUD_AGENT_PROVIDERS)) expect(CLOUD_SESSION_SOURCES[spec.syncSource]).toBeDefined();
  });
});

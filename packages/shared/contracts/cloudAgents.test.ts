import { describe, expect, test } from "bun:test";
import { CLOUD_AGENT_PROVIDERS, cloudAgentCredentialError, cloudAgentModel, cloudAgentProviderForKey, cloudAgentProviderForLaunch, cloudAgentProviderOfSession, cloudAgentProvidersFor, isCloudAgentId } from "./cloudAgents";
import { CLOUD_SESSION_SOURCES } from "./cloudSessionSync";
import { CLIENT_ERROR_BANNER_PREFIX, classifyApiErrorBanner } from "./apiErrorBanner";
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
    expect(isCloudAgentId(CLOUD_AGENT_PROVIDERS.cursor, "bc-1")).toBe(true);
    expect(isCloudAgentId(CLOUD_AGENT_PROVIDERS.cursor, "state.json")).toBe(false);
  });

  test("a Provider Keys entry names the provider whose credential it is", () => {
    expect(cloudAgentProviderForKey("cursor")?.id).toBe("cursor");
    expect(cloudAgentProviderForKey("openai")).toBeNull();
  });

  test("the daemon's credential cards are recognized by their copy, and are auth banners", () => {
    const cards = CLOUD_AGENT_PROVIDERS.cursor.credentialCards;
    for (const message of [cards.missing, `${cards.rejected} (Invalid User API Key).`]) {
      expect(cloudAgentCredentialError("cursor", message)?.id).toBe("cursor");
      expect(classifyApiErrorBanner(`${CLIENT_ERROR_BANNER_PREFIX} ${message}`)).toBe("auth");
    }
    // Cards posted before the copy moved into the spec read the same.
    expect(cloudAgentCredentialError("cursor", "Cursor Cloud needs a Cursor API key on this machine.")?.id).toBe("cursor");
    expect(cloudAgentCredentialError("cursor", "Not logged in: run cursor-agent login")).toBeNull();
    expect(cloudAgentCredentialError("codex", cards.missing)).toBeNull();
  });

  test("each provider's sync source exists", () => {
    for (const spec of Object.values(CLOUD_AGENT_PROVIDERS)) expect(CLOUD_SESSION_SOURCES[spec.syncSource]).toBeDefined();
  });
});

import { describe, expect, test } from "bun:test";
import { CLOUD_AGENT_PROVIDERS, cloudAgentCardText, cloudAgentCredentialError, cloudAgentModel, signInExpired, cloudAgentProviderForKey, cloudAgentProviderForLaunch, cloudAgentProviderOfSession, cloudAgentProvidersFor, cloudAgentSetupSentence, cloudAgentExpiryDate, isCloudAgentId } from "./cloudAgents";
import { CLOUD_SESSION_SOURCES, cloudSessionSyncOn, cloudSessionSyncSettings } from "./cloudSessionSync";
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
    expect(cloudAgentModel("claude_code", "cloud")).toBeNull();
    expect(cloudAgentProviderForLaunch("codex", "cloud")?.id).toBe("codex");
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
    expect(cloudAgentProviderOfSession("codex", "task_e_6abc48f2d3b0832e9e4bb4b303d1bc45")?.label).toBe("Codex Cloud");
    expect(cloudAgentProviderOfSession("codex", "019a2f3e-7c1d-7e20-9f00-1a2b3c4d5e6f")).toBeNull();
    expect(CLOUD_AGENT_PROVIDERS.codex.agentUrl("task_e_1")).toBe("https://chatgpt.com/codex/tasks/task_e_1");
    // Codex Cloud syncs before the composer can start it.
    expect(cloudAgentProvidersFor("codex")).toEqual([]);
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

  test("a card names the machine the daemon runs on, and is recognized whatever machine it names", () => {
    const codex = CLOUD_AGENT_PROVIDERS.codex.credentialCards;
    const expired = `${cloudAgentCardText(codex.expired!, "Ashot's MacBook (2)")} Oct 5.`;
    expect(expired).toBe("The Codex sign-in on Ashot's MacBook (2) expired Oct 5.");
    expect(cloudAgentCredentialError("codex", expired)?.id).toBe("codex");
    expect(cloudAgentCredentialError("codex", cloudAgentCardText(codex.missing, "linux-host"))?.id).toBe("codex");
    // Cards written before the machine was named.
    expect(cloudAgentCredentialError("codex", "Codex refused the sign-in on this machine (the sign-in expired 2026-10-05).")?.id).toBe("codex");
    expect(cloudAgentCredentialError("codex", "The Codex sign-in on is fine")).toBeNull();
  });

  test("a sign-in codecast only reads has expired once its expiry is past; one with none never has", () => {
    expect(signInExpired(1_000, 1_000)).toBe(true);
    expect(signInExpired(1_001, 1_000)).toBe(false);
    expect(signInExpired(undefined, 1_000)).toBe(false);
  });

  test("each provider's sync source exists", () => {
    for (const spec of Object.values(CLOUD_AGENT_PROVIDERS)) expect(CLOUD_SESSION_SOURCES[spec.syncSource]).toBeDefined();
  });

  test("a source syncs by its setting, else by its default: Codex Cloud waits to be turned on", () => {
    expect(cloudSessionSyncSettings(null)).toEqual({ claude_cloud_sync: true, cursor_cloud_sync: true, codex_cloud_sync: false });
    expect(cloudSessionSyncSettings({ codex_cloud_sync: true, cursor_cloud_sync: false })).toMatchObject({ codex_cloud_sync: true, cursor_cloud_sync: false });
    expect(cloudSessionSyncOn("codex_cloud_sync", undefined)).toBe(false);
    expect(cloudSessionSyncOn("cursor_cloud_sync", undefined)).toBe(true);
  });

  test("one sentence per setup problem, the same wherever it is said, naming the machine", () => {
    const { codex, cursor } = CLOUD_AGENT_PROVIDERS;
    const at = Date.UTC(2026, 8, 30, 12);
    expect(cloudAgentSetupSentence(codex, { kind: "key_missing" }, "Mac")).toBe("Codex Cloud needs a Codex sign-in on Mac.");
    expect(cloudAgentSetupSentence(codex, { kind: "key_invalid", reason: "token revoked" }, "Mac")).toBe("Codex refused the sign-in on Mac (token revoked).");
    expect(cloudAgentSetupSentence(codex, { kind: "key_invalid", expiredAt: at }, "Mac")).toBe(`The Codex sign-in on Mac expired ${cloudAgentExpiryDate(at)}.`);
    // A provider without an expiry card says it as a refusal.
    expect(cloudAgentSetupSentence(cursor, { kind: "key_invalid", expiredAt: at }, "Mac")).toBe(`Cursor rejected the API key on Mac (it expired ${cloudAgentExpiryDate(at)}).`);
    // A repository or an account refused: the reason is already the vendor's sentence.
    expect(cloudAgentSetupSentence(codex, { kind: "access", reason: "Codex Cloud is not enabled for this workspace" }, "Mac")).toBe("Codex Cloud is not enabled for this workspace.");
    expect(cloudAgentSetupSentence(codex, { kind: "repo", reason: "Codex Cloud can't reach a/b (no environment)" }, "Mac")).toBe("Codex Cloud can't reach a/b (no environment).");
  });
});

import { describe, expect, test } from "bun:test";
import { AGENT_MODEL_CONFIG, findModelOption, listedModels, modelOptionKey } from "./agentClients";
import { CLOUD_AGENT_PROVIDERS, cloudAgentCardText, cloudAgentLaunch, cloudAgentLaunchKey, cloudAgentModel, isCloudAgentActionName, signInExpired, cloudAgentProviderForKey, cloudAgentProviderForLaunch, cloudAgentProviderOfSession, cloudAgentProvidersFor, cloudAgentSetupSentence, cloudAgentExpiryDate, isCloudAgentId, cloudAgentCardKey, cloudAgentCardOf, CLOUD_AGENT_RETRIED_SUFFIX, cloudAgentChangedProblem, cloudAgentLimitProblem, cloudAgentProblemInfo, cloudAgentSetupRules, cloudAgentUnsentProblem, cloudAgentPageUrl, isCloudAgentCredentialKind, CLOUD_AGENT_SETUP_KINDS } from "./cloudAgents";
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

  test("a launch key carries a provider's launch options; a provider without them reads them as off", () => {
    const codex = CLOUD_AGENT_PROVIDERS.codex;
    expect(cloudAgentLaunch("codex", "cloud")).toEqual({ model: "", ask: false, attempts: 1 });
    expect(cloudAgentLaunch("codex", "cloud:ask+x2")).toEqual({ model: "", ask: true, attempts: 2 });
    expect(cloudAgentLaunchKey(codex, { ask: true, attempts: 2 })).toBe("cloud:ask+x2");
    expect(cloudAgentLaunchKey(codex, { ask: false, attempts: 9 })).toBe("cloud:x4");
    expect(cloudAgentLaunchKey(codex, { ask: false, attempts: 1 })).toBe("cloud");
    expect(cloudAgentModel("codex", "cloud:ask+x2")).toBe("");
    expect(cloudAgentLaunch("cursor", "cloud:composer-2.5")).toEqual({ model: "composer-2.5", ask: false, attempts: 1 });
    expect(cloudAgentLaunch("cursor", "cloud:ask+x3")).toEqual({ model: "", ask: false, attempts: 1 });
    expect(cloudAgentLaunch("codex", "gpt-5.5")).toBeNull();
    expect(isCloudAgentActionName("create_pr")).toBe(true);
    expect(isCloudAgentActionName("delete")).toBe(false);
  });

  test("every Codex Cloud launch key is in Codex's catalog and reads back from a stamp; pickers list the plain one", () => {
    for (const key of ["cloud", "cloud:ask", "cloud:x2", "cloud:ask+x4"]) {
      expect(findModelOption("codex", key)?.cliAlias).toBe(key);
      expect(modelOptionKey(key, "codex")).toBe(key);
    }
    expect(findModelOption("codex", "cloud:ask+x2")?.label).toBe("Codex Cloud · ask · 2 attempts");
    expect(listedModels(AGENT_MODEL_CONFIG.codex).filter((m) => m.key.startsWith("cloud")).map((m) => m.key)).toEqual(["cloud"]);
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
    // Codex starts in the cloud two ways: Codex Cloud on the ChatGPT plan, the Agents API on a key.
    expect(cloudAgentProvidersFor("codex").map((s) => s.id)).toEqual(["codex", "codex_api"]);
    expect(cloudAgentProviderOfSession("codex", "sess_0db7b5af8adc9da3006abdeb61add48193a15b37aff2d5b6e5")?.id).toBe("codex_api");
    expect(CLOUD_AGENT_PROVIDERS.codex_api.agentUrl).toBeUndefined();
    expect(cloudAgentProviderOfSession("codex", "task_e_1~assttrn_e_2")?.id).toBe("codex");
    expect(isCloudAgentId(CLOUD_AGENT_PROVIDERS.cursor, "bc-1")).toBe(true);
    expect(isCloudAgentId(CLOUD_AGENT_PROVIDERS.cursor, "state.json")).toBe(false);
  });

  test("a Provider Keys entry names the provider whose credential it is", () => {
    expect(cloudAgentProviderForKey("cursor")?.id).toBe("cursor");
    expect(cloudAgentProviderForKey("openai")?.id).toBe("codex_api");
    expect(cloudAgentProviderForKey("anthropic")).toBeNull();
  });

  test("the Agents API lane: its own launch keys and models beside Codex Cloud's, and its own cards", () => {
    const api = CLOUD_AGENT_PROVIDERS.codex_api;
    expect(cloudAgentProviderForLaunch("codex", "api")?.id).toBe("codex_api");
    expect(cloudAgentProviderForLaunch("codex", "cloud")?.id).toBe("codex");
    expect(cloudAgentLaunch("codex", "api:gpt-5.6-luna")).toEqual({ model: "gpt-5.6-luna", ask: false, attempts: 1 });
    // No launch options: ask and attempts read as off.
    expect(cloudAgentLaunch("codex", "api:ask+x3")).toEqual({ model: "", ask: false, attempts: 1 });
    expect(cloudAgentLaunchKey(api, { model: "gpt-6-astra", ask: true, attempts: 2 })).toBe("api:gpt-6-astra");
    // The picker lists the plain key and one per model the API serves; each reads back from a stamp.
    const listed = listedModels(AGENT_MODEL_CONFIG.codex).filter((m) => cloudAgentProviderForLaunch("codex", m.key)?.id === "codex_api").map((m) => m.key);
    expect(listed[0]).toBe("api");
    expect(listed).toContain(`api:${api.defaultModel}`);
    expect(listed).not.toContain("api:gpt-5.3-codex-spark");
    for (const key of listed) expect(modelOptionKey(key, "codex")).toBe(key);
    expect(findModelOption("codex", "api:gpt-5.6-luna")?.label).toBe("GPT-5.6 Luna");
    // Both Codex lanes say what they cost.
    for (const spec of cloudAgentProvidersFor("codex")) expect(spec.lane?.cost).toBeTruthy();
    const missing = cloudAgentCardText(api.credentialCards.missing, "Mac");
    expect(cloudAgentCardOf(api, undefined, missing)?.kind).toBe("credential");
    expect(cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.codex, undefined, missing)).toBeNull();
    expect(classifyApiErrorBanner(`${CLIENT_ERROR_BANNER_PREFIX} ${cloudAgentCardText(api.credentialCards.rejected, "Mac")} (Incorrect API key provided).`)).toBe("auth");
  });

  test("the daemon's credential cards are recognized by their copy, and are auth banners", () => {
    const cards = CLOUD_AGENT_PROVIDERS.cursor.credentialCards;
    for (const message of [cards.missing, `${cards.rejected} (Invalid User API Key).`]) {
      expect(cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.cursor, undefined, message)?.kind).toBe("credential");
      expect(classifyApiErrorBanner(`${CLIENT_ERROR_BANNER_PREFIX} ${message}`)).toBe("auth");
    }
    // Cards posted before the copy moved into the spec read the same.
    expect(cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.cursor, undefined, "Cursor Cloud needs a Cursor API key on this machine.")?.kind).toBe("credential");
    expect(cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.cursor, undefined, "Not logged in: run cursor-agent login")).toBeNull();
    expect(cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.codex, undefined, cards.missing)).toBeNull();
  });

  test("a card names the machine the daemon runs on, and is recognized whatever machine it names", () => {
    const codex = CLOUD_AGENT_PROVIDERS.codex.credentialCards;
    const expired = `${cloudAgentCardText(codex.expired!, "Ashot's MacBook (2)")} Oct 5.`;
    expect(expired).toBe("The Codex sign-in on Ashot's MacBook (2) expired Oct 5.");
    expect(cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.codex, undefined, expired)?.kind).toBe("credential");
    expect(cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.codex, undefined, cloudAgentCardText(codex.missing, "linux-host"))?.kind).toBe("credential");
    // Cards written before the machine was named.
    expect(cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.codex, undefined, "Codex refused the sign-in on this machine (the sign-in expired 2026-10-05).")?.kind).toBe("credential");
    expect(cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.codex, undefined, "The Codex sign-in on is fine")).toBeNull();
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
    expect(cloudSessionSyncSettings(null)).toEqual({ claude_cloud_sync: true, cursor_cloud_sync: true, codex_cloud_sync: false, codex_api_sync: false });
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

  test("a card's kind comes from its id, never its words; its provider is the session's", () => {
    const suffix = CLOUD_AGENT_RETRIED_SUFFIX;
    const { codex, codex_api } = CLOUD_AGENT_PROVIDERS;
    const repo = `Codex Cloud can't reach ashot/private (no environment)${suffix}`;
    expect(cloudAgentCardKey(codex, "conv1", "repo")).toBe("codex-cloud-setup:conv1:repo");
    expect(cloudAgentCardOf(codex, cloudAgentCardKey(codex, "conv1", "repo"), repo)).toEqual({ kind: "setup", problem: "repo" });
    // An access card is its own kind, whatever its sentence opens with.
    expect(cloudAgentCardOf(codex, cloudAgentCardKey(codex, "conv1", "access"), "Codex Cloud is not enabled for you (x)")).toEqual({ kind: "setup", problem: "access" });
    expect(cloudAgentCardOf(codex, cloudAgentCardKey(codex, "conv1", "key_invalid"), "anything")).toEqual({ kind: "credential", problem: "key_invalid" });
    expect(cloudAgentCardOf(codex, cloudAgentCardKey(codex, "conv1", "unsent", 5), "anything")).toEqual({ kind: "unsent" });
    // Words alone never make a setup card, and another provider's id is not this one's.
    expect(cloudAgentCardOf(codex, "msg-1", repo)).toBeNull();
    expect(cloudAgentCardOf(codex_api, cloudAgentCardKey(codex, "conv1", "repo"), repo)).toBeNull();
    expect(cloudAgentCardOf(codex, "codex-cloud-setup:conv1:bogus", repo)).toBeNull();
    // A credential card is known by its words too (every auth banner is), but only its own provider's.
    expect(cloudAgentCardOf(codex_api, undefined, cloudAgentCardText(codex_api.credentialCards.missing, "Mac"))).toEqual({ kind: "credential" });
    expect(cloudAgentCardOf(codex_api, undefined, cloudAgentCardText(codex.credentialCards.missing, "Mac"))).toBeNull();
  });
});

describe("cloud agent lane problems: a provider that changed, a limit", () => {
  const codex = CLOUD_AGENT_PROVIDERS.codex;
  test("each opens with the provider; on a card neither is a sign-in card or a usage park", () => {
    const changed = cloudAgentChangedProblem(codex, "Ashot's MacBook");
    expect(changed).toBe("Codex Cloud changed in a way codecast can't read yet. Syncing on Ashot's MacBook is paused and checks again every 5 minutes");
    const limit = cloudAgentLimitProblem(codex, "the Week (7d) window of your ChatGPT Pro plan is used up");
    expect(limit).toBe("Codex Cloud limit reached: the Week (7d) window of your ChatGPT Pro plan is used up");
    // The card's heading says something its sentence does not open with.
    expect(`${codex.label} ${cloudAgentProblemInfo("limit")!.heading}`).not.toBe(limit.split(":")[0]);
    expect(classifyApiErrorBanner(`${CLIENT_ERROR_BANNER_PREFIX} ${changed}${CLOUD_AGENT_RETRIED_SUFFIX}`)).toBe("error");
    expect(classifyApiErrorBanner(`${CLIENT_ERROR_BANNER_PREFIX} ${limit}${CLOUD_AGENT_RETRIED_SUFFIX}`)).toBe("error");
    // A machine's block says the sentence as it is.
    expect(cloudAgentSetupSentence(codex, { kind: "changed", reason: changed }, "Mac")).toBe(`${changed}.`);
  });

  test("one table holds every kind's rules and copy: credentials, setup someone fixes on the provider's side, and holds that lift on their own", () => {
    expect(CLOUD_AGENT_SETUP_KINDS.filter(isCloudAgentCredentialKind)).toEqual(["key_missing", "key_invalid"]);
    // What pauses the mirror: a change any call meets, a limit only a read's own, a refusal only the list's.
    expect(Object.fromEntries(CLOUD_AGENT_SETUP_KINDS.map((k) => [k, cloudAgentSetupRules(k).pauses]))).toEqual({ key_missing: "any", key_invalid: "any", repo: "list", access: "list", changed: "any", limit: "read" });
    expect(CLOUD_AGENT_SETUP_KINDS.filter((k) => cloudAgentSetupRules(k).blocksSend)).toEqual(["changed"]);
    // A sign-in check proves the credentials and the account, never a changed answer or a limit.
    expect(CLOUD_AGENT_SETUP_KINDS.filter((k) => cloudAgentSetupRules(k).liftedBySignIn)).toEqual(["key_missing", "key_invalid", "access"]);
    // Every other kind has its card heading, the composer's word and what a held message waits for.
    for (const kind of CLOUD_AGENT_SETUP_KINDS.filter((k) => !isCloudAgentCredentialKind(k))) {
      const info = cloudAgentProblemInfo(kind)!;
      expect(info.heading && info.held && info.until(codex)).toBeTruthy();
    }
    expect(cloudAgentProblemInfo("access")).toMatchObject({ heading: "access needed", held: "no access" });
    expect(cloudAgentProblemInfo("access")!.until(codex)).toBe("Codex Cloud lets this account in");
    expect(cloudAgentProblemInfo("changed")!.until(codex)).toBe("codecast can read Codex Cloud again");
    expect(cloudAgentProblemInfo("changed")!.saysPaused).toBe(true);
    expect(cloudAgentProblemInfo("repo")!.heading).toBe("setup needed");
    expect(cloudAgentProblemInfo("key_invalid")).toBeNull();
  });

  test("a message that may have started the agent is its own card, pointing at the provider's task list", () => {
    const unsent = cloudAgentUnsentProblem(codex);
    expect(unsent).toContain("look for it at https://chatgpt.com/codex, and send it again if it is not there.");
    // Where the answer broke is the daemon's log's, never the card's.
    expect(unsent).not.toContain("POST");
    // Known by its id alone: its words are not a card.
    expect(cloudAgentCardOf(codex, undefined, unsent)).toBeNull();
    // A vendor with no task list: its site.
    expect(cloudAgentUnsentProblem(CLOUD_AGENT_PROVIDERS.codex_api)).toContain("look for it on OpenAI's site");
  });
});

describe("cloudAgentPageUrl", () => {
  test("only an https link a provider names is opened or shown", () => {
    expect(cloudAgentPageUrl("https://github.com/ashot/chatdoc/pull/25")).toBe("https://github.com/ashot/chatdoc/pull/25");
    expect(cloudAgentPageUrl("javascript:alert(1)")).toBeUndefined();
    expect(cloudAgentPageUrl("http://github.com/x")).toBeUndefined();
    expect(cloudAgentPageUrl("not a url")).toBeUndefined();
    expect(cloudAgentPageUrl(undefined)).toBeUndefined();
  });
});

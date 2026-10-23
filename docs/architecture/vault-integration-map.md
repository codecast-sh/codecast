# Vault: integration map (where each piece of the build plugs in)

Paths relative to packages/. Captured 2026-10-22 for the Vault build; line numbers drift.


A few findings affect the design directly:
- **Two web sealing transports.** Web secrets reach a device by being sealed to its key in the browser (the provider-key and template-hire flows). Separately, the server encrypts mod and connector secrets itself under `CONNECTION_SECRETS_KEY`.
- **Template secret inputs already exist.** Org templates have a `"secret"` input kind and already show each one as bound or missing.
- **Redaction does not see bound template secrets.** The daemon writes them to 0600 files, but the redaction collectors read only `provider-keys.json`.
- **localStorage is never carried.** Only cookies are copied into the agent browser.

---

## 1. Web: settings, integrations and page registration

**Where things live**
- Each settings section is a page module at `web/app/settings/<section>/page.tsx` (accounts, agents, agent-library, apps, calls, claude-accounts, cli, daemon, desktop, devices, harness, integrations, keyboard, migrate, notifications, plan, privacy, profile, provider-keys, sounds, sync, team).
- Settings render in a modal, not as pages: `web/components/settings/SettingsModal.tsx`. Shared building blocks (`SettingsPanel`, `SettingsSection`) are in `web/components/settings/ui.tsx`.
- Integration parts are in `web/components/integrations/` (`IntegrationCard.tsx`, `TokenConnectForm.tsx`, `parts.tsx`, `IssueSyncSources.tsx`).

**Adding a settings section touches five places**
1. `web/lib/settingsSections.ts:13-35`: add the id to the `SettingsSectionId` union.
2. `web/lib/settingsSections.ts:39-64`: add the URL to `PATH_TO_SECTION`. Old `/settings/*` URLs bounce into the modal through SettingsLayout and the router compat shim.
3. `web/components/settings/SettingsModal.tsx:41-64`: add it to the `PANELS` map (imports at :25-39).
4. `SettingsModal.tsx:92-131`: add it to the `GROUPS` nav. Groups are Account, Workspace and Machines. Each entry is `{ id, label, icon, desc, keywords, surface?, hostedNeedsTeam? }`.
5. Optional: a command palette row in `web/lib/navPages.ts:11-84` (`NAV_PAGES`), e.g. `{ label: "Provider Keys", path: "/settings/provider-keys", icon, keywords, secondary: true }` at :80. Also a route in `web/src/App.tsx:177-194` and `web/src/routes.manifest.ts:557-571` if the section needs a hard-loadable URL.

**Adding a top-level page** (using `/mods` as the example)
- `web/src/App.tsx:61` and `:271`: the `<Route path="mods">`.
- `web/src/routes.manifest.ts:142` and `:343`: `{ path, component, layout: "dashboardShell", tab }`. The header at :1-24 lists four sources that must agree (App.tsx, `TabContent.tsx`, `lib/tabRoutes.ts`, `DashboardLayout`), enforced by `routes.manifest.test.ts`.
- `web/lib/navPages.ts:52`: palette row.
- `web/lib/pathLabel.ts:98`: tab label.
- Feature or surface gating: `web/lib/surfaceRules.ts`.

**Best models for a "team secrets" list**
- **Mod secrets UI, `web/components/mods/ModsPage.tsx:97-160`.** `Secrets` and `SecretRow` show a status dot ("set {relative}" or "not set"), Replace and Clear buttons, and a `type=password` form. It calls `useAction(api.modSecrets.webSet)` directly and skips the store on purpose, so no outbox or cache ever holds the value (the comment at :97-102 says why).
- **`web/app/settings/provider-keys/page.tsx:59-240`.** Rows inside a `SettingsSection`, each with a "Managed" badge, Set/Replace, Remove and an inline password `Input`. This is the per-device sealed variant.
- **`web/components/integrations/TokenConnectForm.tsx:17-97`.** A token-paste form driven by a descriptor's `tokenConfig` fields. Its copy reads "stored encrypted. Agents act through the backend and never see it."
- **`web/components/org/TemplateSections.tsx:164-170`.** Each template secret is listed as set or missing, with a `HostStep` (purpose `"secrets"`) to bind the missing ones.

## 2. Store: registry, sync hooks, actions and dispatch

**Registry entry shape** is typed at `web/store/clientSyncRegistry.ts:35-112`. A small workspace-scoped entry, verbatim from `clientSyncRegistry.ts:744-752`:
```ts
  agentDefinitions: {
    persistence: { kind: "collection", key: "agentDefinitions" },
    hydration: { phase: "deferred" },
    localFirst: true,
    workspaceScoped: true,
    indexes: "_id, name",
    sync: { altKey: "client_key" },
    feeds: ["agentDefinitions.list"],
  },
```
Things that come with it:
- `feeds` is a promise that components read from the store, never from the query directly; a guard test enforces it.
- `workspaceScoped` means rows are read only through `useWorkspaceCollection`.
- Adding a persisted collection requires bumping `CACHE_SCHEMA_VERSION`.

**Sync and read hooks**
- `web/hooks/useSyncCollection.ts:126-148`: `useSyncCollection(key, query, args|"skip", opts?)`. It waits for auth to settle, then pushes rows through `applyCollectionFeed` into `store.syncTable(key, rows, syncOpts)`. Example feeder: `web/hooks/useSyncAgentDefinitions.ts:35-38`, mounted globally at `web/components/DashboardLayout.tsx:347`.
- `web/hooks/useCollectionRows.ts:45-60`: the generic reader for collections that are not workspace-scoped. It subscribes by a `where`/`sig` signature, not to the whole collection.
- `web/hooks/useWorkspaceCollection.ts:125-148`: `useWorkspaceCollection(table, sig?, workspace?)`, the reader for workspace-scoped tables. It filters rows with `inWorkspace(row, activeKey)`. Example: `useAgentDefinitions()` at `useSyncAgentDefinitions.ts:47-50`.

**Action to mutation, end to end (agent definitions)**
1. Page: `web/app/settings/agent-library/page.tsx:375` calls `useInboxStore((s) => s.upsertAgentDefinition)`.
2. Store action: `web/store/inboxStore.ts:13116-13124` defines `upsertAgentDefinition: asyncAction(function (this: Draft, fields) { return upsertAgentLibraryRow(this, "agentDefinitions", "ad", fields); })`. It writes an optimistic stub keyed by `client_key`. `removeAgentDefinition` is a plain `action()` that deletes the draft row. Undo policy: `web/store/undo/policies/never.ts:153`.
3. Transport: the middleware sends `{action, args, patches, result}` to `api.dispatch.dispatch` (`web/hooks/useEnsureDispatch.ts:41`, `web/lib/dispatchBinding.ts`).
4. Dispatch mutation: `convex/convex/dispatch.ts:166-210`. It authenticates with `getAuthUserId`, applies patches, then runs `SIDE_EFFECTS[action](ctx, userId, args, result)`. `isDispatchAction` is at :162-164 and the `SIDE_EFFECTS` table starts at :701.
5. Side effect: `dispatch.ts:1905-1917`. `upsertAgentDefinition` calls `runMutation(api.agentDefinitions.upsert, {...rest, id?, client_key: r.client_key})`. `removeAgentDefinition` uses `isServerId()` to skip unsaved stubs.

A smaller example with no new rows: `setProviderKey` (store at `inboxStore.ts:9434`, dispatch at `dispatch.ts:1453`, which calls `performSetProviderKey`).

## 3. Convex: access, auth, roles, audit and short ids

**Workspace keys** (`convex/convex/lib/accessKeys.ts`, re-exported by `lib/access.ts:36`)
- `workspaceKey()` at :151 returns `team:<id>` or `user:<id>`. `parseWorkspaceKey()` at :156 fails closed on unknown variants.
- `computeWorkspaceKey(record, linkedConv)` at :171-184 is the only reader of `team_id` for access purposes, used at write time. `computeWorkspaceKeyDb` is at :186 and `resolveWorkspaceKey` at :197.
- `workspaceGrantsAccess()` at :208 is the one predicate. `heldKeysFor(ctx, userId)` at :89 returns every key the user holds.

**Data context** (`convex/convex/data.ts`)
- `SCOPED_TABLES` at :28-31 (tasks, plans, docs, projects, initiatives, decisions, patterns, workflows).
- `scopedFetch` at :87 checks team membership whenever a `teamId` is passed.
- `createDataContext` at :281: `insert` stamps both `team_id` (routing) and `workspace` (access); `query` goes through the `by_workspace` index. `createWorkContext` is at :265 and `explicitWorkspace` (the CLI `--team`/personal choice) at :39.

**Simplest standalone pattern to copy:** `convex/convex/agentDefinitions.ts:27-60`.
- `requireCaller` uses `getAuthenticatedUserId(ctx, apiToken)`, so one function serves both web and CLI.
- `listFor` loops over `heldKeysFor` and queries `by_workspace`.
- `requireRow` allows the owner or a held key.
- `writeKey` calls `requireTeamMembership` and returns `workspaceKey(...)`.

**Token to user**
- `convex/convex/pendingMessages.ts:91-108`: `getAuthenticatedUserId(ctx, apiToken?)` tries the web session (`getAuthUserId`) first, then `verifyApiToken(ctx, apiToken)`.
- `convex/convex/modLocal.ts:23-26`: `tokenUser(ctx, api_token)` is token only.
- `verifyApiToken` is re-exported from `@platform/auth/convex` at `convex/convex/apiTokens.ts:19`.
- Actions cannot read the db, so they wrap the lookup in an internalQuery: `modSecrets.tokenUserOf` at `modSecrets.ts:98-101`.

**HTTP routes the CLI calls:** `cliRoute(path, handler)` at `convex/convex/http.ts:3828` checks device binding before the handler runs. Example routes are at :4869-4870 (`/cli/mods/secret-set`, `/cli/mods/secrets`) and :5242-5246 (connector).

**Membership and admin checks**
- `privacy.ts:24` `isTeamMember` and `:42` `isTeamAdmin` (`membership.role === "admin"`).
- `lib/access.ts:142` `requireTeamMembership`, `:162` `activeTeamMembershipFor` and `:176` `requireTeamAdmin`, which throw `forbidden`.
- Membership lives in the `team_memberships` table with the `by_user_team` index.

**Audit log:** `convex/convex/lib/authorityEvents.ts`.
- `recordAuthorityEvent(ctx, ev)` at :57 is the only writer of `authority_events` and must be called in the same transaction as the change ("audit or deny").
- Allowed kinds are the closed list `AUTHORITY_EVENT_KINDS` at :15-29. A new kind such as a secret grant or reveal would be added there.
- `authorityEvents.guard.test.ts` fails any other file that writes the table. Rows get a `workspace` key from `computeWorkspaceKey`, and share tokens are stored only as sha256.

**Short ids**
- Counter-based: `convex/convex/counters.ts:18-32`. `nextShortId(db, prefix)` reads and increments the `counters` row named by the prefix and returns `${prefix}-${n}`; it is intentionally unsharded. Examples: `plans.ts:177` `nextShortId(ctx.db, "pl")`, `sessionDecisions.ts:1210` `"sd"`.
- The id must also be registered in `shared/entities/index.ts:93-107` (`SHORT_ID_PREFIX`). Add the prefix to `DIGITS_ONLY_PREFIX` at :116 if it is an English word. The header at :8-13 lists everything a new type needs: `EntityType`, `ENTITY_ROUTE` and `SEGMENT_TYPE`.
- A different style exists: `agentDefinitions.ts:153` uses `${prefix}-${now.toString(36)}`, like the base-36 `pj-` ids.

## 4. Encryption

**Server-side encryption** (`convex/convex/googleOAuth.ts`)
```ts
encryptRefreshToken(plaintext: string, secret: string, info: string = REFRESH_TOKEN_HKDF_INFO): Promise<string>   // :291
decryptRefreshToken(enc: string, secret: string, info: string = REFRESH_TOKEN_HKDF_INFO): Promise<string | null> // :304
```
- HKDF-SHA256 derives an AES-GCM key; the output format is `${version}.${iv}.${ct}` and decrypt returns null on a wrong key.
- `info` separates key domains, so each family uses its own string:
  - token connectors: `"codecast-token-connection-v1"` (`tokenConnectors.ts:46`)
  - mod secrets: `"codecast-mod-secret-v1"` (`modSecrets.ts:20`)
  - whisk: `whisk.ts:123`

**The `CONNECTION_SECRETS_KEY` env var**
- Defined in `convex/convex/tokenConnectors.ts:49` as `CONNECTION_SECRETS_KEY_ENV`.
- Helpers: `connectionSecretsKey()`, `encryptConnectionSecret` and `decryptConnectionSecret` at :53-63.
- Rotating it orphans every stored connection.

**Full server-side reference: `convex/convex/modSecrets.ts`**
- `webSet` action at :80, `cliSet` action at :89, `cliList` query at :104 (returns names and set times, never values).
- `storeSecret` internalMutation at :47, writing the `mod_secrets` table plus a `secrets_set` summary on the mod row.
- `decryptModSecret` at :29 is used server-side only, by `modServer.ts`.

**Device sealing (ECDH), web side**
- `web/lib/providerKeyCrypto.ts:36-63`: `encryptProviderKey(devicePublicKeyB64, provider, apiKey)` makes an ephemeral P-256 key, derives an AES-256-GCM key with HKDF, and returns `{provider, epk, iv, ct}`. Parameters are shared via `@codecast/shared/contracts` (`PROVIDER_KEY_HKDF_INFO`).
- Callers:
  - `web/lib/useProviderKeyCommand.ts:46-59`: `setKey` seals, then calls store `setProviderKey`.
  - `web/hooks/useTemplateHire.ts:75-78`: `sealSecret` for template secret inputs.
  - `web/components/MintTokenDialog.tsx:235`.
- The pubkey comes from the device row: `deviceManagedKeys()` at `useProviderKeyCommand.ts:35`. It reaches the web via `devices.ts:1218` (listDevices) and `schema.ts:3025`.

**Device sealing, daemon side**
- `cli/src/providerKeyCrypto.ts`:
  - `loadOrCreateEcdh` at :24 keeps the private key in `~/.codecast/.provider-key-ecdh` (0600).
  - `getProviderKeyPublicKey` at :48 is published in the heartbeat (`cli/src/daemon.ts:5365`).
  - `decryptProviderKeyPayload` at :61.
  - `applyProviderKeyCommand(configDir, argsJson, verify?)` at :111-146 decrypts, verifies, then stores.
- The `set_provider_key` command case is at `cli/src/daemon.ts:8893-8906`. It applies the key, pushes it to remote hosts and sends a heartbeat. The neighbouring `org_template_bind` case is at :8907-8920.
- Disk storage: `cli/src/providerKeyStore.ts`. The file is `~/.codecast/provider-keys.json` (`PROVIDER_KEY_STORE_FILE` at :17), written 0600 by `writeProviderKeyStore` at :78-89. Use `managedProviderKey(id, configDir)` at :29 to read a key.

## 5. CLI

**Registering a `cast <noun>` command**
- Commands are lazy groups in `cli/src/commandGroups.ts`. The header at :1-37 explains why (keep `cast --help` fast); the type is `CommandGroup` at :51-65.
- One entry per group in `COMMAND_GROUPS`, e.g. `connector` at :463-471:
  ```ts
  { token: "connector", description: `App connector: ...\n\n  cast connector ls | ...`,
    load: () => import("./connectorCommand.js").then((m) => m.registerConnectorCommand) },
  ```
- `mod` is at :227-244.
- The module exports `registerXCommand(program, deps: PublishDeps)`, which starts with `program.command("<noun>").description(commandGroup("<noun>").description)` (`connectorCommand.ts:140`, `modCommand.ts:126-127`).
- `index.ts` never imports a group directly: stubs are registered at `index.ts:2902` and deps built by `groupDeps()` at :2907-2909. `commandGroups.guard.test.ts` and `bench/bootGraph.guard.test.ts` enforce this.

**`cast mod secret`:** `cli/src/modCommand.ts:435-460`. It has `set <name> <secret>` (value from stdin or a hidden prompt), `rm` and `ls`, and all of them call `apiPost(deps, "/cli/mods/secret-set" | "/cli/mods/secrets", ...)`. Note that it has its own `readSecretValue` (:56-74) rather than using `hiddenSecret.ts`.

**How the CLI reaches Convex** (two paths)
- **HTTP, the usual path for commands:** `cli/src/castApi.ts:32-73`. `apiPost(deps, urlPath, body, {read?, exitOnError?, describeError?})` POSTs `{api_token, ...body}` to `siteUrl + urlPath`. A `result.error` prints and exits 1. On the server the matching `cliRoute` is in `http.ts`.
- **Direct client:** `cli/src/remote/convexClient.ts:16-27`. `convexClient()` returns `{client: ConvexHttpClient, token, api}` built from `config.json`; `remote/cli.ts:69-70` re-exports it. Usage: `client.query(api.x.y, { api_token: token, ... })`.
- Workspace-scoped helpers: `cli/src/externalDataCli.ts:24-31`. `scopedRead` and `scopedWrite` fold in `--team` or the repo's or session's team.

**Hidden prompt:** `cli/src/hiddenSecret.ts:9-46`. `promptHiddenSecret(promptText, readStdin?)` reads the tty in raw mode, or the first stdin line when piped. Callers: `index.ts:3140` (provider key), `index.ts:4341`, `integrations.ts:214`.

**Formatting**
- `cli/src/colors.ts`: `c` (raw codes, off unless stdout is a TTY), `fmt` at :37-50 (label, success, warning, error, muted, accent, highlight, cmd, path, number, id) and `icons` at :52-58 (check, cross, dot, arrow, bullet).
- `UNVERIFIABLE_MARK` at :64.

**JSON output**
- `cli/src/externalDataCli.ts:18-21`: `emit(json, data, textFn)` prints either `JSON.stringify(data, null, 2)` (the server's answer, whole) or the human text.
- Flag constants at :47-48: `JSON_OPTION = ["--json", "Machine-readable output"]` and `TEAM_OPTION`.
- Errors go through `fail()` at :13, which prints `fmt.error` to stderr and exits 1.

## 6. Daemon known-value redaction

File: `cli/src/knownValueRedaction.ts`.

**Collectors (:75-205)** are pure functions of type `(text) => KnownValue[]` (`{value, name?}`):
- `collectFromEnv`
- `collectFromDotenv`
- `collectFromNetrc`
- `collectFromKeyValueLines`
- `collectFromProviderKeys` (:161; each value is named `${id}-key`)
- `collectFromDockerConfig`
- `collectFromJson`

`add()` at :66 applies length floors (8, 12 if all digits, 16 if all letters).

**Sources**
- `CREDENTIAL_FILES` at :208-216 holds paths relative to HOME.
- `KnownValueStore.files()` at :346-360 adds `configDir/config.json`, `configDir/provider-keys.json` and the `.env*` files of tracked session directories and their git roots.
- `collect()` at :362-382 merges env, `src.codecastSecrets()` and the per-file results, caching parsed values by mtime and size.

**Lifecycle**
- `start()` rebuilds every 60s and `fs.watchFile`s each file (rebuilding 250ms after a change).
- `startKnownValueRedaction(src: KnownValueSources)` at :440-446 is idempotent. The `KnownValueSources` type at :290-299 has `home`, `configDir`, `env`, `cwds`, `codecastSecrets` and `log`.
- `trackKnownValueCwd` is at :449.

**Daemon call:** `cli/src/daemon.ts:29539-29550`. It passes `{home, configDir: CONFIG_DIR, env: () => process.env, cwds: () => [...transcriptProjectPathCache, ...sessionCwdCache], codecastSecrets: () => [token, secretFromStored(token)], log}`. Applied via `redactKnownValues()` from `secretRedaction.ts:156`.

**Adding a source of values** (no new mechanism needed):
- **File on disk:** add a `{file, collect}` entry in `files()` next to `provider-keys.json` (:350), or a HOME-relative entry in `CREDENTIAL_FILES`. Watching and refresh come for free.
- **In-memory values:** add a callback to `KnownValueSources` like `codecastSecrets` (:296) and consume it in `collect()`.

## 7. Browser login carrying

File: `cli/src/browser/credentials.ts` (rationale in the header at :1-39).

**Reading Chrome's cookies (macOS)**
- `chromeEncryptionKey()` at :80-102 runs `security find-generic-password -s "Chrome Safe Storage"` and derives the key with pbkdf2 (cached, 45s timeout).
- `decryptCookieValue()` at :109 handles v10 blobs.
- `localCookiesForHost(userDataDir, host|null, profileDir)` at :165 copies the Cookies SQLite file to scratch and returns `Cookie[]` in the shape CDP setCookies expects (:53).

**Injecting**
- `provisionCredentials(page, url, userDataDir)` at :284-317 is the per-page path for a remote browser. It diffs against `Network.getCookies` and only sends what is missing via **`Network.setCookies`** on the page session. Called from legacy `browser/cli.ts:599` when `s.remote`.
- `provisionLocalLogins(port, url|null, {profileDir, channel})` at :331-388 is the browser-wide path for the local managed browser: **`Storage.getCookies`** then **`Storage.setCookies`**, then a recount of what Chrome actually kept. `url=null` carries the whole jar. Called from `browser/cliEngine.ts:718-733` (`carryLogins`) and `browser/sync.ts:105`.
- Google and YouTube are never carried: `OWN_LOGIN_HOSTS` and `keepsOwnLogin()` at `browser/profile.ts:72-78`, with `OWN_LOGIN_REASON` at `credentials.ts:264`.

**localStorage is not carried.** The docstring at `credentials.ts:327-329` says: "Local-storage tokens are not carried; sites that keep their session only there still need a sign-in in the agent's tab."

**Cloud host path:** `cli/src/cloud/browserSync.ts` (header at :1-23).
- On the host, `cast browser sync <site>` only sends a request (a `cloud_browser_sync` daemon command via `cloud.requestBrowserSync`).
- The laptop daemon runs `handleBrowserSyncCommand` at :300, then `carryLoginsToHost` at :208. That opens an SSH forward to the host's CDP port (`withCdpTunnel`) and calls the same `provisionLocalLogins`.
- Only ids, a port and an origin go through Convex; only counts come back. `--all` is refused while a site policy is active (`checkUrl` and `loadMachinePolicy` imports at :28).

**Site policy:** `cli/src/browser/policy.ts` (rules in the header at :1-40). It is an opt-in allowlist built from the union of `[browser] allow` in `.codecast/workspace.toml` and `browser_allow` in `~/.codecast/config.json`. A broken source fails closed. Functions: `loadSitePolicy` at :180, `loadMachinePolicy` at :213, `checkUrl` at :243, `denyNavigation` at :276.

**`cast browser` verbs**
- Entry point: `cli/src/browser/cli.ts:252` `registerBrowserCommand`, with `br = program.command("browser").alias("br")` at :286-289.
- When the agent-browser engine is available (`useEngine()` at :222) it hands off to `registerEngineCommands` (`browser/cliEngine.ts:1228`):
  - Pass-through verbs come from the `PASSTHROUGH` table at :228 (open, snapshot, read, click, type, fill, ...), looped at about :1255.
  - Codecast's own verbs are `targetFlags(br.command("..."))` calls, e.g. `login [url]` at :1401 and `sync [url]` at :1408.
- The legacy driver's verbs follow at `cli.ts:317-1393`, e.g. `sync` at :383.

## 8. Snippets (agent guidance sections)

**Bodies and catalog** live in `shared/contracts/snippets.ts`:
- Each section has a body constant (`BROWSER_SNIPPET` at :651, `CHAT_SNIPPET` at :947), an end marker, and a `SectionSpec` with `{ headings: ["## Browser"], endMarker }` (`BROWSER_SECTION` at :697, `CHAT_SECTION` at :977).
- Each is registered in `SNIPPET_CATALOG` (:1110) with `{ slug, aliases, name, category, desc, detail, writesTo, shipped, enabledKey, versionKey, section: { spec, body, reference } }`. See `chat` at :1349 and `browser` at :1384. `snippetBySlug` is at :1555.

**Installer:** `cli/src/snippets.ts` wraps the `@platform/snippets` engine. The header at :1-19 notes that the daemon can import it. Per-section installers such as `installBrowserSnippet` and `installChatSnippet` are at :280-298. Reinstall is decided by a content hash (`snippetStale`/`stampSnippet` at :336 and :353).

**Team gating**
- `shared/contracts/teamFeatures.ts:36-50`: `TEAM_FEATURES[].snippets`, e.g. chat gates `["chat"]`.
- Server: `convex/convex/lib/teamFeatureGuard.ts:109` `gatedSnippetAvailability()`, sent in the heartbeat response (`users.ts:812`).
- Daemon: `cli/src/gatedSnippets.ts` `planGatedSnippets(prev, avail, config)` is pure. `daemon.ts:5561-5575` `reconcileGatedSnippets` runs `cast install` or `--disable` only when availability changes.

**Versions:** `cli/src/snippetVersions.ts`. They are display labels and compatibility shadows, not the rewrite key (header at :1-11). Pattern: `const BROWSER_VERSION = "17"; // why`, plus `getBrowserVersion()`.

**Golden fixtures**
- `cli/src/__fixtures__/install-golden/{fresh,existing}/<slug>.md`, `manifest.json` and `help.txt`.
- Test: `cli/src/install.golden.test.ts`. Regenerate from `packages/cli` with `UPDATE_GOLDEN=1 bun test src/install.golden.test.ts` (:79, :103).
- `GOLDEN_SLUGS` and `GOLDEN_CLI_ROOT` narrow a run or point it at another tree; `__fixtures__/install-golden/BASELINE.md` documents them.

## 9. Org templates declaring required secrets

- **Schema:** `shared/contracts/orgTemplateManifest.ts:13-14`. `TemplateInputKind` includes `"secret"`; a `TemplateInput` is `{key, label, kind, required?, help?, unlocks?}`. Secrets cannot carry a default (:147).
- **Server:** `convex/convex/orgTemplates.ts`.
  - Secret answers are refused as plain config (:214-215).
  - Bound or missing state is computed from `row.bindings?.[key]` at :362 and :436, returned as `secrets: [{key, label, bound, unlocks}]`.
  - `bindNote()` at :305-315 produces the "Still missing: …" line.
  - Picking a bind host: `can_receive_secrets: !!device.provider_key_pubkey` at :467, :497 and :550.
  - `performRequestBind` and `enqueueBind` at :523-556 require every secret to arrive sealed. Validator `sealedSecret` at :713.
- **Web:** `web/components/org/TemplateSections.tsx:164` shows set or missing per secret; :170 shows the `HostStep`. Sealing: `web/hooks/useTemplateHire.ts:75` `sealSecret`.
- **Daemon:** `cli/src/orgTemplateBindCommand.ts`.
  - `parseBindArgs` at :22.
  - `runOrgTemplateBind` decrypts each secret with `decryptProviderKeyPayload` into 0600 files under `ORG_TEMPLATE_SECRETS_DIR/<instance>` (a 0700 directory), then runs `cast org template bind --secret key=path`.
- **CLI:** `cli/src/orgTemplate.ts:42` defines `--secret <key=path>`; the path is recorded by hash only. `cli/src/orgTemplateRun.ts:34` holds `bindings: Record<key, {host, path_hash, bound_at}>`, and :85 refuses a secret given as text.
- The task id `ct-52532` does not appear anywhere in the repo.

## 10. Mobile settings

One dynamic route, `mobile/app/settings/[section].tsx`, renders `SETTINGS_PAGES[section]`, a `Record<string, {title, Page}>` at `mobile/components/settings/SettingsPages.tsx:550`. The Settings tab is `mobile/app/(tabs)/settings.tsx`, and `SettingsGroup` and friends are in `mobile/components/settings/SettingsUI.tsx`.

## 11. Render gallery and `cast` command cards

- **Parsing:** `web/components/castCommand.ts:611` `parseCastCommandString` returns `{category, subcommand, args}`. Aliases are in `CAST_CATEGORY_ALIASES` at :338-344, read via `normalizeCastCategory`. Mutation prose comes from `extractCastBodyParts` (:399) using `CAST_BODY_SUBCOMMANDS` (:376) and `CAST_BODY_FLAGS` (:365).
- **Web card:** `web/components/conversation/blocks/castBlocks.tsx:592` `CastCommandBlock`. Its `getCategoryConfig()` switch at :659-707 gives `{color, accent, icon}` per category: task, plan, doc, search, feed, trigger, browser, and one shared case for diff/summary/handoff/context/ask. Anything else falls to `default`.
- **Mobile card:** `mobile/components/session/CastCommandBlock.tsx:33-40` has a parallel `CATEGORY: Record<string, {icon, tone}>` table.
- **Gallery:** `web/lib/renderGallery.ts`. The "cast commands" section at :352-376 adds rows with `sh('<cast cmd>', '<output>')`; the header (:1-11) says to add the row along with the renderer.
- **Test:** `web/lib/__tests__/renderGallery.test.ts:113-124` reads the `case "x":` labels from `getCategoryConfig` and fails if any category has no gallery row.
- **So a new card for a new `cast <noun>` needs:** a `case` in `castBlocks.tsx` `getCategoryConfig`, a matching entry in the mobile `CATEGORY` table, an `sh(...)` row in `renderGallery.ts`, and optionally a body-prose rule in `extractCastBodyParts`.
## Constraints added after the first waves (2026-10-22)

- Import Vault contracts from `@codecast/shared/contracts/secrets`, never the
  `@codecast/shared/contracts` barrel: the barrel no longer re-exports them,
  so secrets.ts stays off the CLI's and the daemon's boot graphs.
- `formatVaultReady` takes `vars: string[]` (the caller passes
  `envFor(row).map((b) => b.var)`); machineMessages imports no runtime code
  from secrets.
- origin/main carries `"vault.md": ["vault"]` in NOT_INSTRUCTIONS
  (packages/cli/src/docsCommands.guard.test.ts). Delete it in the commit that
  lands packages/cli/src/secrets/ and the `vault` command group.

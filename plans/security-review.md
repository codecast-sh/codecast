# Codecast adversarial security review

Reviewed 2026-09-21. Baseline commit `07a081b853ca9bad1a1872eb757eb69a5c1acd34`, plus the existing uncommitted shared working tree. Plan: **pl-734**. Review task: **ct-53045**. Status: review complete; remediation proposed, not implemented or deployed.

## Judgment

**Prioritize containment and repair of identity and authorization defects immediately.** This pass found credible account-takeover paths, a generic write path that permits membership escalation, cross-account session attachment, private workspace leakage, and click-triggered script execution in the authenticated client. These are application defects, not merely dependency warnings.

The most concerning chain is a weak identity or content boundary granting the victim's full account authority, which includes agent and machine operations. Existing authentication checks are widespread, but several paths authenticate the caller without checking their authority over the particular resource or capability.

No evidence of actual compromise was sought or established. Local proofs used invented users, records, tokens, and harmless browser markers. The deployed build and production feature flags were not checked. This is a broad review of all product surfaces, not a line-by-line certification of all code or a promise that every vulnerability has been found. The remaining verification work is explicit below.

Keep this technical report in the authenticated workspace. Do not publish it as an unlisted public page or send it to external issue trackers before remediation/disclosure review.

## Threat model and coverage

The review considered anonymous internet callers, ordinary team members, authenticated users in another workspace, malicious shared messages/repositories/pages, other local OS users, stolen limited-purpose credentials, and compromised authorized remote hosts or release sources.

Assets include login identity; private conversations, prompts, DMs and attachments; team administration; provider grants; local files, terminal and browser control; clipboard/media; remote credentials; and released executables. Intentionally authorizing an agent to execute code is not itself a vulnerability. Reading a shared conversation does not imply authority to become its runner.

| Surface | Reviewed | Remaining proof needed |
|---|---|---|
| Shared auth / Convex | Provider linking, passwords, API tokens, relays, workspace access, dispatch, session registration/delivery, command queues, admin samples, sync log, storage | Deployed verification flag; real auth-library persistence; exhaustive public API role/resource matrix; invitation/recovery/revocation lifecycles |
| Integrations | GitHub install/OAuth, generic provider reconnect, Gmail confirmation, Slack identity mapping, GitHub/Slack/Linear webhook verification | Provider test tenants; all adapter scopes; Slack DM migration fixture; historical link audit |
| Web / content | Canvas sanitization and generated DOM, markdown/vault rendering, publishing gates/caches/control tokens, server headers | Every rich-content sink; authenticated browser regression suite; warmed CDN revocation tests |
| CLI / daemon | HTTP/WS, hooks, terminal, vault/FS, bridge pairing, tab grants, remote copying/provisioning/credential transfer | Full inert daemon integration; malformed-input/resource bounds without stressing live services; concurrent filesystem races |
| Browser extension / native helper | Manifest/background/pairing, HMAC handshake, local socket permissions and peer checks | Released extension and macOS helper runtime/permissions; packaging drift |
| Electron | Navigation/preload/IPC, permissions, native browser panes, screen selection, CDP configuration | Packaged-app foreign-navigation and requesting-frame tests with fake capabilities |
| Mobile / VSCode / shared | SecureStore/auth trust, WebView canvas, deep links, extension subprocess construction, scopes/encryption utilities | Device runs, native entitlements/update provenance, VSCode restricted-mode behavior |
| Release / infra / dependencies | Installer, updater, manifest and CI publication, web/Convex hosting config, artifact edge cache, dependency audit | Live IAM/firewall/backup restore, signing-key controls, production runtime inventory, exhaustive advisory reachability and history secret scan |
| Legacy desktop | Generated Tauri schemas only in this checkout | Locate deployed source/config if a Tauri build remains supported |

Recon counted roughly 4,609 tracked package files and 1,047 public Convex export declarations by source pattern. Counts describe scale, not completed individual endpoint tests. Generated platform packages were read; their canonical edit location is `~/src/platform`.

## Prioritized finding register

P0 means immediate containment/repair assessment. P1 means next security release. P2 means scheduled hardening or a narrower-impact fix. Severity describes potential impact; confidence describes evidence. H/M/L are high/medium/low; effort is relative engineering size, not a delivery promise.

| ID | Priority / severity | Finding and prerequisite | Evidence / confidence | Effort / change risk | Plan |
|---|---|---|---|---|---|
| BACKEND-01 | P0 / Critical | New native Apple identity can select an existing account using caller-supplied email; needs a valid Apple token for the configured app | `platform/packages/auth/src/convex/providers.ts:42,60`; `callbacks.ts:73-89`. Real control flow, JWT/persistence mocked. H | M / M | 001 |
| BACKEND-02 | P0 / Critical conditional | Password signup deduplicates into existing OAuth-only user without verified email when verification is disabled; source default is disabled, production flag unknown | `createAuthConfig.ts:138-153`; `callbacks.ts:65-89`. Callback proof + library trace. H code | M / M | 001 |
| BACKEND-03 | P0 / Critical | Signed-in member applies a conversation/bucket field policy to their membership ID, allowing admin promotion and potentially foreign-team retargeting | `packages/convex/convex/dispatch.ts:369-401,458`. Real patch + admin predicate on fake DB. H; retarget source-traced | S first fix, M allowlists / M | 002 |
| BACKEND-04 | P0 / High | User knowing another conversation ID registers a fresh session against it, removes its runner registration and reads queued private prompts | `managedSessions.ts:117,220-240,253-325,674-684`. Real functions, fake DB. H | M / M | 002 |
| CLIENT-01 | P0 / High | Chart generation reintroduces a script-bearing link after sanitization; victim must click the chart | `packages/web/lib/castChart.ts:91-148`; `HtmlSnippet.tsx:120-130`. Real pipeline + harmless Chrome execution marker. H | M / M | 003 |
| BACKEND-05 | P1 / High | Any signed-in caller knowing a pending-message ID can mark another user's prompt delivered | `managedSessions.ts:688-716`. Real handler, fake DB. H | S / M | 002 |
| BACKEND-06 | P1 / High | All-workspaces enumeration includes team-routed rows that are private to a different owner | `packages/convex/convex/data.ts:137-145,201-204`. Access predicate denied fixture that list returned. H | M / M | 002 |
| BACKEND-07 | P1 / High | Unverified alternate email claims unmapped Slack identity and can retarget its mirrored DMs; requires team membership and unclaimed identity | `users.ts:209-229`; `slackSync.ts:1253-1285,1622-1663`. Full source chain, no Slack run. H code | M / M | 001 |
| LOCAL-01 | P1 / High | Directly opened vault SVG can execute at the daemon origin and read the URL's full control bearer; normal inline image rendering is inert | `vault/vaultServer.ts:160-169,343-354`; `terminal/terminalServer.ts:21,379-386`. Real handler/policy fixture; no terminal exploit. H code | M / M | 004 |
| PARENT-01 | P1 / High | Anonymous GitHub installation callback trusts unsigned caller identities; unbound installation can be linked without proving installer access | `http.ts:174-217`; `githubAppInstallState.ts:44`; `githubApp.ts:251-327`. Real handler/core, fake DB/provider. H | M / M | 005 |
| PARENT-02 | P1 / High | Generic OAuth reconnect replaces an already-confirmed grant before confirmation; needs initiated connect flow and another provider authorization | `oauthConnectors.ts:347-402,424-443,495-503`. Real store core, fake DB. H | M / M | 005 |
| PARENT-03 | P1 / High | Arbitrary published-page scripts share a document with owner/edit/comment tokens; owner opening their management URL exposes its authority to that content | `artifactPages.ts:445-454`; `artifactsHttp.ts:482-507,1060-1091`. Real branded page, sandbox and synthetic hash in Chrome. H | L / H | 006 |
| CLIENT-02 | P1 / High conditional | Foreign top-level page can inherit Electron preload; several IPC handlers lack sender checks. Chart HTTPS links offer a navigation path | `packages/electron/main.js:259-265,381-385,1725-1730`; `preload.js:62`. Fake IPC proof; complete packaged chain untested. M chain | M-L / M | 003 |
| CLIENT-03 | P1 / High potential | Electron capability checks authorize containing window instead of requesting frame, including null webContents | `main.js:3209-3253,3308-3318`; `FrameBackend.tsx:209-223`. Actual callbacks on synthetic requests. H policy, M impact | M / M | 003 |
| CLIENT-04 | P1 / High privacy risk | Auth storage wrapper prevents sibling-window logout events; global cache/replication can retain or mix old-principal state | `durableAuthStorage.ts:148-180`; installed auth `client.tsx:146`; `syncReplication.ts:259`; `idbCache.ts:85`. Storage-event proof; full account switch pending. H defect, M disclosure | L / H | 007 |
| PARENT-07 | P1 / High conditional | Updater interpolates unsigned-manifest URL into a shell; installer/updater lack independent manifest authenticity | `packages/cli/src/update.ts:35`; `platform/packages/cli-kit/src/update/updater.ts:249-269`; `packages/web/public/install.sh:56-91`. Source-confirmed; needs release-source/manifest control. H | S adapter, L trust chain / H | 008 |
| PARENT-08 | P1 / High availability potential | Vulnerable ws parser accepts unauthenticated extension first messages up to 256 MiB; opaque Origin is admitted | `browser/bridge/host.ts:1123,1138-1149,1200-1201`. Actual ws 8.18.0 resolution + code trace; no exhaustion. H reachability | S-M / M | 004/008 |
| BACKEND-08 | P2 / Medium | Anonymous content predicate query checks that a share token exists, never requires possession | `messages.ts:2583-2614`. Real handler, fake DB. H | S / L | 002 |
| BACKEND-09 | P2 / Medium | Device-bound bearer restriction exists at HTTP wrapper but direct public Convex calls bypass it; attacker already holds valid token | `apiTokens.ts:73-80,113-124`; `users.ts:3596-3639`. Real direct query fixture. H | M-L / H | 002 |
| LOCAL-02 | P2 / Medium | Unauthenticated hook GET changes state; rejected status events still persist/schedule caller-selected transcript ingestion | `daemon.ts:2105-2112,28030-28035`. Extracted real callback with inert sinks. H | M / M | 004 |
| LOCAL-03 | P2 / Medium | Repository setup-copy entries escape both worktrees in legacy remote move; requires user invoking that transfer to an authorized host | `remote/session-move.ts:857-870`. Real manifest/path code, processes stubbed. H | S-M / M | 004 |
| CLIENT-05 | P2 / Medium | Canvas media and escaped CSS bypass promised network isolation | `canvasSanitize.ts:24-38,64-76`; mobile `CastCanvas.tsx:108-138,325-332`. Browser CSS/DOM proof with network blocked. H | M / M | 003 |
| CLIENT-06 | P2 / Medium | Untrusted canvas host CSS can escape its layout and cover trusted controls | `HtmlSnippet.tsx:35-39,103,233,263`. Harmless fullscreen layout fixture; route-dependent extent. H component | M / M | 003 |
| PARENT-04 | P2 / Medium | Direct public comment mutation bypasses HTTP access/rate gate; expired/password page accepts anonymous stored comment | `artifactsHttp.ts:727-764`; `artifacts.ts:1145-1282`. Real mutation, fake DB. H | M / M | 006 |
| PARENT-05 | P2 / Medium | Public caching of previously authorized artifact versions/assets weakens password/delete/expiry revocation | `artifactsHttp.ts:834-836,925-944`; `infra/artifact-edge/worker.js:39-59`. Actual response header fixture; no live CDN test. H config | M / M | 006 |
| PARENT-06 | P2 / Medium | Auth redirect uses string prefix, allowing a different hostname with the trusted URL prefix | `platform/packages/auth/src/convex/callbacks.ts:32`. Actual callback synthetic URL proof. H; no auth-code theft proved | S / L | 001 |
| PARENT-09 | P2 / mixed, triage | Dependency audit has 96 high/critical advisory/version match rows across 25 package names; these are not 96 exploitable app bugs | `bun.lock`; `plans/security-dependency-matched.json`. ws is separately reachable; remaining call paths pending | L / M | 008 |
| PARENT-10 | P2 / hardening | Main web responses lack CSP/frame-ancestors and several browser isolation headers | `packages/web/server/index.ts`; read-only HEAD of codecast.sh returned no CSP. No standalone exploit claimed. H observation | M / M | 003/008 |

The detailed backend, client and local reports retain prerequisites, controls, compatibility risks, and coverage limits: `security-review-backend.md`, `security-review-clients.md`, `security-review-local.md`. The parent independently inspected cited boundaries and reduced conditional Electron/cache claims to the evidence actually established.

## Additional evidence for parent-owned findings

### PARENT-01 — GitHub install identity

`githubAppInstallState.ts` encodes/decodes base64 JSON without a signature. The public callback takes the user/scope/team fields from that state, retrieves installation metadata with the application's GitHub credentials, and passes those claimed identities to `storeInstallation`. Membership checks on the claimed user do not prove who made the callback. The existing-installation guard is valuable: **an already-linked installation cannot simply be rebound** through this path. The exposure is an unbound/first-link installation, a race before legitimate binding, or a removed prior binding; it also allows forged installer attribution. Installation metadata retrieval alone does not prove the caller controls that installation.

A synthetic unauthenticated request reached `fetchInstallationDetails` and `storeInstallation`, returned 302, and created a personal binding for the named fixture user. GitHub/network were stubbed. The repair is a single-use server-held authenticated install intent, current team-admin authorization where applicable, and proof that the authenticated GitHub user can access that installation. GitHub explicitly documents the spoofed-installation-ID risk in its [setup URL guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).

### PARENT-02 — OAuth replacement becomes active too soon

New generic connector grants have a confirmation hash; the existing confirmed connection branch overwrites the usable encrypted grant without setting one. `finishConfirm` then returns success early when there is no pending hash, and `connectionForWork` accepts the replacement. A synthetic confirmed personal connection changed to another provider account and immediately remained usable. This is not an unsigned-state claim: connect state is HMAC-protected. The attack uses a legitimately initiated connection flow whose provider authorization is completed by someone else, with no enforced final Codecast identity check before replacing the active account.

Keep pending replacement separate from the active grant; promote it only after an authenticated confirmation by the bound initiating principal with current workspace authority. Do not break an existing working connection on a failed/unconfirmed reconnect. Gmail's user-plus-email storage and confirmation path differ; the generic reconnect finding is not automatically assigned to Gmail.

### PARENT-03 — Published-page control credentials share untrusted execution

The response sandbox omits `allow-same-origin`, which correctly protects ordinary first-party storage. It nevertheless permits scripts in the document containing publisher HTML, injected controls and URL hash capabilities. The owner key can authorize management changes; the comment identity token can authorize authorship. Owner-authorized comment delivery can reach the linked agent session. Page code can read these capabilities from its own hash regardless of opaque origin. The token is not protected from the content it controls.

An inert page generated by the real branding function and served with the production sandbox read synthetic owner and identity hash markers in Chrome. First-party storage was blocked, but a CORS-enabled API fixture remained reachable. No real management action, token, or agent message was used. Put privileged controls in a trusted document and raw page content in a separate sandboxed child; never deliver management/comment identity capabilities to that child. Validate exact frame/message type for any narrow interaction. Replace long-lived commenter capabilities with appropriately scoped/expiring authority and provide revocation.

### PARENT-04 — The underlying mutation is the security boundary

The HTTP comments handler applies a slug limiter. The public `submitComments` mutation is directly callable and accepts anonymous submissions without the same password/expiry/rate checks. A fake-DB expired, password-protected page accepted and stored a benign anonymous comment through that mutation, without a limiter row. It did **not** deliver to an agent: the owner-key delivery gate held. `recordView` likewise exposes direct counter/viewer writes requiring abuse review. Place shared enforcement in the write core or make the public transport invoke an internal implementation with independently established authority.

### PARENT-05 — Revocation and caches disagree

Current responses use `public, max-age=60, stale-while-revalidate=300`; historical responses/assets can use `public, max-age=3600, stale-while-revalidate=86400`. The edge worker also forces public caching and does not purge as part of gate changes. Origin rechecks cannot retract a body already served by a browser/CDN. An actual historical-asset handler fixture emitted the long public policy. This does not prove arbitrary outsiders can retrieve a token-keyed cache entry without the URL. It means old authorized URLs/bodies can remain available beyond the newly set gate/expiry. No system can claw back bytes a viewer deliberately saved; the actionable promise is future network responses after revocation.

### PARENT-06 — Redirect origin comparison

`redirectTo.startsWith(siteUrl)` is not origin equality. The real callback accepted a synthetic unrelated host beginning with the configured URL. Parse and compare origins, restrict protocols, and validate intentional native deep links separately. PKCE and other auth controls may limit the consequence; no token-stealing chain was demonstrated.

### PARENT-07 — Executable delivery needs independent trust

The CLI adapter invokes a shell with double-quoted manifest URL interpolation. Double quotes still permit shell command substitution before any file checksum verification. The installer downloads an executable directly; the updater compares against a hash provided by the same unsigned manifest source. CI signs Darwin artifacts and verifies staged hashes, which are useful controls, but client trust is not independently anchored against a compromised manifest/distribution source. This is a conditional supply-chain path, not an unauthenticated webpage-to-shell claim.

Use argv-based execution or a download API immediately. Add a signed manifest with pinned verification key, explicit HTTPS/origin/redirect rules, version rollback policy, and platform-signature verification where available. Define the old-client bootstrap and key-rotation process before rollout. Edit the canonical `~/src/platform/packages/cli-kit` implementation and regenerate its mirror.

### PARENT-08/09 — Reachable parser exposure versus audit noise

The CLI resolves `ws@8.18.0`. The upstream [ws advisory](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p) identifies a fragment-related denial of service and a fix in 8.21.0. The bridge upgrades `/ext` before authenticating the first complete message and installs a 256 MiB parser; `Origin: null` passes its HTTP(S)-only rejection. HMAC still prevents unauthorized browser commands. Raw local clients can reach the fragment parser; **browser JavaScript cannot choose arbitrary RFC6455 fragmentation**, so the exact advisory is not asserted as a browser attack. Large unauthenticated browser messages are a separate concern, conditional on local-network access policy. No exhaustion test ran.

Upgrade the resolved runtime copy, constrain pre-auth message size/deadline/concurrency, and reject unexpected/null Origins before upgrade. The broader audit matched vulnerable ranges, including `@auth/core@0.37.4`, but source usage must be established before assigning application exploitability. See the [upstream Auth.js advisory](https://github.com/nextauthjs/next-auth/security/advisories/GHSA-7rqj-j65f-68wh). An old nested package, unused middleware or a different router deployment mode is not automatically a reachable production vulnerability.

### PARENT-10 — Browser response policy

The server lacks a central security-header policy; a read-only production HEAD request also lacked CSP. Introduce CSP in report-only mode with a deliberate script/style/frame/connect policy, then enforce a tested policy. Add frame-ancestors, nosniff and referrer policy where appropriate; validate Permissions-Policy and HSTS against real subdomains and call/embedding flows. This is defense in depth, not a substitute for fixing generated-DOM injection.

## Execution and release order

1. **Contain and repair identity and authority.** Confirm deployed exposure without reading secret values; consider temporarily disabling only vulnerable Apple/linking and generic patch paths if a correct fix cannot ship promptly. Implement 001 and the urgent slice of 002, plus the chart sink in 003. Review suspicious account links, membership role/team changes and runner replacements from retained evidence. Preserve evidence before targeted session/token revocation; do not delete accounts or mass-reassign DMs by heuristic.
2. **Close content-to-machine and integration boundaries.** Finish 003; implement 004, 005 and 006. A chart or vault fix must not depend on completing a large sandbox redesign. Small enforceable guards can precede architectural isolation.
3. **Complete revocation, identity transitions and supply-chain assurance.** Implement 007 and 008, including remaining 002 direct-API credential restrictions. One release owner tracks canonical platform changes, backend, web, CLI, desktop and mobile versions. Old clients may need a bounded compatibility window; record its final removal version/date.
4. **Prove the boundaries end to end.** Use disposable accounts, teams, files and provider test tenants; exercise direct APIs as well as the UI. Run a complete role/resource matrix and packaged/native checks. Publish only sanitized verification receipts externally. Keep remediation open until all finding rows are fixed, explicitly accepted with rationale, or replaced by a proven false-positive determination.

Each numbered plan is self-contained, names source/test boundaries and compatibility hazards, and requires evidence beyond unit tests. Suggested workstreams are plans 001–008; they are not a claim that each should be a single large PR.

## Decisions to discuss

- **Identity linking:** Recommend explicit proof before linking identities. A matching email string should never merge usable credentials. Legitimate convenience can use a verified mailbox or an authenticated account-linking ceremony.
- **Runner and device authority:** Recommend separating permission to read a conversation from permission to run it or control its machine. Decide whether device binding promises mere routing affinity or cryptographic possession; the current label overstates what a supplied device ID proves.
- **Rich content:** Recommend keeping interactive published HTML while moving controls outside it, and making in-app canvas obey a strict no-script/no-unapproved-network contract. Choose whether full arbitrary CSS belongs in an isolated iframe rather than same-document shadow DOM.
- **Revocation:** Recommend account-wide local purge and bounded future-network revocation for shared content. Decide the supported offline/shared-device behavior and attachment capability lifetime, then encode that contract in tests.

## Validation receipt

- Parent: 183 existing focused tests passed, 0 failed, 586 assertions (`plans/security-tests.log`).
- Backend: 155 passed, 0 failed; seven synthetic handler/core assertions plus the native Apple fixture.
- Local: 86 passed, 0 failed, 261 assertions; inert vault/hook/copy fixtures.
- Clients: 164 passed, 0 failed; 31 Electron native-pane tests passed; isolated Chrome and fake Electron policy probes.
- Total: **619 existing test executions passed**. Green baseline tests missed the new attack cases; this is not a security clearance.
- `bun audit --json` ran; raw and range-matched outputs are under `plans/security-dependency-*`. Dependency failure status reflects reported advisories.
- No application-source edits, commits, deployments, live account attack, production mutation, load attack, real media/clipboard access, or secret-value dump. No full build/lint/typecheck gate was run for this read-only review. Scratch services and audit-owned browser tabs were closed.

## Closure gaps and hardening backlog

These are required follow-up review items, not proven additional exploits:

- Build a public-entrypoint inventory with identity class, resource authority, allowed fields, quota, audit trail and revocation semantics. Cover org/delegation/decisions, invitations, chat/calls/transcripts, tasks/plans/docs/projects, joins and storage. Test owner, other member, admin, foreign account, anonymous, revoked member, share guest, wrong-table ID, expired/wrong-scope token and stale session.
- `images.ts:45-79` intentionally treats known storage IDs as capabilities for signed-in users. Decide whether a revoked viewer should still resolve them. Add per-user upload size/type/quota and lifecycle tests where absent; do not label the documented capability model a bug without establishing the intended guarantee.
- `users.linkGitHub` at `users.ts:2390-2416` accepts GitHub identity fields without provider proof. Inventory downstream identity/assignment uses and replace authority-bearing claims with verified provider data. No standalone login takeover from this path is established.
- Linux browser launch uses `--no-sandbox` (`browser/remote.ts:48`). Validate a sandboxed image or isolate browser execution from credential-bearing agent accounts. Authorized remote credential forwarding and first-use SSH `accept-new` are intentional trust decisions; narrow grants and pin instance identity where required.
- Unify canonical-path checks in daemon config operations, including create/delete symlink ancestors; current ordinary issuer is owner-scoped. Bound temporary auth callback request bodies (`platform/packages/auth/src/cli/authServer.ts:77`). Authenticate dormant resident-browser handlers before mounting them.
- Audit live IAM/release credentials and R2 write/read boundaries, key rotation, backup restoration, secret history, logging redaction and anomaly detection. Do not retrieve or paste credential values. Reuse existing provider-key rotation task ct-39959 where applicable.
- Test prompt-injection resistance at capability admission: repository files, websites, provider content and published comments are untrusted data. Prompt text is not an authorization boundary; validate scope/consent at the command issuer and host. Do not disable intended user-authorized agent execution as a substitute.

## Considered and not claimed

- No extension command-auth bypass: HMAC/pairing/tab ownership checks hold in the reviewed paths; the finding is pre-auth parser exposure.
- No generic SVG execution from an inline image; the vault chain requires document navigation.
- No arbitrary iframe IPC access proved; Electron foreign-main-document navigation remains a packaged integration test.
- No packaged Electron CDP exposure by default; explicit opt-in is an intentional local capability.
- No script access to normal first-party storage from the opaque published-page sandbox; its own control tokens are the issue.
- No arbitrary non-transcript file upload proved by the hook issue; parser and sync-scope restrictions still apply.
- No unsigned webhook claim: reviewed GitHub, Slack and Linear paths verify signatures; Slack/Linear also have replay controls.
- No blanket SSRF, remote shell injection, all-symlink exfiltration, or E2EE guarantee inferred from intentional execution/transport features or unused utility code.

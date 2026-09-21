# Independent review: identity remediation

Task: ct-53052. Plan: pl-734. Reviewer session: jx7c0ed. Date: 2026-09-21.

**Bounded code verdict: NEEDS_CHANGES.** The supplied account-takeover and new Slack-claim regressions pass, but the new password normalization breaks both mixed-case OTP flows and existing mixed-case password accounts. These are introduced compatibility defects, independent of the pending signup-verification policy.

**Release/acceptance verdict: incomplete.** Historical authority cleanup, native legacy proof recovery, product decisions, vendoring and deployed/concurrent integration verification remain separate work. This review does not authorize a release or declare old mappings safe.

## Scope and evidence

Reviewed the uncommitted canonical auth changes in `/Users/ashot/src/platform/packages/auth/src/convex/{providers.ts,callbacks.ts,createAuthConfig.ts,createAuthConfig.test.ts,identity.security.test.ts}` and Codecast changes in `packages/convex/convex/{users.ts,slackSync.ts,slackSync.test.ts,users.aliasVerification.test.ts}`. Canonical platform HEAD: `33f2761772fa708b2857166a7197f2ef7c93fbb4`; Codecast HEAD: `07a081b853ca9bad1a1872eb757eb69a5c1acd34`. The Codecast auth mirror was not refreshed at review time.

Traced installed `@convex-dev/auth` **0.0.79**, including `Password`, `Email`, OAuth callback handling, `auth.store`, `createAccountFromCredentials`, `createVerificationCode`, `verifyCodeAndSignIn`, and `upsertUserAndAccount`. Dependency citations below refer to its `src/` tree under `/Users/ashot/src/platform/packages/auth/node_modules/@convex-dev/auth/`; reproduction imports use the distributed JS entry points, matching package exports.

Independently executed, in tmux:

- Canonical auth `bun test`: **97 passed, 0 failed**. `/tmp/ct-53052-review/auth.log`, exit receipt `auth.exit`.
- Codecast Slack/alias focused suites: **55 passed, 0 failed**. `/tmp/ct-53052-review/slack.log`, exit receipt `slack.exit`.
- Four additional reproductions: **4 passed, 0 failed**, asserting the failures and retained authority described below. `/tmp/ct-53052-review/repro.log`, exit receipt `repro.exit`.

Reproduce the additional checks with:

```sh
SITE_URL=https://fixture.example.test bun test \
  /tmp/ct-53052-review/normalization.test.ts \
  /tmp/ct-53052-review/slack-refresh.test.ts
```

These are synthetic fixtures invoking real provider/store/handler code over the existing in-memory database helper. They do not provide Convex transaction isolation, deployed HTTP/OAuth callbacks, or real-account evidence. No product code was edited; no install, vendor, commit, deploy, browser or real-account operation was performed. Full integrated gates remain the release owner's responsibility.

## Code blockers

### ID-REVIEW-01 — P1: normalized password accounts cannot verify an OTP with the original mixed-case email

**Location:** canonical `packages/auth/src/convex/createAuthConfig.ts:171–176`, particularly `return { email: params.email.trim().toLowerCase() }`.

The new profile function normalizes the account identifier but leaves the original `params.email` unchanged. Installed `Password.ts:136–147` creates/looks up the account with the normalized profile email, while `Password.ts:174–176`, `:187`, and `:209–211` pass the original params into reset/verification. Installed `Email.ts:50` requires exact equality between `account.providerAccountId` and `params.email`.

**Reproduction:** sign up with verification enabled using `MixedCase@example.test`; account ID becomes `mixedcase@example.test`, but the code is sent with the original address. Redeeming the correct delivered code with `MixedCase@example.test` throws `Short verification code requires a matching email in params of signIn` (the actual error includes backticks). A reset initiated with the same mixed-case address fails on redemption as well, including when signup verification is disabled. Surrounding whitespace has the same underlying mismatch.

The real UI preserves the input: `packages/web/components/EmailVerificationForm.tsx:32` and `packages/web/app/reset-password/page.tsx:39–43` pass the original email. Existing auth tests only exercise lowercase addresses (`identity.security.test.ts:161`, `:175`), so the supplied green tests miss this path.

**Required change:** make one canonical email value reach account lookup, OTP creation and OTP verification, while retaining the exact account binding check. Normalize at a boundary that controls the params passed through the whole Password flow, not only the returned profile. Add actual-library tests for mixed case and surrounding whitespace covering signup verification and password reset; assert successful verification, correct account identity and no unintended duplicate account.

### ID-REVIEW-02 — P1: unconditional canonical lookup strands legacy password accounts

**Location:** canonical `packages/auth/src/convex/createAuthConfig.ts:171–173`.

Before this change, the factory supplied no Password profile override. Installed `Password.ts:249–252` returned `params.email` unchanged, and `Password.ts:145–147` persisted that exact string as `authAccounts.providerAccountId`. The new implementation lowercases every sign-in and reset lookup. A previously valid identifier such as `LegacyCase@example.test` is no longer looked up, even when the user submits the same address and correct password.

**Reproduction:** create a password account through the installed Password provider's prior default profile and the real auth store; verify that signing in through that same provider succeeds. Switch to the new configured provider on the same stored account. Both `signIn` with the correct password and `reset` throw `InvalidAccountId`; no recovery email is sent. The reproduction uses actual password hashing/verification and actual account persistence. Its user callback is current, which does not affect this exact `authAccounts` lookup failure.

**Required change:** preserve an authenticated path to legacy identifiers, or perform an explicitly reviewed, collision-aware account-ID migration before canonical-only lookup ships. Do not resolve this by adopting whichever `users.email` row happens to match. Add a fixture created with the previous profile behavior, then demonstrate login and recovery using the new implementation while retaining the same user/account. Include a collision case so case variants cannot silently merge credentials belonging to different accounts. Fixing ID-REVIEW-01 alone does not repair already-stored mixed-case identifiers.

## Confirmed controls in this bounded implementation

- Native Apple derives authority from verified JWT claims; a caller-supplied victim email does not select the victim. Missing/unverified email creates no verified receipt. Signature, issuer, audience and expiration failures leave persistence untouched. Returning subjects retain their original owner even when email is absent or changes (`providers.ts:31–49`; installed `createAccountFromCredentials.ts:40–60`).
- The callback receives the library's existing account owner, not a user selected by the library's email heuristic. The custom callback runs before the library's default linking policy (`implementation/users.ts:57–65`). New linking requires verified incoming proof plus exactly one existing verified owner; a raw users-table email or ambiguous proven owners is insufficient (`callbacks.ts:72–93`).
- Password input cannot inject proof: its profile contains only email, and credential proof is restricted to the configured native Apple provider. Password collision with an existing email is rejected in both verification modes, before credentials are attached (`callbacks.ts:81–82`). This intentionally prevents password adoption of OAuth-only accounts; it does not supply a new verified password-enrollment feature.
- Provider wrappers explicitly source proof from Google/Apple claims and GitHub's verified-email endpoint. GitHub email HTTP failure returns no email proof while retaining the subject (`createAuthConfig.ts:100–151`). Tests exercise that HTTP-failure branch. A thrown network/JSON failure aborts the callback; it does not grant authority. Existing-subject OAuth sign-in can stamp proof without reassigning the subject owner.
- Redirects are parsed and constrained to the configured HTTP(S) origin, with separate configured native schemes; sibling/prefix hosts, userinfo, protocol-relative targets, backslashes and alternate ports fail the supplied tests (`callbacks.ts:17–40`).
- Adding an alternate address no longer schedules a Slack claim. Both automatic primary-email matching and queued email claims require unique verified ownership. Non-admin self-mapping requires that same proof or a stored Slack OAuth token matching installation, workspace, user and Slack subject (`slackSync.ts:247–262`, `:1600–1608`, `:1654`). Manual/admin mapping policy is preserved separately.

## Residual authority and unfinished acceptance items

### Historical Slack access survives a failed refresh check

This is **confirmed residual exposure and an audit-preservation hazard**, not a newly discovered fresh-claim bypass. Historical revocation is explicitly root-owned and excluded from this bounded patch.

The stricter `teammateByEmail` result feeds `upsertSlackUser` at `slackSync.ts:1377`. When a previously automatic mapping lacks proof, refresh clears `codecast_user_id` and `mapped_by` at `:1380–1385`, but does not retarget/revoke `chat_channel_members`. `chatAccess.ts:77–78` continues authorizing the existing DM membership. The synthetic reproduction refreshes an unverified historical mapping, confirms the mapping is now absent, and still obtains `true` from the actual `canAccessChannel` helper for that member's DM.

**Release action:** preserve the pre-refresh mapping/provenance and audit room membership, links and message/room merges, not just the current `slack_users` map. A refreshed map can look clean while private access remains. Historic alias-triggered claims were marked `manual` by `assignSlackPerson`; those survive refresh outright, and the same label also covers genuine admin/OAuth choices. Do not blanket revoke or bless every manual row. Root must complete its approved historical evidence/revocation policy before declaring this finding closed.

### Product and compatibility work

1. **Unique password signup remains immediately usable when verification is off.** `createAuthConfig.ts:157–158` retains the flag default. Root reports the production flag absent and delivery key present; this reviewer did not independently read production configuration. The original acceptance requirement to prove mailbox ownership before activation is still pending a human policy decision.
2. **Alternate addresses are contact-only.** There is no alias OTP schema/UI/activation path in this diff. The new boundary safely removes their authority, but the decision between verified aliases and Slack-OAuth-only linking and corresponding user-facing behavior remains open.
3. **Legacy native Apple proof is not refreshed.** The installed credentials account-creation function returns an existing subject before the callback (`createAccountFromCredentials.ts:46–60`). A formerly created native account with neither a user verification timestamp nor an account mailbox receipt therefore remains ineligible for new automatic email linking even after a fresh signed token proves the same mailbox. Subject login itself still works. Decide and verify a safe proof-upgrade path that preserves subject ownership; do not infer proof from provider presence.
4. **OAuth-only accounts cannot enroll a password through reset.** The collision rejection suggests resetting a password, but installed `Password.ts:170` requires an existing password account. Existing-provider sign-in remains available. Do not describe reset as a recovery option for an OAuth-only user; if verified password enrollment is required, implement it explicitly after proof.
5. **Concurrency/runtime evidence is still missing.** Sequential fake-DB tests do exercise the installed persistence code, but cannot prove Convex retry/rollback behavior for simultaneous first signup, cross-provider creation or OTP redemption. The release owner still needs disposable deployed flows and transactional concurrency checks, including the new normalization regressions.
6. **Integration/release is unfinished.** Vendor canonical auth, run the integrated typecheck/lint/test gates, verify the deployed endpoints and record versions. Review existing historical auth links/sessions separately; this patch does not revoke prior credentials or sessions.

The two normalization defects need implementation fixes and regression tests before this bounded code can pass independent review. Remaining rollout/product/historical work must remain visible even after those fixes pass.

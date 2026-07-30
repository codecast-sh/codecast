# HANDOFF — local-first v3 rollout + open dispatch-UX bug

Written 2026-07-30 by the outgoing master session (jx7f196, session 3a1b9170) at Samvit's request.
Successor: you own ct-40207 (driver task, in_progress) end-to-end. Do not delegate deploys.
This file is deliberately untracked — delete it when absorbed.

---

## 1. Goal

Ship the v3 (`log-ts`) local-first read coverage to production: shadow-soak it, then cut reads
v1→v3 in ONE migration (the "skip-v2-cutover" plan of record, pl-205), with an open
user-facing dispatch bug fixed FIRST (Samvit: "codecast can't be unusable during this period").

## 2. State of the world (verified at stop time)

- **Git:** working tree clean; local main == origin/main == `20c8baeb`. Everything described
  below is committed and pushed. NOTE: pushes auto-deploy Railway web, so prod web already
  runs the v3 client code — inert, because the flags still select the v2 contracts.
- **Convex shared backend (prod for everyone):** deployed from clean main `20c8baeb`
  (exit 0, log at /tmp/convex-deploy-v3.log). The v3 server half (envelope echo +
  command-id receipt coverage) is LIVE. Additive — v1/v2 clients unaffected.
- **Railway flags (NOT touched):** `VITE_LOCAL_FIRST_V2_ENABLED=1`,
  `VITE_LOCAL_FIRST_COMMENTS_MODE=shadow`, `VITE_LOCAL_FIRST_BUCKETS_MODE=shadow`.
  The stage-1 `shadow-lts` flip has NOT happened. No cutover anywhere.
- **Suites at last full run:** convex 911/911, web local-first 111/111 (+ cutoverFeedPrune 3),
  tsc clean in both. CLI suite had one non-reproducing exit-1 flake historically — rerun
  before trusting a red.
- **/verify-codecast:** PASSED end-to-end (run 1785414286; test conv
  `jx77b403a3vjx4n0nghv7zgk4n8bgn1r`, harmless). One known-class anomaly: a stale
  "Message hasn't reached the agent" banner on a revive-path injection despite successful
  delivery — that is DWB-03 (daemon campaign, already filed on the Step-2 gate), not new.

## 3. OPEN BUG — fix before any rollout step

**Symptom:** Samvit clicked new-session and saw
`Dispatch not wired — "createSession" parked for later delivery`.

**Established mechanism (do not re-derive):**
- `store/mutativeMiddleware.ts` — asyncActions fired while the dispatch binding is absent
  durably enqueue to the outbox, then reject with `DispatchNotWiredError(action, parked:true)`.
  The class comment (lines ~34-37) documents the contract: **parked = pending — caller must
  NOT toast and NOT revert local state**; the write auto-delivers: `_setDispatch` calls
  `drainOutbox()` immediately when wired (~line 634). There is no 30s wait for boot parks.
- The gate (`store/local-first/dispatchGate.ts` + `hooks/useEnsureDispatch.ts`): dispatch
  wires only when the principal runtime is `server-verified` + storage healthy + correlation
  non-null. Legitimately-closed windows: boot verification round-trip; auth token rotation;
  a ≤30s epoch-staled-binding window; degraded storage.
- **Root cause of the visible error:** the new-session caller chain does not implement the
  parked contract. Siblings already do — `components/ConversationView.tsx:10871` and
  `lib/modelSwitch.ts:116` have exactly `if (err instanceof DispatchNotWiredError && err.parked) return;`.
- Design intent confirmed with the parking author (session jx781t8; full reply in my
  transcript): the honest rejection is deliberate (removing it regresses ct-40175 — fork
  errors vanished); the fix is caller-side. Author-endorsed hardening: make
  `usePrincipalDispatchAllowed` subscribe to correlation-epoch IDENTITY (not the boolean) so
  a staled binding re-binds immediately instead of ≤30s — do NOT add a second drain path.

**Fix plan (agreed with Samvit, none of it implemented — zero edits exist):**
1. Parked-check at every new-session caller; keep the stub visible as pending and route it
   through the EXISTING heal machinery (`ensureSessionCreated` at `store/inboxStore.ts:5106`,
   `pendingSessionCreates`/`trackSessionCreate` ~:2401, `healStrandedStub`). The create
   delivers via the outbox; the stub rekeys via the `by_session_id` resolver (stub id ==
   session_id by construction — see `beginOptimisticSession` ~:4082 comments).
2. Epoch-identity subscription in `dispatchGate.ts` / `useEnsureDispatch.ts` (see above).
3. `useEnsureDispatch.ts:97`: a null authorization capture bails BEFORE the self-heal
   listeners/interval are installed — move installation above the bail.
4. Secondary gap found: `components/ContextChatInput.tsx:135` calls RAW
   `store._dispatch("createSession", ...)` — the raw path does NOT enqueue (rejects plain
   "Dispatch not wired", write genuinely dropped). Route it through the parked asyncAction
   or handle the drop explicitly.
5. RN note: `useEnsureDispatch.ts:107` early-returns before listeners on React Native → no
   self-heal there at all. Mobile runs flags-off; note it, don't fix it in this pass.
6. RED-first tests for 1–3 (the campaign discipline: write the failing test before the fix).
   Where the error string RENDERS in the UI was not yet located — find the surface (likely a
   toast/`lastDispatchFailure` consumer or the NewSessionView first-send catch) and pin it in
   the test.

## 4. Rollout steps after the fix (in order; gates are real)

1. Full suites: `packages/web: bun test store/ hooks/` · `packages/convex: bun test convex/`
   · `packages/cli: bun run test` (NEVER bare `bun test` from repo root — iOS Pods scan
   kills stdout). Typecheck both (`bunx tsc --noEmit`; convex: `-p convex/tsconfig.json`).
2. Push (= Railway web deploy), then deploy per Ashot: **`scripts/deploy.sh` with a FORCED
   CLI RELEASE** — the daemon fixes (DEC-01/DPM-02, daemon campaign) have never reached
   teammates' released CLI binaries; the forced release ships them fleet-wide. Convex side
   is already live; skew is benign by design. Never restart Samvit's production daemon
   without his OK.
3. Verify prod bundle by probe: `curl codecast.sh` → extract `/assets/index-*.js` → grep the
   compiled env with DIGIT-SAFE classes (`[A-Z0-9_]` — `[A-Z_]` silently misses `V2`).
4. **Stage 1 flip:** `railway variables --service web --set VITE_LOCAL_FIRST_COMMENTS_MODE=shadow-lts --set VITE_LOCAL_FIRST_BUCKETS_MODE=shadow-lts`
   (project `codecast` in ASHOT's workspace, env production; CLI authed from this checkout).
   Build-time vars — a var change alone may not rebuild; push or redeploy to take effect.
   Convex is already deployed, so the ordering rule (convex before web) is satisfied.
5. **Soak:** `window.__CODECAST_SHADOW_VALIDATION__()` on prod — expect v3 contract ids,
   digest equality, `mismatchedViews: 0`. `PrincipalStoreIdentityError` occurrences are the
   ZERO-TOLERANCE signal (the restored equal-ts tripwire). The soak clock intentionally
   resets at the flip. First mount per browser does a one-time supersession re-bootstrap of
   the durable slice (invisible — v1 still renders). Multi-day evidence per ct-40207.
6. **Read cutover** (`cutover-lts`): ONLY with Samvit's explicit OK. Rollback = revert vars.
7. Stage 3 (writes / Step-2): gated on CMD-02 + R-01 + R-11 + DWB-03 (all documented in the
   matrix). The command-coverage shape (`command-id` naming v3 contracts) is already on all
   8 handlers and lands once — convex-js#182 (filed, awaiting maintainers) only optimizes it.
8. Stage 4: delete `local_view_heads` machinery only after ALL slices' reads+writes leave
   view-revision. Pre-stage-2 revisit pin (reviewer): whether prod equal-ts rejection should
   degrade to refetch instead of freezing the view.

## 5. Canonical documents (read in this order)

1. `docs/architecture/local-first-v3-rollout-pipeline.md` — OPERATIVE: stages, gates,
   runbook, review verdicts, CLI/daemon/mobile impact (verified: none).
2. `docs/architecture/local-first-sync-test-matrix.md` — 71-row adversarial ledger, every
   row verdicted; extend it, never re-audit.
3. `docs/architecture/local-first-log-ts-coverage-investigation.md` — why log-ts; the
   #182 story (echoed-command-id proof made it an optimization, not a blocker).
4. `docs/architecture/local-first-sync-and-runtime-binding-design.md` §26 — living checklist.
5. Memory: `local-first-sync-matrix.md` in the project memory dir is current.

## 6. Key v3 code map (all committed)

- `packages/web/store/local-first/coverage.ts` — kind-aware ordering (`compareLogTs`).
- `persistence/dexieAdapter.ts` — monotonic fences; full-strength equal-ts tripwire
  (`assertEqualLogTsContent`); contract supersession in `claimViewWriter({supersedes})`;
  echoed-id `command-id` coverage matching for log-ts views.
- `transitionStamper.ts` — consistent `(result, logTs)` pairs; the ONE internal cast
  (`ConvexReactClient.sync`), documented; Convex-level optimistic updates forbidden on
  stamped queries.
- `localViewSession.ts` (`deliverStamped`) · `hooks/useLocalView.ts` (stamper path) ·
  `featureFlags.ts` (`shadow-lts`/`cutover-lts`) · `referenceContracts.ts` (v3 contracts,
  `envelopeContractId` consumes the v2 envelope).
- Server: `convex/localFirstCommands.ts` (`echoedCommandIdsForView`, scan 200/limit 64),
  `smallViewContracts.ts` (`grantedView` `commandIds`), 5 comment + 3 bucket handlers carry
  `coverageCommandIds`; `functions.guard.test.ts` pins all of it.
- Tests: `store/local-first/__tests__/logTsCoverage.test.ts` (+ the campaign suites).

## 7. Environment loose ends

- tmux `lf-v3-preflight` (vite :3211, shadow-lts flags): kill or reuse for local pre-flight.
- tmux `codecast-web` (:3000): long-lived dev server — KEEP.
- tmux `lf-convex-deploy`: finished — kill.
- Chrome MCP tab last on :3211. `cc-resume-*` sessions: leave alone.
- Open tasks: ct-40207 (yours), ct-40159 (OAuth refresh single-flight, out-of-layer).
- Other sessions: jx7et9e is a monitoring-only watchdog (no deploys); Samvit directed the
  master to stop cross-session coordination — you own execution alone.

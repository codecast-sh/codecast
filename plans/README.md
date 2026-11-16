# plans/

Generated reports and working notes that code in this repo reads or writes. Day-to-day planning lives in Codecast plans and tasks, not here.

| File | Written by | Read by |
|---|---|---|
| `security-entrypoint-inventory.json`, `.md` | `packages/convex/scripts/security-inventory.ts` | `packages/convex/convex/securityEntrypoints.test.ts` |
| `security-dependency-triage.json`, `.md`, `security-dependency-audit.json` | `scripts/security/dependency-triage.ts` (from `bun audit --json`) | the same script's gate mode |
| `security-csp-draft.md` | hand-written | cited by `packages/web/server/responsePolicy.ts` (why each CSP source is needed) |
| `security-closure-ledger.json` | hand-written | cited by `packages/web/server/responsePolicy.ts` (review that raises the report sample rate) |
| `desktop-performance-20-rounds.md` | hand-written | nobody; a record of the October 2026 desktop performance pass |

The security review itself, its workstream plans and the worker briefs are not kept in this public repository. Keep technical evidence for unreleased fixes inside the authenticated workspace until disclosure is appropriate.

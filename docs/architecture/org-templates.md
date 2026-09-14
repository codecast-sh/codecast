# Folder org templates

`cast org template` installs one standing role for one existing project. The folder supplies shared behavior; an immutable local snapshot pins a release; the project receipt records the instance and its durable Codecast IDs. Installing posts a role proposal. It does not create a role until a person answers that blocking decision and runs reconcile.

## Commands

Run install inside a Cast session on the machine containing the project checkout. `--session` can supply that proposing session's UUID. All instance commands accept `--dir`; it defaults to the current directory.

```sh
cast org template inspect /releases/growth
cast org template install /releases/growth --dry-run --instance product-growth --project <exact-project-id> --team <team-id> --dir /src/product
cast org template install /releases/growth --instance product-growth --project <exact-project-id> --team <team-id> --dir /src/product
cast org template status product-growth --dir /src/product
cast org template reconcile product-growth --dir /src/product
cast org template upgrade product-growth /releases/growth-next --dir /src/product
cast org template upgrade product-growth /releases/growth-next --dir /src/product --apply
cast org template instructions product-growth charter --dir /src/product
```

Fresh installation requires exactly one of `--team` or `--personal`. Later commands default to the receipt's pinned workspace; explicit flags must agree with it. Project lookup uses the exact project ID and verifies its stored `workspace`. The explicit local directory is canonicalized, shown in the human role proposal and pinned in the receipt. A project's global registered path may name a different host: that mismatch is a preview/proposal warning, not a scope change. Later metadata changes produce a warning and never relocate the instance. Subsequent commands must use the receipt's same local directory. No empty-scope fallback or broad analysis-input scan is used.

Install `--dry-run` verifies the artifact, exact live project/workspace and proposed adoption map without creating a snapshot, receipt or proposal. Inspect, status, upgrade preview and instructions also do not mutate Codecast or the receipt. Output is JSON except runtime instructions. `--json` is accepted for consistency.

## Release contract

The entry point is `org-template.json`:

```json
{
  "schemaVersion": 1,
  "id": "growth",
  "version": "1.2.0",
  "name": "CMO",
  "description": "One project CMO with channel routines",
  "role": {
    "name": "CMO",
    "handle": "{{instance}}-cmo",
    "charter": "org/charter.md",
    "caps": { "hands_per_day": 4, "wakes_per_day": 12, "tokens_per_day": 200000 }
  },
  "routines": [
    { "id": "cmo-weekly", "title": "CMO portfolio review", "every": "7d", "prompt": "org/prompts/cmo-weekly.md" }
  ]
}
```

All shown fields are required. Unknown keys are rejected at every manifest object. IDs are lowercase slugs up to 48 characters; expanded role handles must satisfy the backend's 2–32 character rule. Versions are three numeric components. Caps are nonnegative safe integers. Cadences use positive integer `m`, `h`, `d` or `w`, at most one year. Routine IDs are unique; `charter` is reserved. A manifest has one role and at most 50 routines.

Text accepts only `{{instance}}`, `{{project.ref}}`, `{{project.name}}`, `{{project.dir}}`, `{{template.root}}` and `{{instance.file}}`. Substitution is literal. Unknown or malformed tokens fail. Charter and prompt paths are literal relative paths inside the release, with no traversal, absolute paths or symlinks. No shell expansion or install hooks run.

A user-selected root is canonicalized once so normal macOS `/tmp` and `/var` aliases work. Entries within it, and every receipt/cache path, reject symlinks. Artifacts are bounded to 10,000 files, 16 MiB per file and 64 MiB total. Root `.git` and `INSTANCES.toml` are omitted from snapshots and hashes. `.codecast`, `.env` and non-example `.env.*` entries are refused. Publishers must still prepare folders free of customer history and secrets; these name checks are not a secret scanner.

The digest is SHA-256 over sorted relative file paths. Each file contributes `JSON.stringify([path, byteLength, executable]) + "\n"`, then its raw bytes. Executable means any executable mode bit is set. Snapshots preserve executability and remove write permissions. Directory permissions are sealed after atomic rename, since macOS refuses renaming some read-only directories. Runtime recomputes the same digest. Same-version changed content is refused, including previously cached versions. This org-template digest is distinct from any pack-specific runtime digest.

## Receipt and recovery

The receipt lives at `<project>/.codecast/org-templates/<instance>.json`. It stores schema version, instance UUID, template ID/version/digest/root, project ID/ref/name/directory, workspace, proposer session, phase, original proposal, stack and decision IDs, role and standing session IDs, and routine trigger IDs. Extra project-owned fields, such as grants or document IDs, survive upgrades. Releases live under `.codecast/org-templates/releases/<template>/<version>-<digest>`.

Receipts use atomic replacement. A process lock reuses `acquireFileLock` with infinite age staleness: a live holder is never evicted because it is old; dead holders are recoverable. A malformed freshly written lock gets the shared helper's grace period. Work stopped after an ambiguous create request records that attempt before the network call. On rerun:

- Stacks are recovered by the instance UUID in their exact title and their workspace boundary, including completed stacks.
- The one role decision is recovered from that stack and the instance UUID marker.
- Roles use existing apply-decision idempotence. An already-applied result must name the same role short ID before recovery accepts it.
- Provisioning reuses the role's standing anchor. Its conversation identity and the human-approved local directory are verified before binding routines.
- Routines are recovered by their instance/routine marker and exact loader, standing-session binding and project directory.

If an attempted create has no verifiable server row, the command stops instead of risking duplication. Inspect server state before repairing that receipt; removing an attempt flag is only appropriate once the prior request is known not to have created anything. Do not delete a receipt to retry an installation. Per-project receipt locks do not coordinate two machines with independently copied receipts.

## Human approval and scheduling

Installation creates an explicit-boundary stack without inheriting the proposer session's workspace. Its one protected `access` decision carries the shared `org-proposal` contract and the fixed create/create-with-changes/skip options. Reconcile requires `answered_by.kind === "user"`, a blocking decision, and the original proposal block. A human's answer may change the role, but its scope must still be exactly the instance project and initial trust must be `understand`.

Reconcile calls `/cli/org/apply-decision` with `provision: false`, verifies the resulting role, then calls `/cli/role/provision` with the explicit project directory. The backend must include the personal-stack boundary fix: when a stack exists, its personal or team boundary is authoritative rather than falling through to the conversation's team. Deploy that backend before using personal template reconcile.

The trigger backend currently cannot atomically create a paused trigger. New recurring triggers therefore have a first run one year ahead and a temporary `precheck: "exit 1"`, then are paused and read back with a zero run count. A failed pause leaves the temporary gate in place. The receipt does not become ready before these checks pass. Runtime loaders also reject incomplete, external, retired, paused or gated routines, and inactive roles.

The template CLI never clears this gate or resumes a trigger. After human review of the routine, the role's actual trust and required grants, use this exact procedure for each approved routine:

1. Keep the trigger **paused**. If necessary, pause it first with `cast trigger pause tr-N`.
2. While paused, run `cast trigger update tr-N --every 7d --precheck ''`, substituting the **actual live cadence**, including any human override. The `--every` flag is essential: it resets `run_at` to now plus that cadence, preserving recurring scheduling and paused status while clearing the temporary gate. If a human replaced the temporary gate with a custom precheck, stop and review it; the CLI withholds this command rather than removing that override.
3. Run `cast org template status <instance> --dir <approved-checkout>` and verify the row remains `paused`, `gated` is false, `intervalMs` matches the reviewed cadence and `runAt` is one cadence ahead.
4. Only then explicitly run `cast trigger resume tr-N`.

**Clearing the gate and resuming without `--every` leaves the first run one year away**, because the backend's resume operation preserves a nonzero `run_at`. Status and reconcile output include a per-routine activation procedure with the actual cadence rendered in seconds, so weeks and custom live overrides are preserved exactly. Those commands are instructions, not authorization. Incomplete upgrades, external routines and retired routines receive no activation procedure. A precheck is not a sandbox: manually forcing a trigger or arbitrary shell access can bypass scheduler checks. These operations do not claim to isolate credentials, tools or files, and `understand` never becomes elevated automatically.

## Upgrades and adoption

Apply waits for all managed runs to finish before starting an upgrade, including changes that only edit prompt content. Interrupted upgrade recovery checks again before advancing the release. External runs do not block this check.

Upgrade defaults to preview, listing changed files, shared-charter changes, cadence overrides, and added/removed routines. `--apply` advances only the named instance. Role identity, caps, trust, human charter, grants, and durable IDs are retained; identity or cap changes require a separate org decision. The charter uses a stable loader referencing the receipt, so updating the release pointer does not rewrite the human's charter document.

Existing managed trigger prompts remain stable loader commands. Unchanged schedules keep their live pause state. New routines are gated and paused. Removed managed routines retain their IDs and are paused, then marked retired locally. Changed managed cadences are paused for review. A live cadence that differs from the previous manifest is an override: preview shows it and apply preserves it. Before any pause or cadence write, an upgrade pins its target artifact and atomically persists `phase: "upgrading"` plus a journal: original and target releases, original routine metadata, added/removed IDs, and each planned cadence's before/after values. It remains upgrading until every required routine is verified. Failed creation cannot report ready; runtime routine instructions and ordinary reconcile refuse while this journal exists.

Rerun `upgrade <instance> <target-folder> --apply` to finish forward, or pass the journal's original release folder with `--apply` to roll back. A preview identifies that recovery direction; any unrelated release is refused until recovery finishes. Recovery recognizes its own partially applied cadence writes from the saved before/after values. A third live value is treated as concurrent human drift and stops recovery instead of overwriting it. Rollback restores planned cadences, retains paused state, and records newly created routine IDs as paused/retired rather than deleting them. It never resumes routines. An ambiguous new-trigger create with no verifiable server row remains blocked even during rollback. A receipt backup remains beside the current receipt for the prior digest.

To adopt already running channels, pass explicit mappings on install or reconcile:

```sh
cast org template install /releases/growth --instance product-growth --project <exact-project-id> --team <team-id> --adopt ads-monitor=tr-462 --dir /src/product
```

Adopted triggers must exist in the account's full trigger list and match the pinned project directory. They are external references, with actual cadence and pause observations. Their prompts, bindings, cadence, precheck, pause state and IDs are never changed by reconcile or upgrade, even if the new release removes the routine. One trigger cannot satisfy multiple routine IDs. Existing external channels may still target older sessions; adoption records that fact, it does not perform a cutover.

## Verification

`bun test ./packages/cli/src/orgTemplate*.test.ts` exercises the lifecycle against a fake API, including interruptions after server success, fresh/rerun behavior, scope and workspace refusal, rejected/advisory answers, snapshot corruption and symlink escapes, paused creation, human charter preservation, cadence overrides, external trigger adoption, multi-host project paths, partial upgrade/rollback failures and concurrent cadence drift. `orgTemplateActivation.test.ts` executes the actual backend update/resume functions against a fake database to pin the paused schedule-reset procedure. CLI registration is lazy and uses `OrgInitDeps`; no dependencies or backend mutations are introduced by the CLI implementation.

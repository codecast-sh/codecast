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
    "charter": "org/charter.md"
  },
  "routines": [
    { "id": "cmo-weekly", "title": "CMO portfolio review", "every": "7d", "prompt": "org/prompts/cmo-weekly.md" }
  ]
}
```

All shown fields are required. Unknown keys are rejected at every manifest object. IDs are lowercase slugs up to 48 characters; expanded role handles must satisfy the backend's 2–32 character rule. Versions are three numeric components. `role.caps` is optional, as is each of its keys; a role hired without a cap has no limit on it. Caps are nonnegative safe integers. Cadences use positive integer `m`, `h`, `d` or `w`, at most one year. Routine IDs are unique; `charter` is reserved. A manifest has one role and at most 50 routines.

Text accepts only `{{instance}}`, `{{project.ref}}`, `{{project.name}}`, `{{project.dir}}`, `{{template.root}}` and `{{instance.file}}`. Substitution is literal. Unknown or malformed tokens fail. Charter and prompt paths are literal relative paths inside the release, with no traversal, absolute paths or symlinks. No shell expansion or install hooks run.

A user-selected root is canonicalized once so normal macOS `/tmp` and `/var` aliases work. Entries within it, and every receipt/cache path, reject symlinks. Artifacts are bounded to 10,000 files, 16 MiB per file and 64 MiB total. Root `.git` and `INSTANCES.toml` are omitted from snapshots and hashes. `.codecast`, `.env` and non-example `.env.*` entries are refused. Publishers must still prepare folders free of customer history and secrets; these name checks are not a secret scanner.

The digest is SHA-256 over sorted relative file paths. Each file contributes `JSON.stringify([path, byteLength, executable]) + "\n"`, then its raw bytes. Executable means any executable mode bit is set. Snapshots preserve executability and remove write permissions. Directory permissions are sealed after atomic rename, since macOS refuses renaming some read-only directories. Runtime recomputes the same digest. Same-version changed content is refused, including previously cached versions. This org-template digest is distinct from any pack-specific runtime digest.

## A role that owns a line

A v2 manifest may give its role the line it runs: `role.line`, a workflow slug (`line`, `feature`, or one pushed to the workspace), and `role.caps.cards`, a positive integer, the open change cards the line admits work against (line-profile.md LP6). Both are optional; v1 refuses them like any other unknown key. Install copies them into the role proposal beside the other caps. Applying the person's answer sets `org_roles.line_workflow_slug` and `caps.cards` under that decision, the only path by which a hire sets them, since both are otherwise human only. Reconcile verifies the created role carries the approved line and cap before provisioning, and upgrade refuses a release that changes either. The shipped line template (`packages/cli/org-templates/line/`, line-profile.md LP7) is the reference use.

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

Installation creates an explicit-boundary stack without inheriting the proposer session's workspace. Its one protected `access` decision carries the shared `org-proposal` contract and the fixed create/create-with-changes/skip options. Reconcile requires `answered_by.kind === "user"`, a blocking decision, and the original proposal block. A human's answer may change the role, but its scope must still be exactly the instance project. Afterwards the role's scope must hold the instance project and may grow: a lead's area covers the projects of the leads that report to it, so reconcile refuses only a scope that lost the instance project. The proposal carries the role's Starts work on its own switch, on by default like every hire (off only for the Head of People); applying the answer sets the switch the person approved, and reconcile refuses a role whose switch differs from it.

Reconcile calls `/cli/org/apply-decision` with `provision: false`, verifies the resulting role, then calls `/cli/role/provision` with the explicit project directory. The backend must include the personal-stack boundary fix: when a stack exists, its personal or team boundary is authoritative rather than falling through to the conversation's team. Deploy that backend before using personal template reconcile.

The trigger backend currently cannot atomically create a paused trigger. New recurring triggers therefore have a first run one year ahead and a temporary `precheck: "exit 1"`, then are paused and read back with a zero run count. A failed pause leaves the temporary gate in place. The receipt does not become ready before these checks pass. Runtime loaders also reject incomplete, external, retired, paused or gated routines, and inactive roles.

The host step turns each ready routine on itself (`armReadyRoutines`): bind, reconcile, upgrade and `status` call `orgTemplates.activateRoutine` for a managed routine that is ready (org-hire.md H6) and waiting, meaning created paused and never on (no `run_at`, or the old year-ahead date behind the `exit 1` gate) or paused by an upgrade while its cadence changed. Activation sets the first run one live cadence out and clears only the `exit 1` gate. A routine a person paused after it was on, one behind a precheck a person set, and one the role is paused or retired for stay paused; `cast org template activate` and the role page's Activate turn one on by hand, from a person or the role. A precheck is not a sandbox: manually forcing a trigger or arbitrary shell access can bypass scheduler checks. These operations do not claim to isolate credentials, tools or files, and the role's switch changes only by a person's approval.

## Upgrades and adoption

Apply waits for all managed runs to finish before starting an upgrade, including changes that only edit prompt content. Interrupted upgrade recovery checks again before advancing the release. External runs do not block this check.

Upgrade defaults to preview, listing changed files, shared-charter changes, cadence overrides, and added/removed routines. `--apply` advances only the named instance. Role identity, caps, trust, human charter, grants, and durable IDs are retained. A release's `role.caps` only shape new hires, so changing or dropping them upgrades freely; identity or line changes require a separate org decision. The charter uses a stable loader referencing the receipt, so updating the release pointer does not rewrite the human's charter document.

Existing managed trigger prompts remain stable loader commands. Unchanged schedules keep their live pause state. New routines are gated and paused. Removed managed routines retain their IDs and are paused, then marked retired locally. Changed managed cadences are paused while they change, then turned back on if they were on before. A live cadence that differs from the previous manifest is an override: preview shows it and apply preserves it. Before any pause or cadence write, an upgrade pins its target artifact and atomically persists `phase: "upgrading"` plus a journal: original and target releases, original routine metadata, added/removed IDs, and each planned cadence's before/after values. It remains upgrading until every required routine is verified. Failed creation cannot report ready; runtime routine instructions and ordinary reconcile refuse while this journal exists.

Rerun `upgrade <instance> <target-folder> --apply` to finish forward, or pass the journal's original release folder with `--apply` to roll back. A preview identifies that recovery direction; any unrelated release is refused until recovery finishes. Recovery recognizes its own partially applied cadence writes from the saved before/after values. A third live value is treated as concurrent human drift and stops recovery instead of overwriting it. Rollback restores planned cadences and records newly created routine IDs as paused/retired rather than deleting them. It turns back on only routines that were on when the upgrade began. An ambiguous new-trigger create with no verifiable server row remains blocked even during rollback. A receipt backup remains beside the current receipt for the prior digest.

To adopt already running channels, pass explicit mappings on install or reconcile:

```sh
cast org template install /releases/growth --instance product-growth --project <exact-project-id> --team <team-id> --adopt ads-monitor=tr-462 --dir /src/product
```

Adopted triggers must exist in the account's full trigger list and match the pinned project directory. They are external references, with actual cadence and pause observations. Their prompts, bindings, cadence, precheck, pause state and IDs are never changed by reconcile or upgrade, even if the new release removes the routine. One trigger cannot satisfy multiple routine IDs. Existing external channels may still target older sessions; adoption records that fact. `cast org template cutover <instance> [routine...] --dir <checkout>` replaces them with managed routines at their live cadences, pausing and keeping each adopted trigger (org-hire.md H8).

## Tools a template ships

A role's job is more than its words. The CMO queries Google Ads through a script, the Release Captain plans merges through another, and the channel routines load skills. Those files always travelled inside the release folder, but nothing named them: a prompt reached each one by a `{{template.root}}/scripts/...` path written in prose, the gallery could not say a template brings tools, and nobody could change one without editing the publisher's checkout.

**Declared in the manifest.** A v2 manifest may carry `tools`, at most 50, each `{ id, kind, path, summary?, run?, needs? }`:

```json
"tools": [
  { "id": "gads", "kind": "command", "path": "scripts/gads.mjs", "run": "bun", "summary": "Google Ads API: query with GAQL, validate and apply mutations", "needs": ["bun"] },
  { "id": "ads-daily", "kind": "skill", "path": "skills/ads-daily" }
]
```

- `kind: "command"` is a file the role runs: a script or a CLI with its own subcommands. `run` names the program that runs it (`bun`, `node`, `python3`, `sh`, `bash`); without it the file must be executable in the release. `summary` is required: it is the one line the role and the gallery read.
- `kind: "skill"` is a folder holding `SKILL.md` and whatever files it uses. Its summary is the `description` in the SKILL.md frontmatter, the one place it is written; a skill tool carries no `summary` and no `run`.
- `needs` lists programs the tool expects on the host's `PATH`. `status` and `tools` report the missing ones; nothing installs them.

Inspect refuses a tool whose path is missing, unsafe or of the wrong shape (a command path must be a file, executable unless it names its runner; a skill path a folder with a SKILL.md that has a `description`), and duplicate ids. Tool files are not filled with tokens: a script runs exactly as published and reads its instance from the environment below. Declaring tools changes nothing about the digest, freezing or the snapshot: they were already release files. Adding, removing or changing a tool's entry is a structure release (a minor version); changing only a tool's files is content (a patch).

The gallery card names the commands a template ships and counts its skills; the hire preview lists them; the role page's Template section shows each one with its line, and whether the instance runs Codecast's library copy or the workspace's own.

**How the role finds them.** Every `instructions` answer (the charter and each routine) ends its pinned header with the tool list: each id, its one line, and how to use it. A command is used through `cast org template run <instance> <tool> --dir <checkout> -- <args>`; a skill is read at its SKILL.md path in the pinned release. Prompts reference a tool by `{{tool.<id>}}`, which fills to that same command line or path; a token for an undeclared tool fails inspect. `cast org template tools <instance>` prints the list with what is missing on this host.

**`run` is the stable entry point.** It verifies the pinned release's digest, then runs the tool from it with the project checkout as the working directory and `CODECAST_TEMPLATE_ROOT`, `CODECAST_TEMPLATE_INSTANCE`, `CODECAST_INSTANCE_FILE` (the receipt) and `CODECAST_PROJECT_DIR` set, passing arguments, stdin, stdout and the exit code through. It reads no server state, so it costs what the tool costs. Because a session calls the tool by instance and id rather than by a versioned path, a moved pin changes what runs without any prompt or memory changing.

**Edit, try, release.** The pinned release stays read only. A role, or a person, changes a tool in a draft beside it:

```sh
cast org template edit <instance>                 # writable copy of the pinned release; prints its path
cast org template run <instance> <tool> --draft -- <args>   # try the edited tool
cast org template diff <instance>                 # files changed, the release class, the version it will carry
cast org template release <instance> --changelog "What changed and why"
```

The draft lives at `<project>/.codecast/org-templates/drafts/<instance>/`. `edit` on an existing draft prints its path; `--reset` copies the pin again. `diff` lists added, changed and removed files (`--patch` adds the unified diff) and classifies the draft against the pin with the release rules (`classifyRelease`): content, structure or authority, and the smallest version that class allows.

`release` is the whole loop in one command. It refuses an authority release (a new permission, a routine's mode, the line, the role's identity): the role never widens what it may do, and a person publishes such a change with `publish`. Otherwise it writes the next version into the draft's manifest, adds the changelog as that version's section of the draft's CHANGELOG.md, publishes the draft as a `canary` release into the instance's own workspace, then runs the host step with `--to` that version, so the instance moves through the journalled upgrade and its role is told what moved. The draft is removed once the instance is on the new release; it is now the pin.

**Where an edit flows.** When the instance's workspace published the template, the release is the template's next version, and its other instances see it as an update like any other. When the template came from Codecast's library, the first release creates the workspace's own copy of the template, same id, its versions continuing from the pin. The workspace's own copy is the one its catalog and its instances read from then on, so Codecast's later releases stop being offered to it; that is the cost of running edited tools, and the role page's template line names the copy. Before publishing, `release` files the change upstream as a lesson on Codecast's template (its changelog and the list of changed files, never file contents), so the library can take the improvement into its next release. A Codecast admin releasing from a Codecast instance passes `--codecast` to release into the library itself.

## Verification

`bun test ./packages/cli/src/orgTemplate*.test.ts` exercises the lifecycle against a fake API, including turning ready routines on and leaving a person's pause alone, cutover with live-cadence carry and rerun after interruption, interruptions after server success, fresh/rerun behavior, scope and workspace refusal, rejected/advisory answers, snapshot corruption and symlink escapes, paused creation, human charter preservation, cadence overrides, external trigger adoption, multi-host project paths, partial upgrade/rollback failures and concurrent cadence drift. `orgTemplateActivation.test.ts` executes the actual backend update/resume functions against a fake database to pin the paused schedule-reset procedure. CLI registration is lazy and uses `OrgInitDeps`; no dependencies or backend mutations are introduced by the CLI implementation.

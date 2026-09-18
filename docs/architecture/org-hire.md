# Hiring a role from a template (W8)

Written 2026-09-18 from the founder's ask after the growth pack reached its
second release on Codecast: the CMO built there must become a role anyone can
hire on any project, and everything the pilot learned must have a place in the
product so the next lesson lands there too. Builds on org-templates.md (the
pinned folder, receipt and loader, as shipped), org-roles-standing.md (W1),
org-staffing.md (S4 to S7, S12, S16) and org-roles-run-work.md (W7). The
growth pack in `~/src/platform/packs/growth` is the first template and the
only instance today; this contract is written so it needs nothing outside it.

The principle: a template is a role you can hire more than once, and a hire
is a proposal like any other. The folder supplies the job; the person supplies
the project, the answers, the money and the accounts; the org feature supplies
the seat, the schedule, the approvals and the memory. The role never carries
authority the person did not grant in the browser, and the person never has to
read a folder to know what they are hiring.

What the org feature has today and this contract reuses without change: the
role row (name, handle, scope, trust, caps, charter doc, brief, standing
session), proposals with changes a person accepts one by one, routines as
triggers on the standing session, the pinned release folder with its digest,
receipt and loader, and the per-machine install that verifies the checkout.

What it lacks, each of which the pilot needed in its first month: answers a
template asks for at hire time; grants of money and external authority, given
by a person and read by the role; credentials bound to the instance without
ever entering a file the template owns; the list of things only a person can
do, with what each unlocks; evidence that a channel is ready before its
routine runs; ledgers per channel and a scoreboard the role page shows; a way
for a lesson learned on one instance to reach the template and, after review,
every other instance; and a record on the server of which templates exist and
where they run, so a hire can start from the web and an upgrade can find its
instances.

## H1. The template is a server object; the folder is its release

**Tables.** `org_templates`: `{ template_id (slug), name, description,
publisher: { kind: "workspace", id } | { kind: "codecast" }, latest: { version,
digest }, releases: [{ version, digest, published_at, changelog, status:
"draft" | "canary" | "stable" }], manifest (the latest release's manifest, so
the hire dialog renders inputs, grants and setup without the folder),
avatar?, created_by, created_at }`. `org_template_instances`: `{ template_id,
version, digest, workspace: { kind, id }, project_id, instance (slug), role_id,
host: { machine, dir }, receipt_digest, config (answers, H3), grants_state
(H4), setup (H5), evidence (H6), ledgers (H7), scoreboard (H7),
update_policy: "manual" | "canary" | "stable", phase, created_at, updated_at }`.
The receipt on disk stays the local pin and gains one field, `instance_id`;
the server row is the record the web reads and the upgrade walks.

**Publishing.** `cast org template publish <folder> [--status canary|stable]
[--changelog -]` inspects the folder (org-templates.md rules), uploads the
snapshot as a storage blob, and writes or advances the `org_templates` row.
Same version with a different digest is refused, as in the CLI today. A
template published by a workspace is visible to that workspace; a template
published by Codecast (`publisher.kind = "codecast"`) is visible everywhere.
The growth pack is published by Codecast and is the first entry of the
catalog. `INSTANCES.toml` in the pack retires: the instances table is the
registry.

**Install from the record.** `cast org template install <template>[@version]`
resolves the template from the server, fetches the release blob, freezes it
under `.codecast/org-templates/releases/` exactly as a folder install does,
and continues with the existing flow. The folder form stays for authors
(`install <folder>`).

## H2. Manifest v2: what a template can say

`org-template.json` with `schemaVersion: 2`. Every v1 field keeps its meaning;
the exact shape rule stays (unknown keys refused). New top level fields, all
optional except where noted:

```json
{
  "schemaVersion": 2,
  "id": "growth", "version": "2.0.0", "name": "CMO",
  "description": "…",
  "role": { "name": "CMO", "handle": "{{instance}}-cmo", "charter": "org/charter.md",
            "caps": { "hands_per_day": 4, "wakes_per_day": 12, "tokens_per_day": 200000 },
            "avatar": "fox", "tenure": { "kind": "standing" } },
  "inputs": [ { "key": "product.domain", "label": "Apex domain", "kind": "string", "required": true, "help": "…" },
              { "key": "budget.monthly_envelope_usd", "label": "Monthly growth envelope", "kind": "money", "required": true },
              { "key": "accounts.google_ads", "label": "Google Ads credentials", "kind": "secret", "required": false,
                "unlocks": ["ads-daily"] } ],
  "grants": [ { "id": "ads-spend", "kind": "spend", "label": "Paid search inside the monthly envelope",
                "limit": { "usd_per_month": "{{input.budget.monthly_envelope_usd}}" }, "requires": ["accounts.google_ads"] },
              { "id": "social-publish", "kind": "publish", "label": "Post to the selected social accounts",
                "requires": ["accounts.publora"] } ],
  "setup": [ { "id": "search-console", "title": "Verify the domain in Google Search Console", "who": "human",
               "unlocks": ["seo-weekly"], "how": "org/setup/search-console.md" } ],
  "evidence": [ { "id": "technical", "title": "Crawler HTML and metadata verified", "max_age": "7d", "required_for": ["seo-weekly"] },
                { "id": "ads_billing", "title": "Ads delivery eligible, billing clear", "max_age": "24h", "required_for": ["ads-daily"] } ],
  "ledgers": [ { "id": "cmo", "title": "CMO ledger: weekly portfolio review" }, { "id": "ads", "title": "Ads ledger" } ],
  "scoreboard": [ { "key": "primary_events", "label": "Primary events, last 7 days" },
                  { "key": "cost_per_primary_usd", "label": "Cost per primary event" } ],
  "routines": [ { "id": "cmo-weekly", "title": "…", "every": "7d", "prompt": "org/prompts/cmo-weekly.md",
                  "mode": "propose" },
                { "id": "ads-daily", "title": "…", "every": "1d", "prompt": "org/prompts/ads-daily.md",
                  "requires": { "grants": ["ads-spend"], "evidence": ["ads_billing"] } } ],
  "learn": { "review": "codecast" }
}
```

**Inputs** (`inputs[]`): `key` is a dotted slug; `kind` is `string | number |
money | boolean | choice | project_ref | doc_ref | task_ref | secret`;
`required`, `default`, `help`, `choices` for `choice`, `unlocks` (routine ids
this answer makes possible). A `secret` input is never a value: it is a
reference to a credential the host holds (H4). Answers live on the instance
row as `config` and are written to the checkout as the instance file the
template names (`instance_file`, default `.codecast/org-templates/<instance>.config.json`;
the growth pack keeps its `.codecast/packs/growth.toml` through this field).
Prompts and the charter may use `{{input.<key>}}` beside the six v1 tokens.
An unanswered optional input substitutes to the empty string; a required one
blocks the hire.

**Grants** (`grants[]`): what the role asks a person for, beyond trust.
`kind` is `spend | publish | write | connect`; `limit` carries the numbers a
person sees and the role reads (`usd_per_month`, `usd_per_day`, `per_day`);
`scope` names the account, campaign or destinations when the template knows
them; `requires` lists the inputs that must be answered before the grant can
be given; `expires` is a review boundary (`90d` default). A grant is not
enforcement. The platforms enforce (Google's caps, the plan tier); codecast
records, reports and refuses to arm what was not granted.

**Setup** (`setup[]`): the ordered list of things a person does once, each
with `who` (`human | role`), `unlocks` (routine or grant ids), `how` (a
markdown file in the release), and optionally `price` (one line: what it
unlocks, in the pilot's words "each item priced by what it unlocks").

**Evidence** (`evidence[]`): named checks with a `max_age` and the routines
they gate. Records are written by the role (H6) and expire.

**Ledgers** (`ledgers[]`): durable tasks the hire creates in the project, one
per id, reused when a task with the marker already exists. **Scoreboard**
(`scoreboard[]`): the keys the role reports and the role page renders.

**Routines** gain `mode` (`propose | apply`, default `propose`) and `requires`
(grants and evidence that must hold before activation is offered). **Learn**
names who reviews lessons: the publisher workspace, or `codecast`.

## H3. The hire: catalog, answers, proposal, host step

**From a template** in the hire dialog (`HireRoleDialog`, mode `template`)
replaces the two path fields with a catalog: the templates visible to the
workspace, each with its name, face, one line, version and what it asks for
(inputs, grants, setup count). Choosing one renders the inputs as a form.
Secret inputs render as "bind on the host" with the command that binds them
(H4), never as a text field. The preview below the form is the proposal a
person will decide: the role (name, handle, scope, caps, face, tenure), the
routines with their cadence and what each requires, the grants requested with
their limits, and the setup list with who does each item.

**Submit** posts an `org_proposals` row through the existing `create` core
with changes `{ kind: "role" }`, `{ kind: "routine" }` per routine, and the
new `{ kind: "grant", handle, grants: [...] }` (H4), each in one ask; plus
`{ kind: "hire", template, version, instance, project, config }` which the
apply core turns into the instance row. Deciding stays browser only
(org-staffing.md S4). Accepting the role change creates the role at
`understand` and provisions the standing session; accepting a grant records
it; accepting the hire writes the instance row in phase `awaiting_host`.

**The host step** is one line the role page shows until it is done: `cast org
template bind <instance>` run in a Cast session on the machine with the
checkout. It pins the release, writes the receipt and the instance file from
the server's answers, creates the routines paused (H8), binds secret inputs
(H4), and moves the instance to `ready`. The web never asks for paths; the
host step confirms the checkout it runs in, as install does today.

`cast org template install <folder|template> …` remains the shell form of the
same flow: it posts the same proposal from the terminal and prints the
decision to answer.

## H4. Grants and credentials

**Grants on the role.** `org_roles.grants?: [{ id, template_instance_id?,
kind, label, scope?, limit?, granted_by, granted_at, expires_at, decision_id }]`.
Written only by the apply core for a `grant` change a person accepted, or by
`cast role grant` from a browser identity (`refuseUnlessHuman`); revoked the
same way. A grant is an immediate wake with the grant as cause. The wake
frame's `You` section lists grants with their limits and expiry; `cast role
show` prints them; the role page shows them under Trust.

**What a grant means.** Trust is authority over codecast (answer decisions,
start hands). A grant is authority over something outside codecast (spend on
an account, publish to destinations, write to a repository, connect a
service). The two are independent: a CMO at `understand` may hold a spend
grant and still not start hands. Routines whose `requires.grants` are not all
held are never offered activation (H8); a role that finds a needed grant
missing at runtime reads and drafts, then updates the setup item that unlocks
it.

**Credentials.** A `secret` input binds to a credential the host machine
holds. `cast org template bind <instance> --secret <key>=<path>` records on
the instance row `{ key, host: machine, path_hash, bound_at }` and writes the
path into the local instance file; the value never leaves the machine and
never enters the server. Where a capability binding exists for the service
(`capabilityBindings`, session scope), the bind step names it instead of a
path. The role page shows each secret as bound or missing, with the bind
command. An upgrade never touches bindings.

## H5. Setup: the list only a person can clear

**State.** `org_template_instances.setup: [{ id, status: "open" | "done" |
"skipped", done_at?, evidence?: { label, href } }]`, seeded from the manifest
at hire. The role page shows it as a checklist under a Setup tab: each item
with who does it, what it unlocks (the routines and grants named in
`unlocks`, rendered as pills with their current state), the `how` file
rendered, and for `human` items a Done control. A `role` item is done by the
role with `cast org template setup <instance> <id> --done --evidence <href>`.

**The one ask.** The role's weekly report resurfaces exactly one open item,
the highest value per minute (the pilot's escalation law), and the role page
header shows the same item while any are open: "Waiting on you: verify the
domain in Search Console (unlocks SEO weekly)". A hire with open human items
is a role that is working within what it has, not a broken role; the setup
list is how the person sees what more it could do.

## H6. Evidence and readiness

**Records.** `cast org template evidence <instance> <check> --status pass|fail
--source <href> [--detail k=v]...` writes `{ check, status, observed_at,
source, detail }` on the instance row, replacing the previous record for that
check. The growth pack's `readiness.mjs` becomes the local reader of these
records (through the instance file the bind step keeps current) rather than a
separate evidence file.

**Readiness per routine.** A routine is ready when every grant in
`requires.grants` is held and every check in `requires.evidence` has a pass
record younger than its `max_age`. The instance row carries
`readiness: { <routine>: { ready, missing: [...] } }`, recomputed on every
evidence, grant or setup write. The role page's Routines section shows each
routine as paused and not ready (with what is missing), paused and ready
(with Activate), or active.

Readiness offers activation; it does not perform it. A person activates.

## H7. Ledgers and the scoreboard

**Ledgers.** At bind, one task per manifest ledger is created in the project
with `context_summary = "org-template:<instance_id>:ledger:<id>"`, or reused
when the marker exists; the ids land on the instance row and in the instance
file. The role writes its per-channel memory there as comments, the pattern
the pilot proved (run summaries, standing instructions, dead ends marked do
not retry). A hire on a project that already has such tasks adopts them by
marker, so a re-hire never duplicates memory.

**Scoreboard.** `cast org template report <instance> <key>=<value>
[--observed-at] [--source <href>]` writes `scoreboard[key] = { value,
observed_at, source }`. The role page shows the keys the manifest declares
with their last value and age; the brief's fact block leads with them for a
template role, before the scope summary. A value older than the routine's
cadence renders dimmed. No number is stored without a source.

## H8. Routines: created paused, activated by a person, once ready

**Atomic paused create.** `agentTasks.createTask` accepts `status: "paused"`
for recurring triggers: the row is inserted paused with `run_at` unset and
zero runs. The year-ahead `run_at` and `precheck: "exit 1"` gate in
org-templates.md retire; `managedTrigger` recognises both forms until every
instance is rebound.

**Activation** is one control on the role page per ready routine, human only.
It sets `run_at = now + interval` and resumes, the same two writes the
documented CLI procedure performs, in one mutation
(`agentTasks.activateRoutine`), and records `activated_by` on the instance
row. A routine whose live cadence a person changed keeps that cadence through
upgrades (org-templates.md, cadence overrides). `cast org template activate
<instance> <routine>` is the shell form and carries the same human-only rule.

**Adoption** keeps its meaning: `--adopt <routine>=tr-N` records an external
trigger; the role page shows it as external with its own session, and offers
a cutover when the person wants it: pause the external trigger, activate the
managed routine, record both on the instance. Codecast's five growth triggers
cross over this way, one at a time, when the founder chooses.

## H9. Learning: from one instance to the template to every instance

**A lesson is a proposal to the publisher.** `cast org template lesson
<instance> - <<'EOF' … EOF` files a task on the publisher's review project
(`learn.review`) with the instance, release, evidence links and the proposed
change, labelled `template-lesson`, and links it from the instance row. The
role never edits its release (the snapshot is read only) and never edits the
publisher's checkout from an instance; the pilot's write-back into the
canonical checkout was the founder's own machine and stays a publisher
privilege.

**Review and release** are the publisher's: fold the lesson into the folder,
run its tests, publish a new version as `canary`, bind it on the canary
instance, and promote it to `stable` when the canary has run. `cast org
template publish` records the changelog per version; the hire dialog and the
role page show it.

**Fan-out by policy.** An instance with `update_policy: "stable"` gets an
"Update available" line on its role page when a newer stable release exists,
with the preview the CLI produces today (changed files, routine changes,
cadence overrides), and an Update control that posts a proposal `{ kind:
"upgrade", instance, to: version }`; accepting it queues the host step
(`cast org template bind <instance> --to <version>`) which performs the
upgrade with the journal and rollback org-templates.md already has. `canary`
instances are updated by their publisher; `manual` ones only by hand. A
lesson that widens a grant, a cap or a tool never ships as an update; it
ships as a new grant change the person decides.

## H10. What the growth pack becomes

The pack is the first template and carries the pilot's proof, so it adopts
the contract fully rather than keeping a second runtime beside it:

- `pack.toml [config]` becomes `inputs`; `RUNBOOK.md`'s HUMAN items become
  `setup` with their `how` files; `org/READINESS.md`'s checks become
  `evidence`; the five ledgers become `ledgers`; the instance file stays
  `.codecast/packs/growth.toml` through `instance_file`; the budget guard and
  channel skills read grants from the instance file the bind step writes.
- `runtime.mjs` stops being the loader: routines load through `cast org
  template instructions`, which substitutes inputs and prepends the grants
  and readiness the role holds. The skills lose their `${CLAUDE_PLUGIN_ROOT}`
  branch and read `{{template.root}}`.
- `INSTANCES.toml` and the pack maintainer trigger retire in favour of the
  instances table and the publisher's release flow; `CHANGELOG.md` is what
  `publish --changelog` uploads.
- Codecast's instance is re-hired through the new flow with `--adopt` for its
  five triggers, its ledgers adopted by marker, and its grants (the $300
  envelope, the ads campaign, the paused social) proposed for the founder to
  accept as grants. The Growth lead `or-9` is the seat: the hire proposes
  naming it rather than a second manager (org-roles-run-work.md R2).

## H11. Slices

- **W8.1 Contract and backend.** Tables, manifest v2 in `orgTemplateArtifact`,
  `grant` and `hire` and `upgrade` change kinds with their apply, `grants` on
  roles with the human-only writer, evidence and scoreboard and setup writers,
  readiness computation, `createTask` paused and `activateRoutine`.
- **W8.2 CLI.** `publish`, `install <template>`, `bind`, `evidence`, `report`,
  `setup`, `lesson`, `activate`, `--to` upgrades; `instructions` with inputs,
  grants and readiness in its header.
- **W8.3 Web.** The catalog and inputs form in the hire dialog with the
  proposal preview; the role page's Setup, Grants, Routines (readiness and
  Activate), Scoreboard and Update available; secrets as bound or missing.
- **W8.4 The template.** The growth pack on manifest v2, published as canary,
  Codecast re-hired through the flow with adoption, the legacy loader retired.
- **W8.5 Proof.** A second project hired from the catalog end to end by a
  person who did not build it, with the setup list cleared one item at a
  time and the first routine activated from the role page.

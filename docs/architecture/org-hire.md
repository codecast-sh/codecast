# Hiring a role from a template (W8)

Written 2026-09-18 from the founder's ask after the growth pack reached its
second release on Codecast: the CMO built there must become a role anyone can
hire on any project, and everything the pilot learned must have a place in the
product so the next lesson lands there too. Revised the same day from the org
program's review (ten findings, folded in below). Builds on org-templates.md
(the pinned folder, receipt and loader, as shipped), org-roles-standing.md
(W1), W2 D4 (decision grants), org-staffing.md (S4 to S7, S12, S16, S19),
org-roles-run-work.md (W7) and initiatives-projects-role-page.md (W9). The growth pack in `~/src/platform/packs/growth`
is the first template and the only instance today; this contract is written
so it needs nothing outside it.

The principle: a template is a role you can hire more than once, and a hire
is a proposal like any other. The folder supplies the job; the person supplies
the project, the answers, the money and the accounts; the org feature supplies
the seat, the schedule, the approvals and the memory. The role never carries
authority the person did not grant in the browser, and the person never has to
read a folder to know what they are hiring.

What the org feature has today and this contract reuses without change: the
role row (name, handle, scope, trust, decision grants, caps, charter doc,
brief, standing session), proposals with changes a person accepts one by one
through the one apply core, routines as triggers on the standing session, the
pinned release folder with its digest, receipt and loader, and the per-machine
install that verifies the checkout.

What it lacks, each of which the pilot needed in its first month: answers a
template asks for at hire time; authority over money and external accounts,
given by a person and read by the role; credentials bound to the instance
without ever entering a file the template owns; the list of things only a
person can do, with what each unlocks; evidence that a channel is ready before
its routine acts; ledgers per channel and a scoreboard the role page shows; a
way for a lesson learned on one instance to reach the template and, after
review, every other instance; and a record on the server of which templates
exist and where they run, so a hire can start from the web and an upgrade can
find its instances.

## H1. The template is a server object; the folder is its release

**Tables.** `org_templates`: `{ template_id (slug), workspace (the access
key, below), name, description, avatar?, latest: { version, digest },
releases: [{ version, digest, status: "draft" | "canary" | "stable",
changelog?, storage_id?, manifest, published_at, published_by }], manifest (the
latest release's, so the hire dialog renders inputs, authority and setup without
the folder; each release keeps its own, so an instance reads the manifest of the
release it is pinned to), review_project_id?, created_by, created_at,
updated_at }`.
`org_template_instances`: `{ instance_key (the receipt's UUID), instance
(slug), workspace (the hiring workspace's key), template_id, version, digest,
project_id, role_id?, host?: { machine, dir }, phase: "awaiting_host" |
"ready" | "upgrading" | "retired", update_policy: "manual" | "canary" |
"stable", config (answers, H3; never a secret's value), bindings (H4), ledgers
(H7), evidence (H6), scoreboard (H7), setup (H5), created_by, created_at,
updated_at }`. The receipt on disk stays the local pin and gains one field,
`instanceId`; the server row is the record the web reads and the upgrade
walks. The host step upserts it by `instance_key`, so a hire change that
creates the row first (`awaiting_host`) and a rerun of bind meet on one row.

**Access.** Per the repo's access rule (`lib/access.ts`), every row carries
`workspace`, the stored key a viewer's own key is compared against in one
equality: `team:<id>` or `user:<id>`. A template published by Codecast
carries the positive value `"codecast"`, and the catalog reads rows whose key
equals the viewer's or equals that value; an absent or unknown key grants
nothing. Publishing as Codecast is an act of the Codecast team's admins; the
deployment names that team in `CODECAST_TEMPLATES_TEAM_ID`. Instances carry
the hiring workspace's key, read from the project. Lessons carry the
publisher's key.

**Publishing.** `cast org template publish <folder> [--team|--personal|
--codecast] [--status draft|canary|stable] [--changelog -]` inspects the folder
(org-templates.md rules) and writes or advances the `org_templates` row with
the validated manifest and the folder's digest. Same version with a different
digest is refused; the same version and digest again only moves its status or
changelog. The release snapshot as a storage blob (`storage_id`) lands with
install from the record, below. The
growth pack is published by Codecast and is the first entry of the catalog.
`INSTANCES.toml` in the pack retires: the instances table is the registry.

**Install from the record.** `cast org template install <template>[@version]`
resolves the template from the server, fetches the release blob, freezes it
under `.codecast/org-templates/releases/` exactly as a folder install does,
and continues with the existing flow. The folder form stays for authors
(`install <folder>`).

## H2. Manifest v2: what a template can say

`org-template.json` with `schemaVersion: 2`. Every v1 field keeps its meaning;
the exact shape rule stays (unknown keys refused at every object). New top
level fields, all optional; a v1 manifest that carries any of them is refused.
Validated in `packages/cli/src/orgTemplateArtifact.ts` (`validateTemplate`),
tested in `orgTemplateArtifact.v2.test.ts`.

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
              { "key": "accounts.google_ads", "label": "Google Ads credentials", "kind": "secret",
                "unlocks": ["ads-daily", "ads-spend"] } ],
  "authority": [ { "id": "ads-spend", "kind": "spend", "label": "Paid search inside the monthly envelope",
                   "limit": { "usd_per_month": "{{input.budget.monthly_envelope_usd}}" }, "requires": ["accounts.google_ads"], "expires": "90d" },
                 { "id": "social-publish", "kind": "publish", "label": "Post to the selected social accounts",
                   "requires": ["accounts.publora"] } ],
  "setup": [ { "id": "search-console", "title": "Verify the domain in Google Search Console", "who": "human",
               "unlocks": ["seo-weekly"], "how": "org/setup/search-console.md", "price": "unlocks SEO weekly" } ],
  "evidence": [ { "id": "technical", "title": "Crawler HTML and metadata verified", "max_age": "7d", "required_for": ["seo-weekly"] },
                { "id": "ads_billing", "title": "Ads delivery eligible, billing clear", "max_age": "24h", "required_for": ["ads-daily"] } ],
  "ledgers": [ { "id": "cmo", "title": "CMO ledger: weekly portfolio review" }, { "id": "ads", "title": "Ads ledger" } ],
  "scoreboard": [ { "key": "primary_events", "label": "Primary events, last 7 days" },
                  { "key": "cost_per_primary_usd", "label": "Cost per primary event" } ],
  "routines": [ { "id": "cmo-weekly", "title": "…", "every": "7d", "prompt": "org/prompts/cmo-weekly.md" },
                { "id": "ads-daily", "title": "…", "every": "1d", "prompt": "org/prompts/ads-daily.md", "mode": "apply",
                  "requires": { "authority": ["ads-spend"], "evidence": ["ads_billing"] } } ],
  "learn": { "review": "codecast" },
  "instance_file": ".codecast/packs/growth.toml"
}
```

**Inputs** (`inputs[]`): `key` is a dotted slug; `kind` is `string | number |
money | boolean | choice | project_ref | doc_ref | task_ref | secret`;
`required`, `default`, `help`, `choices` for `choice`, `unlocks` (routine or
authority ids this answer makes possible). A `secret` input is never a value
and never has a default: it is a reference to a credential the host holds
(H4). Answers live on the instance row as `config` and are written to the
checkout as the instance file the template names (`instance_file`, default
`.codecast/org-templates/<instance>.config.json`; the growth pack keeps
`.codecast/packs/growth.toml` through this field). Prompts, the charter and
setup files may use `{{input.<key>}}` beside the six v1 tokens; a token for
an undeclared input fails inspect. An unanswered optional input substitutes to
the empty string; a required one blocks the hire.

**Authority** (`authority[]`): what the role asks a person for outside
codecast, beyond trust and beyond decision grants (H4). `kind` is `spend |
publish | write | connect`; `limit` carries the numbers a person sees and the
role reads (`usd_per_month`, `usd_per_day`, `per_day`), each a number or
exactly one input token; `scope` names the account, campaign or destinations
when the template knows them; `requires` lists the inputs that must be
answered before the authority can be given; `expires` is a review boundary
(`90d` default). Authority is not enforcement. The platforms enforce
(Google's caps, the plan tier); codecast records, reports and refuses to
activate what was not granted.

**Setup** (`setup[]`): the ordered list of things done once, each with `who`
(`human | role`), `unlocks` (routine or authority ids), `how` (a markdown file
in the release, checked at inspect), and `price` (one line: what it unlocks,
in the pilot's words "each item priced by what it unlocks").

**Evidence** (`evidence[]`): named checks with a `max_age` and the routines
they gate. Records are written by the role (H6) and expire.

**Ledgers** (`ledgers[]`): durable tasks the hire creates in the project, one
per id, reused when a task with the marker already exists. **Scoreboard**
(`scoreboard[]`): the keys the role reports and the role page renders.

**Routines** gain `mode` (`propose | apply`, default `propose`) and `requires`
(authority and evidence that must hold before activation is offered). **Learn**
names who reviews lessons: `publisher` (the publishing workspace) or `codecast`.

## H3. The hire: catalog, answers, proposal, seat, host step

**From a template** in the hire dialog (`HireRoleDialog`, mode `template`)
replaces the two path fields with a catalog: the templates visible to the
workspace (H1 access), each with its name, face, one line, version and what
it asks for (inputs, authority, setup count). Choosing one renders the inputs
as a form. Secret inputs render as "bind on the host" with the command that
binds them (H4), never as a text field. The preview below the form is the
proposal a person will decide: the role (name, handle, scope, caps, face,
tenure), the seat (below), the routines with their cadence and what each
requires, the authority requested with its limits, and the setup list with
who does each item.

**Submit** posts one `org_proposals` row through the existing `create` core.
The changes: `{ kind: "role" }`, one `{ kind: "routine" }` per routine, one
`{ kind: "authority", handle, authority: [...] }` (H4), and `{ kind: "hire",
template, version, instance, project, config, seat }`, which the apply core
turns into the instance row. **A hire is one ask** (S19): every one of those
changes sits inside it, and `orgAsksErrors` refuses a spec that splits them.
In the apply core (S4, S12) the new kinds take their place in
`ORG_CHANGE_APPLY_RANK` (`authority` after `role`; `hire` after `role`,
`routine` and `authority`; `upgrade` on its own) and rows in
`orgChangeDependencies`, so accepting the hire while skipping its role is
refused the way skipping an adopt's role is today, and accepting the role
while skipping the hire leaves an ordinary role with no instance. Deciding
stays browser only. Accepting the role change creates the role at
`understand`; accepting the authority change records it; accepting the hire
writes the instance row in phase `awaiting_host` and provisions the seat.

**The seat** (S16, R2). A hire from a template on a project seats a fresh
standing session by default, and the preview says so in one line. The form
offers naming an existing session instead, the R2 gesture, for the case where
a long running session already is this role; Codecast's own re-hire uses it
(H10, `or-9` is the seat). Either way the hire row carries `seat: { kind:
"fresh" } | { kind: "existing", conversation }` and the apply core seats
exactly as S16 does for any role.

**The lead** (R4, W9 I2). Every project has a lead, so a hire says who leads
afterwards. When the project has none, the hired role becomes its lead: the
apply core writes `projects.owner_role_id` with the role, the one action R4
already defines. When the project already has a lead, the form shows that role's
face and offers the two honest choices: name that role as the seat (above), or
hire under it, in which case the new role reports to the lead instead of to the
person and the lead stays the lead. The hire row carries `reports_to: "me" |
"@<handle>"`; a template never hires a second role that watches the same project
beside its lead.

**The host step** is one line the role page shows until it is done: `cast org
template bind <instance>` run in a Cast session on the machine with the
checkout. It pins the release, writes the receipt and the instance file from
the server's answers, creates the routines paused (H8), binds secret inputs
(H4), creates or adopts the ledgers (H7), and moves the instance to `ready`.
The web never asks for paths; the host step confirms the checkout it runs in,
as install does today.

`cast org template install <folder|template> …` remains the shell form of the
same flow: it posts the same proposal from the terminal and prints the
decision to answer.

## H4. Authority and credentials

**Three things a role may do, one section.** A role's page and its wake
frame's `You` section list, in this order: its trust (what it may do inside
codecast on its own: understand, decide, direct), its decision grants (W2 D4:
which decisions it may answer), and its authority (this contract: what it may
do outside codecast, with limits and expiry). The role page shows them under
one heading, "What it may do"; the frame prints the three lines together. The
word grant is W2's and stays there; this contract's field is `authority`
everywhere: on the manifest, the change kind, the role row and the CLI.

**Authority on the role.** `org_roles.authority?: [{ id,
template_instance_id?, kind, label, scope?, limit?, granted_by, granted_at,
expires_at, decision_id }]`. Written only by the apply core for an
`authority` change a person accepted, or by `cast role authority <handle>`
from a browser identity (`refuseUnlessHuman`); revoked the same way. A change
is an immediate wake with the authority as cause. `cast role show` prints it.

**Trust and authority are independent, and the coupling is stated.** Trust is
authority over codecast; authority is over something outside it. A CMO at
`understand` may hold a spend authority and still not start hands. The rule a
person will feel: a routine in `apply` mode that requires a `spend` or
`publish` authority is offered activation only when the role's trust is
`decide` or above; at `understand` it runs in `propose` mode whatever the
manifest says, and the role page's routine row says so ("runs as propose:
trust is understand"). The first visit's promise, nothing changes until you
accept, holds: raising trust is the accept.

**Credentials.** A `secret` input binds to a credential the host machine
holds. `cast org template bind <instance> --secret <key>=<path>` records on
the instance row `{ key, host: machine, path_hash, bound_at }` and writes the
path into the local instance file; the value never leaves the machine and
never enters the server. Where a capability binding exists for the service
(`capabilityBindings`, session scope), the bind step names it instead of a
path. The role page shows each secret as bound or missing, with the bind
command. An upgrade never touches bindings.

**Machine moves** (R7). A seat moved to another machine keeps its bindings on
the old one: the value never left that host. On the new host every secret
shows as missing with its bind command, the routines that require the
authority those secrets unlock fall back to not ready (H6), and the wake
frame says which. Binding them again on the new host is the whole repair.

## H5. Setup: the list only a person can clear

**State.** `org_template_instances.setup: [{ id, status: "open" | "done" |
"skipped", done_at?, evidence?: { label, href } }]`, seeded from the manifest
at hire. The role page shows it as a section (H11) with each item: who does
it, what it unlocks (the routines and authority named in `unlocks`, rendered
as pills with their current state), the `how` file rendered, and for `human`
items a Done control. A `role` item is done by the role with `cast org
template setup <instance> <id> --done --evidence <href>`.

**The one ask reaches the person.** The role's weekly report resurfaces
exactly one open item, the highest value per minute (the pilot's escalation
law). The role page header shows the same item while any are open: "Waiting
on you: verify the domain in Search Console (unlocks SEO weekly)". And the
role puts that one item in front of the person the way R1 escalation does:
`cast org template ask <instance> <setup-id>` escalates the standing session
with that line, so the item sits in the inbox as a first class card with the
role's face and reason, not only on the role page; clearing the item clears
the escalation. R1's rule lets a role escalate the sessions that report to it
(`org_role_id`); the standing session is the role itself (`standing_role_id`),
so `performEscalateSession` gains one accepted case: a role may escalate its
own standing session, and only with a line that names an open setup item of
its instance. Nothing else about R1 changes. A hire with open human items is a role working within what
it has, not a broken role; the setup list is how the person sees what more it
could do.

## H6. Evidence and readiness

**Records.** `cast org template evidence <instance> <check> --status pass|fail
--source <href> [--detail k=v]...` writes `{ check, status, observed_at,
source, detail }` on the instance row, replacing the previous record for that
check. The growth pack's `readiness.mjs` becomes the local reader of these
records (through the instance file the bind step keeps current) rather than a
separate evidence file.

**Readiness per routine.** A routine is ready when every id in
`requires.authority` is held and unexpired, every check in `requires.evidence`
has a pass record younger than its `max_age`, and the trust rule of H4 allows
its mode. The instance row carries `readiness: { <routine>: { ready, mode,
missing: [...] } }`, recomputed on every evidence, authority, setup, trust or
binding write. The role page's routine rows show each as paused and not ready
(with what is missing), paused and ready (with Activate), or active.

Readiness offers activation; it does not perform it. A person activates.

**Lapse after activation.** When a required pass record ages past `max_age`,
or an authority expires, while the routine is active, the routine keeps its
schedule but runs in `propose` mode until a fresh pass or renewal: the loader
header says so, the wake frame's `Why you are awake` names the lapsed check,
and the role page's row shows "active, proposing: ads_billing is 3 days old".
The role writes its own evidence, so this is the one place a self certified
pass matters; a pass record must carry a source a person can open, and the
role page shows the source beside the age.

## H7. Ledgers and the scoreboard

**Ledgers.** At bind, one task per manifest ledger is created in the project
with `context_summary = "org-template:<instance_id>:ledger:<id>"`, or reused
when the marker exists; the ids land on the instance row and in the instance
file. The role writes its per-channel memory there as comments, the pattern
the pilot proved (run summaries, standing instructions, dead ends marked do
not retry). A hire on a project that already has such tasks adopts them by
marker, so a re-hire never duplicates memory.

Ledger tasks are memory, not work. They carry `type: "ledger"`, and the task
board, `cast task ready`, `cast task ls`, the Chain axis (W7 R5) and the
role's open work counts exclude that type by default; `--type ledger` or the
board's type filter shows them. They are never assigned and never count as
the role's open work under the person above it.

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

**A lesson is a row on the template, not a task in someone else's workspace.**
An instance lives in the hiring workspace and the template in the publisher's;
a session in one cannot create a task in the other (the access boundary refuses
it, as it should). So `cast org template lesson <instance> - <<'EOF' … EOF`
writes `org_template_lessons: { template_id, workspace (the publisher's key,
or "codecast"), from_workspace, instance_key, release: { version, digest },
body, evidence: [{ label, href }], status: "open" | "accepted" | "declined"
| "released", released_in?, task_id?, created_by, created_at, updated_at }`. The body is the role's own
words with customer data stripped; evidence links stay readable only to those
who could already open them. The server, acting inside the publisher's
boundary, files one task per lesson on the publisher's review project, labelled
`template-lesson`, and links it on the row; that needs a server side task
create (`tasks.create` is an inline handler today, and W7 R5 is in that file),
so until it lands the lesson row itself is the landing place and the publisher
reads it with `cast org template lessons` or on the template page. For `learn.review: codecast` that
project is **Codecast: Templates** in the Codecast workspace, created with this
slice so the first lesson has somewhere to land on day one; for `publisher` it
is the project the template row names (`review_project_id`). The instance sees
its lesson's status on the role page and nothing else of the publisher's
workspace. The role never edits its release (the snapshot is read only) and
never edits the publisher's checkout; the pilot's write back into the canonical
checkout was the founder's own machine and stays a publisher privilege.

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
lesson that widens an authority, a cap or a tool never ships as an update; it
ships as a new authority change the person decides.

## H10. What the growth pack becomes

The pack is the first template and carries the pilot's proof, so it adopts
the contract fully rather than keeping a second runtime beside it:

- `pack.toml [config]` becomes `inputs`; `RUNBOOK.md`'s HUMAN items become
  `setup` with their `how` files; `org/READINESS.md`'s checks become
  `evidence`; the five ledgers become `ledgers`; the instance file stays
  `.codecast/packs/growth.toml` through `instance_file`; the budget guard and
  channel skills read authority from the instance file the bind step writes.
- `runtime.mjs` stops being the loader: routines load through `cast org
  template instructions`, which substitutes inputs and prepends the authority
  and readiness the role holds. The skills lose their `${CLAUDE_PLUGIN_ROOT}`
  branch and read `{{template.root}}`.
- `INSTANCES.toml` and the pack maintainer trigger retire in favour of the
  instances table and the publisher's release flow; `CHANGELOG.md` is what
  `publish --changelog` uploads.
- Codecast's instance is re-hired through the new flow with `--adopt` for its
  five triggers, its ledgers adopted by marker, the Growth lead `or-9` named
  as the seat (H3), and its authority (the $300 envelope, the ads campaign,
  the paused social) proposed for the founder to accept.

## H11. Where it shows, and the slices

**The role page** is the session page (W9 I3): the role talking on the left,
what it looks after on the right, projects first (R3, I2). A template role looks
after one project, so its right column is that project's card followed by what
the template adds, shown only when the role has an instance: the setup list with
the one open item first, what it may do (trust, decision grants, authority),
the routines with readiness and Activate, the scoreboard, and the update line.
These are sections of `RoleScopeView` (ct-52468 owns it; the slot is agreed
there), not tabs; one extra tab, Template, holds the release, its changelog, the
host and the bindings. The header's waiting on you line and the R1 escalation
(H5) are how the person meets the setup list without opening the page. The
scoreboard's first key is the natural progress line for an initiative the
project belongs to (W9 I1); the template does not name initiatives, the person
files the project under one.

- **W8.1 Contract and backend.** Tables with access keys (templates, instances, lessons), manifest v2 (done
  in the CLI artifact module), `authority`, `hire` and `upgrade` change kinds
  with their rank, dependencies and apply, `authority` on roles with the
  human-only writer, evidence, scoreboard and setup writers, readiness with
  the trust and lapse rules, ledger task type and its default exclusion,
  `createTask` paused and `activateRoutine`, the standing session case in
  `performEscalateSession`, the Codecast: Templates project.
- **W8.2 CLI.** `publish`, `install <template>`, `bind`, `evidence`, `report`,
  `setup`, `ask`, `lesson`, `activate`, `--to` upgrades; `instructions` with
  inputs, authority and readiness in its header.
- **W8.3 Web.** The catalog and inputs form in the hire dialog with the
  proposal preview and seat choice; the RoleScopeView sections and the
  Template tab; the header line; secrets as bound or missing.
- **W8.4 The template.** The growth pack on manifest v2, published as canary,
  Codecast re-hired through the flow with adoption and the existing seat, the
  legacy loader retired.
- **W8.5 Proof.** A second project hired from the catalog end to end by a
  person who did not build it, with the setup list cleared one item at a
  time and the first routine activated from the role page.

## As built (2026-09-18), in files the W7 wave does not touch

- **Manifest v2** in `packages/cli/src/orgTemplateArtifact.ts` (`validateTemplate`,
  `manifestFiles`, `inputTokens`): every H2 field with exact shapes and cross
  reference checks; v1 manifests validate unchanged and refuse every v2 field.
  `{{input.<key>}}` is accepted only for declared inputs, in manifest strings
  and in the charter, prompt and setup files. Evidence ids and scoreboard keys
  allow underscores; every other id is a slug.
- **Hire answers**: `install --input key=value` (repeatable). `parseInputs`
  refuses unknown keys, secrets, bad numbers, booleans and choices, fills
  defaults and requires every required input that is not a secret. Answers live
  on the receipt as `config` and substitute in the handle, name, charter, routine
  titles and instructions.
- **The host step**: `bind <instance> [--secret key=path]`, after reconcile.
  `orgTemplateInstance.ts` writes the instance file: JSON by default, and a
  `.toml` path is merged line by line so other tables and trailing comments
  survive (checked on Codecast's real growth.toml: zero changed lines). A secret
  is recorded as `{ host, path_hash, bound_at }`; the file must not be readable
  by other users; the path goes only into the local instance file. Ledgers are
  found by the marker label `org-template:<key>:ledger:<id>` or created with that
  marker as the idempotent `client_key`, labelled `ledger`, until `type: ledger`
  exists.
- **The instance record**: `evidence`, `report` and `setup` verbs over
  `orgTemplateState.ts`. A pass and a scoreboard value need a source a person
  can open; an agent session cannot mark a person's setup item; a role's own
  item needs evidence. State lives on the receipt until the instances table
  exists; the verbs and their rules stay as they are when it does.
- **Readiness**: `packages/shared/contracts/orgTemplateReadiness.ts`, one pure
  module for the CLI, the server and the web. Any unmet requirement, never met
  or lapsed, lowers an apply routine to propose; spend or publish authority at
  understand trust also lowers it, without blocking activation. `status` returns
  the setup rows, the one open ask and readiness per routine; `instructions`
  for a routine opens with its mode now and what is not met.
- **The template**: `~/src/platform/packs/growth` on manifest v2 as 2.0.0
  (draft): 23 inputs, authority `ads-spend`, `social-publish`, `site-write`,
  nine setup guides, twelve evidence checks, five ledgers, nine scoreboard
  keys. Routine prompts carry only what is specific to each; the run rules live
  once in `org/STATE.md`. A dry run of hiring it on Codecast's real project with
  its real answers and `--adopt` for tr-460 to tr-464 passed against the live
  server and read the ads trigger's live 3 day cadence as an override.
- **The server half that changes no existing behaviour** (2026-09-19, with the
  org program's go): `convex/orgTemplates.ts` with the three tables appended to
  the org block of `schema.ts` and twelve `/cli/org/template/*` routes. Publish
  and catalog, the instance row upserted by the receipt's key, evidence,
  scoreboard and setup through the shared rules, instance status with readiness,
  lessons filed under the publisher's key with the writer seeing only status.
  The manifest validator and the record rules moved to
  `packages/shared/contracts/orgTemplateManifest.ts` and `orgTemplateState.ts`;
  the CLI files re-export them. `bind` registers the row; the record verbs post
  to it once it exists; new verbs `lesson`, `publish` and `catalog`.
- **The half that changes existing behaviour** (2026-09-21, the org program's
  wave having left the files):
  - `authority`, `hire` and `upgrade` change kinds in
    `shared/contracts/orgProposal.ts` with their validator, apply rank
    (authority after trust; hire after routine; upgrade before retire), keys,
    dependency notes, chip and sentence words; the web's kind records and the
    undo inverse map carry them; `orgInit.applyOrgChange` applies them.
    A hire writes the instance row `awaiting_host` under a placeholder key and
    makes the role the project's lead when it has none; the host's bind takes
    the row over by the instance's name and gives it the receipt's key. An
    accepted upgrade waits on the row as `pending_upgrade` for `bind --to`.
    Routines are not separate changes of a hire: bind creates them paused with
    the loader prompt, which a proposal routine could not carry.
  - `org_roles.authority` with `orgRoles.performSetAuthority` (human only,
    `refuseUnlessHuman`; replaces the list; revoke by id; expiry from the
    grant's cadence; a note on the charter doc; a change log row; an
    immediate wake naming what the role may now do). The wake frame's `You`
    section carries "Authority outside codecast: …"; `cast role show` prints
    it; `cast role authority <handle> --grant <json> | --revoke <id>` writes
    it. Readiness reads the role's authority on the server and in the CLI.
  - `agentTasks.insertTask` accepts `status: "paused"` (no `run_at`, never for
    an event trigger) and `applyActivate` sets the first run one interval out
    and clears an install's `exit 1` gate, keeping a person's own precheck.
    `orgTemplates.activateRoutine` is the human only mutation; the CLI's
    `activate` verb calls it and is refused for an agent session with the
    reason. `ensureRoutines` creates routines paused and pauses at once on a
    backend that ignores the status; the activation guidance drops the gate
    flag when there is no gate.
  - `performEscalateSession` accepts a role's own standing session, so the
    open setup item can reach the person's inbox with the role's line.
- **The web** (2026-09-21): `hooks/useTemplateHire.ts` holds the reads and
  writes (catalog, the instance for a role, propose, mark setup, activate) so
  the dialog and the page share them and a mount test stands in for the server
  with one mock. `orgTemplateSpec.ts` is the pure builder: a draft (template,
  project, answers, reports to, seat) becomes one proposal spec, one ask, every
  change valid by the contract; secrets never enter it; a grant that waits on a
  secret is still asked for, one that waits on an unanswered input is not. The
  hire dialog's "From a template" tab is the catalog, the project, the lead
  rule (hire under the lead, or name it as the seat), the answers by kind,
  the secrets listed as bound on the host, the instance name and update
  policy, a preview of what the person will decide, and the post; the folder
  path for authors stays behind a fold. `TemplateSections.tsx` is the role
  page's right column under the project card: the host step line while the
  row awaits its host, setup with the one open ask first and Done on a
  person's item, what it may do (trust, authority), routines with what each
  still needs and Activate on a ready paused one, the scoreboard, and the
  release with its bindings and update line. `RoleScopeView` gained the
  `template` slot and `ScopePanel` fills it. The instance row records the
  routines' trigger ids at bind so the page can show and activate them.
- **Tests**: `convex/orgTemplates.test.ts` (including the hire and upgrade
  applies), `convex/orgRoles.authority.test.ts`, `convex/agentTasks.paused.test.ts`,
  `convex/sessionOwnership.escalate.test.ts`, `web/components/org/orgTemplateSpec.test.ts`,
  `orgTemplateHire.mount.test.tsx`, `TemplateSections.mount.test.tsx`, `orgTemplate.test.ts`, `orgTemplateArtifact.v2.test.ts`,
  `orgTemplateInstance.test.ts`, `orgTemplateState.test.ts`,
  `orgTemplateActivation.test.ts`, and `orgTemplateReadiness.test.ts` in shared.

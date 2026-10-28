# Team kit

A team's shared agent setup: skills, slash commands, subagents and instruction
fragments that one member publishes and every member's machines can install.
Codecast holds the source of truth (decision sd-1921). Tracked under plan
pl-313, label `team-kit`.

## Identity

A published item is a capability with source `authored`. Its slug is built by
`formatCapabilitySlug` and nothing else:

    authored/<owner_id>/<kind>/<name>

`owner_id` is the team id for a team kit and the user id for a personal kit.
A kit lives in a workspace: a team (`team:<id>`) or one person (`user:<id>`).
A person with no team publishes to their personal kit, and turning an item on
at user scope is how it reaches all of their own machines.

`kind` is one of `skill`, `command`, `subagent`, `instructions`. `name` is the
skill directory name, the command or subagent file stem, or a slug of the
instruction section's heading. The slug is the key bindings, consents and the
installer use; the item row carries it.

## Data (Convex)

`team_kit_items`: one row per slug.
`slug`, `team_id` (routing, absent for a personal kit), `workspace` (access,
`team:<id>` or `user:<id>`, from computeWorkspaceKey), `kind`, `name`, `description`, `author_user_id`,
`current_version` (number), `current_hash`, `surfaces` (the current
version's, copied up for listings), `removed_at` (taken out of the kit; the row
stays so the web's delta feed carries the removal), `created_at`, `updated_at`.

`team_kit_versions`: immutable, one row per (item, hash).
`item_id`, `workspace`, `version` (1, 2, ...), `folder_hash`, `storage_id`
(a tar.gz of the item's directory or file, in Convex file storage), `files`
(`{path, size, executable}[]`), `main_body` (sanitized text of SKILL.md, the
command or subagent file, or the instruction section; capped), `surfaces`
(execution surfaces derived server side: `prose`, `ships_scripts`, ...), `note`,
`author_user_id`, `source_device_id`, `created_at`.

`team_kit_applied`: one row per (user, device, slug), what a machine's
reconciler did with a kit slug: `hash`, `status` (`installed`,
`pending_consent`, `conflict`, `error`, or `removed` once the device stops
reporting the slug), `detail`, `updated_at`.

Reads go through the viewer's workspace key, never `team_id`. Publishing the
same hash again returns the existing version (and makes it current again if it
was not). Removing an item (its author, or an admin of its team) marks it
removed and switches off every binding that names it, so machines uninstall it.

## Turning items on

Bindings, as for every other capability:
- for me, on all my machines: scope `user`, any member.
- for the whole team: scope `team`, team admins only, and only for that
  team's own items (a personal item has no team scope).
- off is a row with `enabled: false`, never a delete.

The daemon reads own rows and team rows through one reader
(`listBindingsForToken` and `webListBindings` share it).

## Publishing

From a machine: `cast cap publish <name>` archives the item, computes
`folder_hash` (sorted relative paths, executable bit, sha256 of raw bytes),
asks `/cli/cap/kit/upload-url` for an upload URL, uploads the archive, then
calls `/cli/cap/kit/publish` with the metadata. Instruction fragments publish
with `--instructions <file>#<heading>`.

From the web: "Share with team" on an item a machine reports inserts a
`daemon_commands` row `cap_publish` targeted at a device that has it
(`args`: `{ kind, name, team_id, note? }`). That daemon runs the same publish.
The web shows the item as publishing until the version row arrives.

## Installing

On each heartbeat the reconciler resolves bindings; for every enabled
`authored/` slug it fetches the current version (`/cli/cap/kit/version` returns
metadata and a download URL), verifies `folder_hash`, keeps it in
`~/.codecast/capabilities/store/<hash>/`, and plans writes through
`driver.ts`:
- skill: `~/.agents/skills/<name>/` via `materializeSkill`, client symlinks.
- command: `~/.claude/commands/<name>.md`.
- subagent: `~/.claude/agents/<name>.md`.
- instructions: one owned markdown section per item in each agent
  instruction file (`getSnippetTargets`), through the `markdown_section` arm.

A version whose surfaces are only `prose` installs without asking. Anything
else waits for a consent row for that device and hash, and reports as
`pending_consent`. Each pass the reconciler posts its full per-device set to
`/cli/cap/kit/applied` (`{ device_id, items: [{ slug, hash, status, detail? }] }`);
the web reads pending ones through `teamKit.webPendingConsents` and allows one
with `teamKit.grantConsent({ device_id, slug, hash })`. The consent hash is the
version's `folder_hash`; the daemon reads its device's consents from
`/cli/cap/consents` (`{ device_id }`). Publishing a new current version bumps
every workspace member's `capability_revision`, so machines re-plan onto it. A name collision with a file the driver did not write is a conflict,
never an overwrite. The machine reports it as `conflict` with the path in
`detail`; the web lists them with `teamKit.webKitConflicts` and resolves one
with `teamKit.adoptKitItem({ device_id, slug, hash })`, which records an
adoption (a `capability_consents` row with `purpose: "adopt"`, never read as
consent) and bumps the revision. The daemon reads them from
`/cli/cap/kit/adoptions` (`{ device_id }` -> `[{ slug, hash, adopted_at }]`)
and adopts only when `hash` is the version it is installing, moving the
person's copy aside and reporting `installed` with where it went.

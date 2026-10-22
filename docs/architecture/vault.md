# Vault: the team's passwords, keys and sign-ins, for people and agents

Status: building (plan in codecast, see `cast plan ls -q vault`).

## Naming

The product is **Vault**: the web page at `/vault`, the CLI `cast vault`, one
item in it a **secret**. Code uses the `secrets` namespace (`secrets` table,
`convex/secrets.ts`, `cli/src/secrets/`), because the Files surface keeps its
older internal `vault_*` names (`vault_notes`, `lib/vault`, the daemon's vault
routes). The Files CLI moves to `cast files`; `cast vault` with a Files verb
(`open`, `search`, `mirror`, a directory path) names the new command instead of
failing silently. `/vault?f=…` and `/vault?graph…` deep links, already written
into notes and transcripts, still land on Files; the bare `/vault` is the Vault.

## Principles

Infisical (project secrets injected at run time, versions, access requests,
audit) and 1Password (items with fields, `op://` references, Watchtower,
sign in once and autofill) both start from a person handling a secret. Vault
starts from who actually consumes a credential here: an agent, inside a
transcript, sent to a model provider. That changes what "best" means.

1. **A value should never enter a model's context.** Whatever a command
   prints, the model reads and the transcript records. So the default way to
   use a secret is to have it substituted where it is needed, never printed:
   `cast vault run` puts values into a child process's env; references
   (`vault://name` in a `.env` or `[vault]` in workspace.toml) let a repo
   name its secrets without holding them; saved sign-ins load into the
   browser without passing through the agent. `get` exists for pipes and
   `$(…)`, and a bare `get` into the agent's own output is the one thing the
   guidance forbids. Redaction is the second line of defence, not the first.
2. **Ask through the right channel, at the moment of need.** Agents find out
   they need a credential halfway through a task. The request card puts a
   masked field in front of the person in the conversation and the inbox,
   then wakes the agent. A secret pasted into the composer is caught on send
   and offered as "Save to Vault" instead, so the habit people already have
   becomes the right one.
3. **Use is shared, risk is gated.** Every agent in the team can use a team
   secret without ceremony; that is the job. A secret marked **Ask first**
   (production database, live payment keys) needs a person's approval per
   session before any agent reads it: the read becomes a decision card
   ("jx7… wants live-stripe for: refund order 123", Approve for this session
   / Deny), and the approval is the audit record. No per-agent ACL matrix.
4. **Every read is attributable.** Each read names the session, so "which
   agent used the prod key last Tuesday" is one click, and an agent's use of
   a secret shows up in its transcript as a card with the name, never the
   value.
5. **Nothing silently rots.** Rotation keeps the previous value for 7 days
   with one-click restore (a rotation that breaks prod is undone in seconds).
   The list carries health in structure, the way Watchtower does: never
   used, unused for 90 days, sign-in expiring or expired, Ask first. No
   score, no prose.
6. **Fewer concepts than either inspiration.** No vault-within-vault, no
   environments, no folders: a team has one Vault, personal secrets are a
   scope, names carry environment (`stripe-test`, `stripe-live`), and a
   repo's `[vault]` map says which names it uses. Every concept added has to
   remove more friction than it costs to learn.

## The job

A team's agents keep hitting the same wall: the work needs a credential (a
Stripe test key, the staging admin password, a signed-in Vercel dashboard)
and the agent has none. Today a person pastes the value into chat, where it
lands in a synced transcript, or exports it in one terminal, where no other
agent on any other machine can see it. Vault fixes that with one place the
whole team fills once and every agent reads from, on any machine, without a
value ever entering a transcript.

Four jobs, in the order people meet them:

1. **An agent needs a credential it does not have.** It asks with
   `cast vault request`. The person gets a card with a masked field, right
   in the conversation and in the inbox. They paste the value there, never in
   chat; the session wakes and continues.
2. **A person shares a credential with the team.** Web: Vault page, Add.
   CLI: `cast vault add`. One name, the value, optionally the env var it
   belongs in and the sites it is for.
3. **An agent uses a credential.** `cast vault run -- <cmd>` injects keys as
   env vars for one process; `cast vault get` prints one value for a pipe;
   `cast vault otp` prints the current 2FA code; `cast browser open` signs
   in by itself where the team saved a sign-in.
4. **A person signs in to a site once, for every agent.** "Save sign-in" takes
   the cookies of a site the person is already signed in to (their own Chrome,
   or the agent browser they just signed in through) and stores them as a
   team sign-in. Any agent's browser on any machine, cloud hosts included,
   starts signed in. Each use writes the refreshed cookies back, so the
   sign-in stays alive; when it does expire, a stored password and 2FA seed
   let the agent sign in again, and only when that fails does a person get a
   "Sign in again" card.

## What a secret is

One row per secret in `secrets`:

| field | meaning |
|---|---|
| `name` | slug, unique per workspace (`stripe-test`, `github-bot`). What agents type. |
| `kind` | `key` (one value), `login` (username, password, optional TOTP seed), `signin` (saved browser session for one site), `file` (multi-line: a .env, a service-account JSON, an SSH key) |
| `env` | env var names the value maps to (`STRIPE_SECRET_KEY`); a login maps `username`/`password` to two |
| `sites` | hostnames it is for; `signin` and `login` use them to match a browser navigation |
| `note` | what it is for, plain text, not secret |
| `workspace` | ACCESS: `team:<id>` or `user:<id>` via `computeWorkspaceKey`; personal is a real value |
| `value_enc` | AES-GCM ciphertext of the JSON payload; never returned by a query |
| `status` | `ready` or `requested` (a request with no value yet) |
| `fingerprint` | first 4 and last 4 of a key, so a person can tell which one is stored without revealing it |
| bookkeeping | `created_by`, `updated_by`, `updated_at`, `rotated_at`, `last_used_at`, `last_used_by_session`, `use_count`, `short_id` (`sec-N`) |

`secret_events` is the audit trail: created, updated, revealed (web), read by
an agent (with the session), injected, signed-in, refreshed, requested,
fulfilled, deleted. The detail panel shows it; nothing else reads it.

## Encryption and where values travel

- At rest: `encryptRefreshToken` (googleOAuth.ts) under the deployment's
  `CONNECTION_SECRETS_KEY`, HKDF info `codecast-secret-v1:<workspace>`. The
  workspace in the info binds a ciphertext to its workspace: a row copied or
  re-keyed into another workspace fails to decrypt rather than leaking.
- Queries return metadata only. Values leave the backend through two actions,
  each writing an event first: `reveal` (a signed-in person, for one secret)
  and `cliRead` (an api token, for one or more secrets, naming the session).
- Values never sync into the web store, IndexedDB, or a transcript. The web
  reveals into component state for the copy or the eye toggle and drops it.
- The daemon pulls the values of the secrets its user can read (version
  gated, memory only) into known-value redaction, so a value echoed by a
  command or pasted by a person is `[redacted:known:<NAME>]` before any
  transcript syncs.

## Access

A team secret is readable and usable by every member of the team and by their
agents; that is the point. Writes are open to members; delete and changing a
team secret's scope go through the consequential confirm. A personal secret is
its owner's alone. Reads go through the workspace chokepoint like every work
item; no path reads `team_id` for access.

## Surfaces

- **Web: Vault page** (`/vault`) (sidebar and palette). A list, one row per secret:
  kind glyph, name, env var or site, scope, who used it last and when. Open
  requests pin to the top with their masked field inline. A row opens a
  detail panel: fields masked with reveal and copy, a live TOTP code with its
  countdown, sign-in health, recent use by session (each a link), activity,
  rotate, delete.
- **Transcript cards.** `cast vault request` renders as a fillable card;
  `get`/`run`/`otp` render as a compact "used stripe-test" card that never
  shows a value.
- **CLI.** `cast vault` (list), `add`, `get`, `run`, `env`, `otp`, `request`,
  `rm`, `show`, `save-signin`. JSON with `--json`.
- **Browser.** `cast browser open` injects a matching saved sign-in into the
  agent's browser before navigating; `cast vault save-signin <site>` (and the
  web's Save sign-in) captures one.
- **Agent guidance.** A `## Vault` snippet: ask, never accept a pasted value
  in chat, prefer `run` over `get`, never write a value to a file the repo
  tracks.

## Saved sign-ins

A `signin` secret holds, for one site, the cookies of its host keys
(`cookieHostKeys`) and the origin's localStorage, as JSON. Three ways in:

- **From my Chrome.** The web's Save sign-in asks a chosen laptop's daemon
  (a `vault_capture_signin` daemon command, like `cloud_browser_sync`) to read
  that site's cookies out of the person's own Chrome (`localCookiesForHost`),
  then store them. One click for any site the person is already signed in to.
- **From the agent browser.** `cast vault save-signin <site>` reads the managed
  browser's cookies (`Storage.getCookies`) and the origin's localStorage after
  a person signed in through the live tab.
- **Fill a request.** An agent that hits a sign-in wall runs
  `cast vault request <site> --signin`; the card offers both of the above.

Out: `cast browser open <url>` matches the URL's host against `signin` secrets
the session can read, and when the managed browser lacks that site's cookies
it injects the saved ones (`Storage.setCookies`, localStorage before first
paint) and logs a `signed-in` event. Google and YouTube stay excluded, as in
`keepsOwnLogin`. Site policy (`policy.ts`) still applies.

Staying alive: after an agent used a sign-in, the browser's newer cookies for
those host keys are written back (`refreshed`), so a session a site rotates
stays current. The row records the latest cookie expiry; the page shows it,
and an expired sign-in with a matching `login` secret is re-established by the
agent with `get` and `otp`. Only when nothing works does a person get the
"Sign in again" request.

## Projects

`.codecast/workspace.toml` may map env vars to secrets:

```toml
[vault]
STRIPE_SECRET_KEY = "stripe-test"
DATABASE_URL = "staging-db"
```

`cast vault run -- <cmd>` with no names injects that set, and `cast dev`
starts a project's servers with it, so a repo needs no `.env` on disk.

## Second round (after the first four waves)

- **Ask first** flag on a secret; agent reads go through an approval decision
  per session (`cast decide` machinery), approvals and denials logged.
- **Versions**: rotate keeps the previous ciphertext for 7 days; Restore in
  the detail panel and `cast vault restore <name>`.
- **References**: `vault://<name>` (and `vault://<name>/<field>`) as a value
  in any `.env` file that `cast vault run --env-file` or `cast dev` loads.
- **Composer catch**: on send (never per keystroke, see the typing budget),
  a message containing a credential-shaped string (secretPatterns.ts) offers
  "Save to Vault" in place of sending the value; the message goes out with
  the secret's name instead.
- **Health** states in the list and detail (never used, stale 90 days,
  sign-in expiring or expired, Ask first).

## Not in this build

- End-to-end encryption (decision sd-1084 asks; server-side ships first).
- Org template `secret` inputs bound to Vault secrets instead of sealed files.
- Mod secrets as references to Vault secrets.

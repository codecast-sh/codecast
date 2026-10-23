# Vault: the team's passwords, keys and sign-ins, for people and agents

Status: built in two rounds (plan pl-941). The first round shipped the
Vault page, the CLI, requests, redaction, saved sign-ins and the `[vault]`
project map; the second added Ask first, previous values, `vault://`
references, the composer catch and health. "Open edges" at the end lists what
is known to be missing.

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
| `ask_first` | an agent's read needs a person's approval, once per session (see Ask first) |
| `has_otp`, `version_count` | stored when the value is written, so metadata never decrypts: whether a login holds a 2FA seed, and how many previous values `secret_versions` keeps |
| bookkeeping | `created_by`, `updated_by`, `updated_at`, `rotated_at`, `last_used_at`, `last_used_by_session`, `use_count`, `short_id` (`sec-N`) |

`secret_events` is the audit trail (`SECRET_EVENT_KINDS` in
`shared/contracts/secrets.ts`): created, updated, rotated, revealed (web),
read by an agent (with the session), injected, signed_in, refreshed,
requested, fulfilled, deleted, ask_first_on and ask_first_off,
approval_requested, approved and denied (each with its decision), restored,
and redaction_sync (one per workspace per daemon fetch, with a count and no
secret). Events carry the secret's short id, so `events` still answers after a
delete. The detail panel and `cast vault show` read it.

Two more tables hang off a secret, and a delete removes both:

- `secret_versions`: the ciphertext a rotate or a fill replaced, with its
  fingerprint, who replaced it and when, for 7 days (`SECRET_VERSION_TTL_MS`).
  A cron purges expired rows every 6 hours. A sign-in refresh keeps none.
- `secret_approvals`: one row per secret and conversation, `pending`,
  `approved` or `denied`, with the decision that settles it.

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
  kind glyph, name (a cyan shield when Ask first is on), env var or site,
  scope, and a right column that shows the health state's dot and time when
  there is one, else who used it last and when. A "Needs attention N" filter
  in the header narrows to the rows with a health state. Open requests pin to
  the top with their masked field inline. A row opens a detail panel: fields
  masked with reveal and copy, a 2FA row only when the login holds a seed,
  sign-in health, the Ask first switch, previous values with Restore, recent
  use by session (each a link), activity (an approval event carries a pill
  for its decision), rotate, delete.
- **Mobile.** Settings, then Vault: the list with open requests on top, each
  fillable in place. A vault-ready message renders as a compact system line,
  as on web.
- **Transcript cards.** `cast vault request` renders as a fillable card;
  `get`/`run`/`otp` render as a compact "used stripe-test" card that never
  shows a value.
- **CLI.** `cast vault` (list), `add`, `rotate`, `fill`, `get`, `run`, `env`,
  `otp`, `request`, `rm`, `show`, `save-signin`, `restore`, `ask-first`. JSON
  with `--json` on every verb. `ls` and `show` print the health state, `+2fa`,
  `ask-first` and how many earlier values are kept.
- **Browser.** `cast browser open` injects a matching saved sign-in into the
  agent's browser before navigating; `cast vault save-signin <site>` (and the
  web's Save sign-in) captures one.
- **Agent guidance.** The `vault` snippet (`VAULT_SNIPPET` in
  `shared/contracts/snippets.ts`), a `## Vault` section in the agent's
  instruction file: never ask for a pasted value, hand values to the command
  (`run`, `vault://` in an `--env-file`, `$(cast vault get …)` inside the
  command) rather than reading them, never write one to a tracked file, and
  end the turn dormant on a request or an Ask first decision. `cast guide
  vault` serves the flags and rare paths. The user guide is
  `packages/web/app/(marketing)/documentation/guides/content/vault.md`.

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
  `cast vault request <name> --kind signin --site <host>`; the card offers both of the above.

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

### References

An env file may hold `vault://<name>` or `vault://<name>/<field>` as a value
(`cli/src/secrets/envFile.ts`, parsed with `parseDotenv`). Without a field a
reference is a key's value, a login's password or a file secret's 0600 temp
path; the fields are value, username, password and content. `cast vault run
--env-file <path>` (repeatable, a later line or file wins a var) checks every
reference against one `/cli/vault/list` call first, so each unresolved one
(absent, still a request, a sign-in, a field the kind lacks) stops the run
with its fix, then reads them all in the command's single `/cli/vault/read`
together with any names given and the `[vault]` map. Literal values pass
through. A file of references holds no value, so it is safe to commit.

## Ask first

A person marks a secret Ask first (the detail panel's switch, or `cast vault
ask-first <name> on`). Turning it off removes a guard, so the web runs it
through the consequential confirm and the CLI asks on a terminal or needs
`--yes`.

An agent's read (`secrets.cliRead`, so `get`, `run`, `env`, `otp`, `cast dev`
and the browser's sign-in alike) that includes an Ask first secret this
conversation has no approval for returns no values. It files a decision
through `askCore` on the asking conversation, "<session> wants <name> to
<why>" with Approve for this session / Deny, category `access` (a keyword may
pin another category a person must answer), and returns
`SecretNeedsApproval`: the decision ids and the dormant line. The CLI prints
both on stderr and exits 3 (`NEEDS_APPROVAL_EXIT`, `cli/src/secrets/
approval.ts`); `run` never starts the command. `--why` words the question. A
repeat read while the decision is open reuses it. A read with no session, or
naming a conversation the caller does not own, is refused, so a token cannot
borrow another session's approval.

`sessionDecisions.settleResolution` calls `settleSecretApproval`
(`convex/lib/secretApprovals.ts`). A person's Approve marks the row approved
for the rest of that conversation; Deny or dismiss marks it denied and the
next read asks again. An Approve from a role or a policy grants nothing. The
web's `reveal` is a person and is not gated.

## Previous values

Rotate, and a fill over a stored value, moves the old ciphertext into
`secret_versions` for 7 days. `secrets.versions` lists them as metadata
(when, by whom, fingerprint, when it goes); `secrets.restore` swaps a chosen
one back, so the value it replaces becomes a version and a wrong restore is
undone the same way. Web: "Previous values" in the detail panel, shown when
`version_count > 0`, Restore through the confirm. CLI: `cast vault restore
<name>` lists them, `cast vault restore <name> <n> --yes` restores (a
positional, because the root program owns `--version`).

## Composer catch

On send, never per keystroke (the typing budget), `MessageInput.handleSubmit`
checks the text with `findSecrets` (`shared/contracts/secretShapes.ts`, the
same shapes transcript redaction builds its patterns from). A match holds the
send and shows `components/secrets/ComposerCatch.tsx` above the composer: what
it found with its first and last 4 characters, a suggested name, the scope
(Only me by default, or the conversation's team), and Cancel, Send as is, Save
to Vault and send. Save goes through the Vault page's create path; the message
goes out with the value replaced by a reference to the secret's name
(`withVaultReferences`).

## Health

`secretHealth` (`shared/contracts/secrets.ts`) works the state out at render
from metadata: expired, expiring (a sign-in within 3 days), unused (no read a
day after it was added) and stale (last read over 90 days ago). The web list,
the detail header, the Needs attention filter and `cast vault ls|show` all
use it.

## Open edges

- Any API token holder, an agent included, can call `setAskFirst` to turn Ask
  first off and then read. The CLI only demands `--yes`; turning it off
  should need a person.
- Redaction covers current values only, not the versions kept for 7 days.
- `cast dev` resolves only the `[vault]` map. A dev server that reads `.env`
  itself sees a `vault://` reference as a literal string.
- Logins saved before `has_otp` existed report it unset until their next
  rotate; there is no backfill, since it would mean decrypting every login.
- A sign-in saved fresh by `save-signin` gets no stale-write check on its
  first write-back, because `secrets.create` returns no `updated_at`.

## Not in this build

- End-to-end encryption (decision sd-1084 asks; server-side ships first).
- Org template `secret` inputs bound to Vault secrets instead of sealed files.
- Mod secrets as references to Vault secrets.

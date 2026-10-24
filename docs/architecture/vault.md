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
| `name` | slug, unique per workspace (`stripe-test`, `github-bot`). What agents type. Never id-shaped (`sec-5`, 32 letters and digits), since a lookup reads those as ids. |
| `kind` | `key` (one value), `login` (username, password, optional TOTP seed), `signin` (saved browser session for one site), `file` (multi-line: a .env, a service-account JSON, an SSH key) |
| `env` | env var names the value maps to (`STRIPE_SECRET_KEY`); a login maps `username`/`password` to two. Never a variable that makes a shell, loader, interpreter or build tool load code, trust a certificate or route its traffic (`PATH`, `LD_*`, `DYLD_*`, `BASH_ENV`, `NODE_OPTIONS`, `PYTHON*`, `GIT_SSH_COMMAND`, `CC`, `TMPDIR`, `XDG_*`, any `*_PROXY`, `*_CA_*`, `*_BUNDLE`, `*WRAPPER`, `*FLAGS`, `*OPTS`, `*OPTIONS`, `*CONFIG`, `*HOME` or `*DIRS` word, `CARGO_*` but a token, and the rest in `envNameProblem`), named or derived from the name: a team secret fills its teammates' process env. The rule is a blocklist of known names and families, so a tool variable outside them still passes until it is added |
| `sites` | hostnames it is for; `signin` and `login` use them to match a browser navigation |
| `sites_by_token` | a sign-in whose sites or cookies an api token set with no person vouching: whose token (see Saved sign-ins) |
| `note` | what it is for, plain text, not secret |
| `workspace` | ACCESS: `team:<id>` or `user:<id>` via `computeWorkspaceKey`; personal is a real value |
| `value_id` | the current value's `secret_values` row (below); never returned by a query |
| `status` | `ready` or `requested` (a request with no value yet) |
| `fingerprint` | first 4 and last 4 of a key, so a person can tell which one is stored without revealing it |
| `ask_first` | an agent's read needs a person's approval, once per session (see Ask first) |
| `has_otp`, `version_count` | stored when the value is written, so metadata never decrypts: whether a login holds a 2FA seed, and how many previous values `secret_versions` keeps |
| `value_updated_at` | when the value last changed (create, rotate, fill, refresh, restore): the version a sign-in's write-back names, always past the one it replaces, so two writes in one millisecond still differ. `updated_at` also moves on a metadata edit and is for display |
| bookkeeping | `created_by`, `updated_by`, `updated_at`, `rotated_at`, `last_used_at`, `last_used_by_session`, `use_count`, `short_id` (`sec-N`); a request's first asker in `requested_by` and `requested_from_conversation`, every later asking session in `also_requested_from` |

`secret_events` is the audit trail (`SECRET_EVENT_KINDS` in
`shared/contracts/secrets.ts`): created, updated, rotated, revealed (web),
read by an agent (with the session), injected, signed_in, refreshed,
requested, fulfilled, deleted, ask_first_on and ask_first_off,
approval_requested, approved, denied and withdrawn (each with its decision;
withdrawn is the asking session taking its question back), restored,
and redaction_sync (a value's first copy to a user through the redaction
feed, once per secret, user and value; a refetch of a value already sent
records nothing, so the activity window keeps the approvals and reads). Events carry the secret's short id, so `events` still answers after a
delete. The detail panel and `cast vault show` read it.

Three more tables hang off a secret, and a delete removes all three:

- `secret_values`: every ciphertext the secret holds, current or kept (AES-GCM
  of the JSON payload), one row each. The secret row and its versions point at
  it by id, so the list, `show` and `versions` never load a value: a value
  runs to 512 KB, and 30 of them inline would pass Convex's 16 MiB read cap
  for one function. Only the value paths read it, by id, a few per query.
  Rows written before the split carry an inline `value_enc` until
  `secrets:moveValuesOut` moves it.
- `secret_versions`: the value a rotate, a fill or a restore replaced, with
  its fingerprint, who replaced it and when, for 7 days
  (`SECRET_VERSION_TTL_MS`). A cron purges expired rows every 6 hours, with
  their values. A sign-in refresh keeps none.
- `secret_approvals`: one row per secret and conversation, `pending`,
  `approved` or `denied`, with the decision that settles it.

## Encryption and where values travel

- At rest: `encryptRefreshToken` (googleOAuth.ts) under the deployment's
  `CONNECTION_SECRETS_KEY`, HKDF info `codecast-secret-v1:<workspace>`. The
  workspace in the info binds a ciphertext to its workspace: a row copied or
  re-keyed into another workspace fails to decrypt rather than leaking.
- Queries return metadata only. Values leave the backend through three
  actions, each writing an event first: `reveal` (a signed-in person, for one
  secret; Touch ID for an Ask first one), `cliRead` (an api token, for one or more secrets, naming the
  session) and `redactionValues` (an api token, the daemon's redaction feed:
  a `redaction_sync` the first time each value reaches each user, not a use).
- Values never sync into the web store, IndexedDB, or a transcript. The web
  reveals into component state for the copy or the eye toggle and drops it.
- The daemon pulls the values of the secrets its user can read (version
  gated, memory only) into known-value redaction, so a value echoed by a
  command or pasted by a person is `[redacted:known:<NAME>]` before any
  transcript syncs. Each value is matched as written, JSON-escaped, base64 and
  base64url encoded at every byte offset (a Basic auth header carries
  `user:pass`), and percent-encoded (a URL's userinfo). The same matcher reads
  every file a wip snapshot push would upload, and holds the push back while
  one holds a known value. A file goes in whole and in the pieces a command
  prints of it: each dotenv or INI value, each YAML value that is one token
  or sits under a credential name (`token: …`), each .netrc password, each
  JSON string, each one-token line. A multi-line key goes in those pieces
  too. A key, a file or a piece longer than `SECRET_REDACTION_MAX` (8192)
  goes in as consecutive 64-character chunks, so printed whole it is redacted
  chunk by chunk. A key needs at least `SECRET_REDACTION_MIN` (6) characters,
  the matcher's floor for a Vault value; `validatePayload` refuses a shorter
  one. A sign-in
  goes in as its session cookies and its localStorage tokens (each long value,
  and each long string inside one that is JSON), since a single-page app keeps
  its session there. The values
  a rotate kept go in too while they are restorable, since a key rotated away
  after a leak still sits in logs and files; their expiry moves the version.
  An Ask first value goes in once it has reached the user (an approval for
  one of their sessions, a read, a reveal, a copy already in their daemon)
  and stays until a new value, kept values included: a lapsed approval, an
  ended session or a switch to Ask first after a leak leaves the value in
  their agents' output, which must stay redacted. A user it never reached is
  not sent it, since the daemon and its agents share one token. An approval,
  a first reveal and switching Ask first either way move the redaction
  version.

## Names across workspaces

A name may exist in a team and in personal at once. A name in more than one
of the caller's workspaces resolves by `pickSecretByName`
(`shared/contracts/secrets.ts`), the same rule on the backend and in the
CLI's planners: the repo profile's workspace when the CLI sends it as
`prefer` (reads, `[vault]`, `vault://`), a fill's requested row, else a
refusal that lists each row's short id. It is never silently the personal
one. A `[vault]` line or a `vault://` reference names a secret only by name,
so there the refusal asks for a rename instead, and it stops the command even
when the line is not `required`. `cast vault request` looks for the name in
every workspace the caller reads before asking: a ready secret anywhere is
named with its workspace and nothing is filed.

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
  the top with their masked field inline, and Decline beside it. A decline is
  `secrets.remove` with `only: "requested"`: pressed on a stale card, or
  replayed from the outbox after someone filled the request, it keeps the
  value and answers `removed: false`. A row opens a detail panel: fields
  masked with reveal and copy, a 2FA row only when the login holds a seed,
  sign-in health, the Ask first switch, previous values with Restore, recent
  use by session (each a link), activity (an approval event carries a pill
  for its decision), rotate, delete. Activity and previous values paint from
  the store (`secretHistory`, one row per list per secret opened, metadata
  only), fed by the panel's `events` and `versions` queries, so a secret
  opened before shows them at once. Where the page is too narrow for both,
  the panel covers the list under an "All secrets" back row. A fill, rotate
  or restore paints on the row the moment it is pressed (`stageSecret`; the
  value goes only to its action), with a pending Activity line where the time
  goes until the server writes it. The row's changed field (a fill's
  `status`, a swap's `fingerprint`) takes a field lock, so a list push that
  lands before the action answers cannot put the old one back; the server's
  matching row retires it, and a refusal re-stages the old row. Delete is an
  ordinary local-first action.
- **Mobile.** Settings, then Vault: the list with open requests on top, each
  fillable in place. A vault-ready message renders as a compact system line,
  as on web.
- **Transcript cards.** `cast vault request` renders as a fillable card,
  found by the short id the command printed in any of the viewer's
  workspaces; once that row is gone (declined anywhere, or deleted) the card
  rests as a line saying so, never as another secret with the same name;
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
  (`run`, `vault://` in an `--env-file`, or stdin as
  `< <(cast vault get …)`, never `$(…)` in an argument, which `ps` shows to
  every local user) rather than reading them, never write one to a tracked file, and
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
`keepsOwnLogin` (`OWN_LOGIN_HOSTS` in `shared/contracts/secrets.ts`, with
`signinSite`, the one parser of a typed site: the web's Save sign-in and the
CLI read the same list). Site policy (`policy.ts`) still applies.

The agent browser is shared by every session on the machine, so an Ask first
sign-in one session was approved for sits in a jar the others could read. The
machine's sign-in memory (`vault-signins.json`) records, for an Ask first row,
its sites and each session whose read the backend approved (`askFirstMemory`,
capped at `SECRET_APPROVAL_TTL_MS` from first sight), and `cast browser`
refuses `cookies`, `storage` and `state save` reads, `raw` included, that
would reach such a sign-in for any other session (`vaultJarRefusal` in
`browser/siteGuard.ts`). Page script (`eval`) still reads the non-httpOnly
part. In either browser `refuseNavigation` refuses the Vault page itself
(`/vault` on codecast.sh, local.codecast.sh, localhost:3200 and the configured
web_url), for every command that loads a URL (`urlsLoadedBy`: `open`, `read`,
`tab new`, `diff url`, `raw pushstate`), since its clicks pass for the
person's.

Staying alive: after an agent used a sign-in, the browser's newer cookies for
those host keys are written back (`refreshed`), so a session a site rotates
stays current. `refresh` takes only a ready `signin` row and only with the
`value_updated_at` the machine read (a write naming none is stale), since it
keeps no version; any other kind is refused toward `rotate`. A write-back
captures the browser's cookies for every site the row names, so the server
refuses any sign-in value (create, rotate, fill, refresh) holding a cookie or
a localStorage origin outside the row's `sites` (`signinScopeProblem`), and
only a person signed in to the app adds a site to a ready sign-in: a token
that could would turn a teammate's next write-back into a copy of another
site's cookies. The same holds where a token sets the sites or the cookies
first (create, a request, the request's fill, rotate): the row records the
token's user in `sites_by_token`, and only that user's browsers sign in with
it or write it back (`cliRead` for `signin` and `refresh` refuse everyone
else), since a planted jar for a site would otherwise collect the real session
of the next teammate who signs in there. A person setting its sites on the
Vault page clears it, and so does a Save sign-in from my Chrome the person
asked a laptop for (a pending `vault_capture_signin` command of theirs for the
site, `captureAskedFor`). The row records
when the sign-in runs out: the latest expiry of its httpOnly cookies, or of
all its cookies when it has none, leaving out the ones that never hold a
session (trackers, CSRF guards, bot and load-balancer stamps, consent) in
`signinExpiresAt`. The latest, because a short access cookie is reissued from
a long refresh cookie; leaving those out keeps a two-year analytics cookie
from hiding a dead one-day session. The page shows it,
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

`cast vault run -- <cmd>` (and `env`) with no names injects that set, and
`cast dev` starts a project's servers with it, so a repo needs no `.env` on
disk. Each reads only the mapped secrets that hold a value: a gap prints its
fix, and only a `required = true` line stops the command. Names given on the
command line replace the map's set rather than add to it.

### References

An env file may hold `vault://<name>` or `vault://<name>/<field>` as a value
(`cli/src/secrets/envFile.ts`, parsed with `parseDotenv`). Without a field a
reference is a key's value, a login's password or a file secret's 0600 temp
path; the fields are value, username, password and content. `cast vault run
--env-file <path>` (repeatable, a later line or file wins a var) checks every
reference against one `/cli/vault/list` call first, so each unresolved one
(absent, still a request, a sign-in, a field the kind lacks) stops the run
with its fix, then reads them all in the command's single `/cli/vault/read`
together with any names given (with none, the `[vault]` map's ready secrets). Literal values pass
through. A file of references holds no value, so it is safe to commit.

## Ask first

A person marks a secret Ask first (the detail panel's switch, or `cast vault
ask-first <name> on`). Turning it off removes a guard, so only a person
signed in to the app can (the web, through the consequential confirm):
`setAskFirst` refuses an off that comes with an api token, since the token is
what the gated agent holds. The same reasoning covers the value: a token
cannot rotate, restore or delete an Ask first secret, rename it or change its
env or sites (`askFirstRefusal` in `secrets.ts`), since a live key swapped for
one the agent chose sends the next run's payments or traffic to that key's
owner. A person does all of these on the Vault page. A sign-in's cookie
write-back (`refresh`) from a token lands only while one of the user's own
sessions holds an approval to read it. Declining an open request stays open
to anyone, since a request holds no value.

An agent's read (`secrets.cliRead`, so `get`, `run`, `env`, `otp`, `cast dev`
and the browser's sign-in alike) that includes an Ask first secret this
conversation has no approval for returns no values. It files a decision
through `askCore` on the asking conversation, "<asker> asks to use <name>"
(the asking session's title, else its short id)
with Approve for this session / Deny, category `access` (a keyword may pin
another category a person must answer), and returns `SecretNeedsApproval`: the
decision ids and the dormant line. The CLI prints both on stderr and exits 3
(`NEEDS_APPROVAL_EXIT`, `cli/src/secrets/approval.ts`); `run` never starts the
command. The why goes in the decision's context, its first line, since it is
the agent's own words: `--why` as given ("Why: ..."), else the read's purpose
("To sign in to vercel.com."), then what Approve grants and for how long. A
repeat read while the decision is open reuses it; a repeat with a new `--why`
rewrites that context in place. A read with no session, or
naming a conversation the caller does not own, is refused, so a token cannot
borrow another session's approval.

`sessionDecisions.settleResolution` calls `settleSecretApproval`
(`convex/lib/secretApprovals.ts`). A signed-in person's Approve marks the row
approved for the rest of that conversation; Deny or dismiss marks it denied
and the next read asks again. The asking session withdrawing its question
(`cast decide cancel`) drops the approval row and records `withdrawn`, since
no person denied anything. Only the web and phone answer one (the `resolve`
mutation and the dispatch rail stamp `signed_in` on the answer):
`answerRefusal` turns away `cast decide answer` in every form, `--for-human`
included, a role, a policy and a stack default, since an agent can run the
CLI from its own shell.

An approval holds while its conversation is active and for 12 hours at most
(`SECRET_APPROVAL_TTL_MS`); a read naming an ended session is refused, since
its id is visible to the user's other sessions. A new value (rotate, fill over
a value, restore) ends the approvals given for the old one. Switching Ask
first off or on ends them all and withdraws any decision still open, and
`remove` does the same, so the queue never keeps a decision that can do
nothing. Those withdrawals delete the approval rows first, so they record no
`withdrawn` event: the switch or the delete is the activity line. A request
and a read attach only a session the caller owns
(`isConversationOwner`): a teammate's shared session is never woken,
notified or blamed by them.

### Touch ID

Signed in is not enough for the presses that open a guarded secret, because
an agent can drive the person's own signed-in Chrome (`cast browser`) and the
server cannot tell its clicks from theirs. Revealing an Ask first secret,
approving an Ask first decision and switching Ask first off each take a
passkey assertion (Touch ID, Face ID or a security key), which a script cannot
produce; so do removing a passkey and adding a second one (decision sd-1359).
Deny and dismiss stay one press, and switching Ask first on needs nothing.

- `passkeys` (`convex/passkeysSchema.ts`): one WebAuthn credential per row,
  the person's own with no workspace: public key, signature counter,
  transports, the relying party it was made for, a name, added and last used.
  The relying party is the web host, which its subdomains share (codecast.sh
  for local.codecast.sh, localhost in dev; `rpIdFor` in `passkeys.ts`), and
  the accepted origins are `webOrigins()` (`lib/siteUrl.ts`, also Slack's
  return list). User verification is required, attestation is none, ES256 or
  RS256 (`@simplewebauthn/server`).
- `passkey_challenges`: one single-use WebAuthn challenge per row, either an
  enrollment or a presence check for one action on one target
  (`PRESENCE_ACTIONS` in `shared/contracts/secrets.ts`: `reveal` and
  `ask_first_off` name the secret, `approve` the decision, `remove_passkey`
  the passkey, `add_passkey` the person). `presenceBegin` files it for two
  minutes (`PRESENCE_TTL_MS`); `presenceFinish` verifies an assertion of one
  of that person's passkeys, refuses a signature count that did not rise (a
  copied key), and turns the row into a grant usable once in the next two
  minutes. A cron purges past rows hourly.
- The gates (`lib/presence.ts`): `secrets.reveal` of an Ask first secret
  (`recordReads`, before the reveal is recorded), `setAskFirst` off (so the
  web's dispatch side effect too), an Approve through `resolve` or the
  dispatch rail (`secretApprovalRefusal` checks, `settleSecretApproval` uses
  it up), `passkeys.remove`, and an enrollment when a passkey exists. Each
  takes the grant for exactly that action and target and refuses without one
  with `presenceRequiredMessage`, whose `presence_required` code the clients
  recognise (`isPresenceRequired`) to run the ceremony and retry.
- Finishing needs no codecast session: the challenge id is the capability and
  only that person's passkey verifies. That lets the desktop app (Electron has
  no platform passkeys) and the phone open the web origin's `/confirm?c=<id>`
  page in a browser and watch `passkeys.challenge` until it is granted, then
  press again. The web runs the ceremony inline.
- The first passkey needs no grant, since there is nothing to assert with.
  The web refuses to start it in an agent-driven tab (`agentTabGuard`), it
  shows in the person's passkey list, and they are emailed ("Touch ID was
  added", `emails/templates.ts passkeyAdded`), so one they did not add is an
  alarm they can act on by removing it.
- Web (`lib/passkeyPresence.ts`): a gated press confirms first (`usePresence`,
  single flight per action and target), then calls; a `presence_required`
  refusal, returned or thrown by the dispatch, confirms once more and calls
  again (`withPresence`). Gated controls carry a fingerprint: Reveal, Copy and
  Show of an Ask first value (`useReveal(id, version, askFirst)`), the
  Approve of an Ask first decision wherever it renders (`useApproveGate`,
  inside `useDecisionAnswer` for the queue card, the dock and the hosted
  card), and Ask first off after its confirm. With no passkey a toast offers
  Set up Touch ID, then a second press for the assertion. In the desktop app
  the same calls open `/confirm` in the system browser and wait on the
  challenge. Settings > Accounts lists passkeys (rename, Remove with Touch ID,
  Add). A cancelled confirm answers `NOT_CONFIRMED` and sends nothing.

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
one list of credential shapes: transcript redaction builds its patterns from
it, the server's `redact.ts` takes its vendor tokens from it, and the cloud
mirror and `cast ship checkout` scan files with its `VENDOR_TOKEN_RE`;
`secretPatterns.test.ts` checks all of them on one sample per shape). A match holds the
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

- The redaction feed (`/cli/vault/redaction-values`) answers any holder of
  the user's api token, and every agent shell holds it, so an agent can pull
  in plaintext every value the feed holds for its user, Ask first values that
  reached the user included. Each value's first copy to a user is on its
  trail (`redaction_sync`), but a pull after the daemon's own copy adds
  nothing new. Closing it needs a credential only the daemon holds.
- A login password under 6 characters is stored but never redacted (below
  the matcher's floor), and a chunked value printed from inside a chunk shows
  up to 63 characters before the next chunk starts.

- An approval is bound to a conversation the caller owns and that is still
  active, not to the process holding it: another live session of the same
  user can name an approved session's id. Closing that needs a per-session
  proof the backend can check (the daemon's launch tokens are local today).
- `cast dev` resolves only the `[vault]` map. A dev server that reads `.env`
  itself sees a `vault://` reference as a literal string.
- A token-scoped sign-in (`sites_by_token`) carries no mark on the Vault page
  or in `SecretMeta`: a teammate learns it from the refusal their browser
  logs, and a person confirms by saving its sites in the panel.
- Logins saved before `has_otp` existed report it unset until their next
  rotate; there is no backfill, since it would mean decrypting every login.

- A person with no passkey yet is guarded by the agent-tab check alone: an
  agent holding their web session outside the agent tab can enroll a
  software passkey of its own and confirm as them from then on. The
  enrollment email and the passkey list are how that is noticed.
- Approving an Ask first decision from the phone or the desktop app takes the
  hand-off through `/confirm`, a browser round trip per approval.

## Not in this build

- End-to-end encryption (decision sd-1084 asks; server-side ships first).
- Org template `secret` inputs bound to Vault secrets instead of sealed files.
- Mod secrets as references to Vault secrets.

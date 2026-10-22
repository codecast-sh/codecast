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

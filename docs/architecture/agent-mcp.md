# Codecast for outside agents (MCP)

One address, `https://codecast.sh/mcp`, lets an agent that has no `cast` CLI (claude.ai, Claude Code or Cursor on a machine without the daemon, Codex in the cloud) read what its person can read in codecast. The person connects it with their codecast sign-in. Nothing is pasted.

## What a connected agent reads

Every tool runs as the signed-in person and goes through the access rule that already decides what that person sees in the app. No tool has an access check of its own.

| Tool | Reads | Rule |
|---|---|---|
| `whoami` | name, teams, what the grant allows | the grant |
| `list_docs`, `read_doc` | docs in the person's workspaces | `canAccessDoc` |
| `list_tasks`, `read_task` | tasks, their comments | `canAccessTask` |
| `list_plans`, `read_plan` | plans and their tasks | `canAccessPlan` |
| `list_pages`, `read_page` | published pages (`codecast.sh/a/<slug>`) | the page's own gates, below |
| `list_sessions`, `read_session` | a session's title, pinned state, idle summary, status, project | `canAccessConversation` |

A published page opens to an agent as far as it opens to that account in the app, through `accountAdmission` (artifacts.ts), the same rule page state uses: the owner and teammates who see the page in their gallery always; a team gate opens to the gate team's members; an expired page, a password gate or an email wall stays locked for anyone else (an agent has nothing to type into them). A locked page comes back as `{locked: true, reason}`; a page or row the account cannot read comes back `{found: false}`, the same as one that does not exist.

A session comes back as its card shows it to that account (`lib/sessionCard.ts`): the owner sees title, pinned state and summary; a teammate sees only what the session's team visibility shows in the team feed ("minimal" is the project alone, "summary" adds the title, "detailed" and "full" add the state and summary); a session not shared with the team does not exist for them. Text passes the server's secret redaction on the way out.

Every grant spans every workspace the person belongs to. `whoami` names them, and each list tool takes an optional `workspace` (personal, or a team's name or id) so an agent can stay inside one team.

It cannot: write or change anything, send a message to a session, read a session's transcript, read the vault, connectors or credentials, see what the person cannot see in the app, or disconnect itself. Writes come later, narrow and behind their own scope.

Content is other people's text. Tool descriptions tell the agent that doc bodies, pages and summaries are data, not instructions.

## Auth flow (OAuth 2.1, as the MCP spec asks)

1. The agent POSTs `/mcp` with no token. Codecast answers 401 with `WWW-Authenticate: Bearer resource_metadata="https://codecast.sh/.well-known/oauth-protected-resource"`.
2. Discovery: that document names `https://codecast.sh` as the authorization server; `/.well-known/oauth-authorization-server` lists the endpoints, `S256` PKCE only, public clients only (`token_endpoint_auth_method: none`), grants `authorization_code` and `refresh_token`, scope `read`.
3. Registration: the agent registers itself at `POST /oauth/register` (dynamic client registration, RFC 7591). Codecast stores `client_id`, the client's name and its redirect URIs. Allowed redirects: `https`, loopback `http://127.0.0.1|localhost:<port>`, and private-use app schemes (`cursor://…`); `javascript:`, `data:`, `file:` and plain remote `http` are refused. Registration is rate limited per IP, and a client nobody approved within a day is swept.
4. Consent: the agent opens `codecast.sh/oauth/authorize?...` in the browser. It is an app route behind the normal sign-in. The screen shows the client's name with the host it will return to (the name is the client's own claim; the host is the fact), the account it will act as, the can / cannot lists, and Allow / Deny. The page refuses to be framed (`frame-ancestors`), so a site cannot overlay it.
5. Allow opens the shared confirm review (`components/consequential`): who connects, which account, which workspaces it reads, what it never reads, how to stop it. Confirming calls a signed-in mutation (`mcpConsent.approve`) that checks the client, the exact redirect URI and the S256 challenge, and stores a one-time code (hashed, 60 s, single use, bound to client, redirect URI, challenge, user). The page then navigates to `redirect_uri?code&state`.
6. The agent POSTs `/oauth/token` with the code and its PKCE verifier. Codecast checks the hash, expiry, client, redirect URI and `sha256(verifier)`, deletes the code, and issues the grant.

Codecast's own servers run steps 1 to 3 and 6 as Convex HTTP actions; `codecast.sh` proxies `/mcp`, `/.well-known/oauth-*` and `/oauth/register|token` to them so every address the agent sees is on `codecast.sh` and the issuer matches.

## Token storage

One row per connected agent in a new `mcp_grants` table: user, client id and name, redirect host, scope, created, last used, and the SHA-256 hashes of the current access token and refresh token with their expiries. Plaintext tokens exist only in the response that hands them out.

- Access token: `cmcp_…`, 1 hour.
- Refresh token: rotates on every use, 90 days since last use. Presenting a refresh token that was already rotated away revokes the whole grant (a stolen copy and the real client cannot both keep it).
- One grant per agent per person: connecting the same client again replaces its earlier grant.

These are deliberately not rows in `api_tokens`. A CLI token authorizes every `cast` mutation, and about 50 call sites accept one through `verifyApiToken`; a grant in a separate table cannot reach any of them, by construction, rather than by every call site remembering to refuse a read-only token.

`/mcp` also accepts an existing `cast` token as a bearer, for headless agents that already hold one (a cloud Codex with `CODECAST_TOKEN` set). Only the read tools exist behind `/mcp`, so the stronger token reads the same things. It is never offered as a setup path. Each such token's reads are recorded (`mcp_bearer_reads`, first and last read) and the token appears on Connected agents as a cast token with Revoke, which goes through the confirm review because it also signs that machine's `cast` out.

## Revocation

Settings → Connected agents lists every grant with its client, return host, when it connected and when it last read (rows live in the store's `mcpConnections`, fed by `mcpAuth.listConnections`; Disconnect is the `disconnectAgent` store action riding dispatch). Disconnect deletes the row; the next call from that agent gets 401 because every call looks the hash up (no cache). Access also shrinks on its own: leaving a team, a page going private or a session going private all take effect on the next call, because each read asks the live rule. Deleting the account deletes its grants.

## Switching it on

The OAuth routes and the consent calls answer only on a deployment with `MCP_OAUTH_ENABLED=1`; elsewhere they are 404 or refuse, and `/mcp` takes a `cast` token alone. `MCP_PUBLIC_ORIGIN` (default `https://codecast.sh`) is the issuer and resource origin; `MCP_WEB_ORIGIN` is where the consent page lives. `codecast.sh` proxies `/mcp`, `/oauth/register`, `/oauth/token` and the two well-known documents to the Convex site (`packages/web/server/index.ts`).

## Rollout

1. Read tools on `/mcp` behind existing `cast` tokens (no new auth): builds and verifies the tools.
2. OAuth (registration, consent page, token endpoint, grants table), after this note is approved.
3. The settings page: address, one-line setup per client, can / cannot, connected agents with Disconnect.
4. End to end: `claude mcp add --transport http codecast https://codecast.sh/mcp`, sign in, read a published page and a doc, be refused on another person's private doc.

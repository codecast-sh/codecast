# @platform/email

Transactional email for the platform apps, extracted from codecast's
`convex/emails` and aurora's `lib/email.ts`. Three layers, all pure
TypeScript with no framework imports (no `convex/server`, no Cloudflare
types):

1. **Render** — a block DSL (`EmailBlock`) rendered twice from one
   definition: table based HTML that survives real email clients (dark mode,
   Outlook, Gmail) and a plain text twin that never drifts from it. The brand
   (name, URL, logo, support address, colors, font) is injected. With
   codecast's brand values the output is byte identical to codecast's
   renderer; `src/render.golden.test.ts` proves it against fixtures dumped
   from the donor.
2. **Transports** — `Transport { send(message, opts) }` with two
   implementations: Resend (codecast's deliver logic over Resend's HTTP API,
   key and fetch injected) and a Cloudflare Worker relay (aurora's). Both
   warn and skip when unconfigured, so dev deployments without secrets stay
   usable. The matching Worker handler ships as a reference under
   `src/worker/` (`@platform/email/worker`).
3. **Digest policy** — the "while you were away" scheduling rules: grace,
   window, cooldown, and presence suppression, the sweep loop, the
   unsubscribe token, RFC 8058 one click headers, and the unsubscribe
   responses. The entity mapping is injected (`DigestSweepHooks`): the app
   supplies how to find candidates, load a recipient, build the digest body
   with its own deep links, persist state, and deliver.

## API

```ts
import {
  // brand
  palette, monoStack, resolveBrand, senderAddress, type Brand,
  // render
  createRenderer, renderEmail, escapeHtml, type EmailBlock, type EmailDef, type RenderedEmail,
  // templates
  createTemplates, formatWhen, OTP_EXPIRY_MINUTES,
  // transports
  createResendTransport, resendTransportForBrand, createRelayTransport,
  transportFromEnv, type Transport, type EmailMessage, type SendOptions,
  // digest policy
  GRACE_MS, WINDOW_MS, COOLDOWN_MS, ACTIVE_MS, MAX_LOOKBACK_MS, DEFAULT_DIGEST_POLICY,
  digestEligible, sweepWindow, digestRange, createEntryCapper, runDigestSweep,
  generateUnsubscribeToken, isValidUnsubscribeToken, listUnsubscribeHeaders,
  unsubscribeByToken, unsubscribeResponse,
  type DigestPolicy, type DigestRecipient, type DigestSweepHooks,
} from "@platform/email";

import { createEmailRelayHandler } from "@platform/email/worker";
```

Typical wiring:

```ts
const BRAND: Brand = {
  name: "Codecast",
  url: "https://codecast.sh",
  tagline: "Mission control for your coding agents",
  supportEmail: "support@codecast.sh",
};

const templates = createTemplates(BRAND);
const transport = resendTransportForBrand(BRAND, process.env.RESEND_API_KEY);

const email = templates.verifyEmail({ code, email: to });
await transport.send({ to, ...email }, { tag: "verify-email" });
```

`createTemplates(brand)` binds the four templates every app needs:
`verifyEmail`, `passwordReset`, `passwordChanged`, `welcome`. Each takes
params and returns `{ subject, html, text }`. `welcome` accepts optional
copy overrides (subject, heading, intro, body blocks, call to action) so an
app can keep its own voice; the defaults derive from the brand.

App specific templates stay in the app and use the same DSL: build an
`EmailDef` and call the renderer from `createRenderer(brand)`. Codecast's
`teamInvite`, `artifactComment`, and the `notificationDigest` body are this
kind — they reference codecast products and routes, so they do not live
here.

## Env vars

| Var | Used by | Meaning |
|---|---|---|
| `RESEND_API_KEY` | Resend transport | API key. Absent: warn and skip. |
| `EMAIL_RELAY_URL` | relay transport | Worker endpoint, e.g. `https://sapling.day/api/email`. |
| `EMAIL_RELAY_SECRET` | relay transport | Bearer the Worker checks. Both absent: warn and skip. |
| `EMAIL_SECRET` | Worker handler | The same bearer, on the Worker side. |

`transportFromEnv(env, brand)` picks Resend when the key is set, the relay
when both relay vars are set, and a warn and skip transport otherwise.

## Adoption

### codecast (`packages/convex/convex/emails`)

Becomes imports from this package:

- `emails/render.ts` — delete. `palette`, `monoStack`, `escapeHtml`, the
  block types, and the renderer come from here; codecast defines its `Brand`
  once (name, url, tagline, supportEmail — the values in the golden test)
  and calls `createRenderer(brand)`. Output is byte identical.
- `emails/templates.ts` — shrinks. `verifyEmail`, `passwordReset`,
  `passwordChanged` come from `createTemplates(brand)` unchanged; `welcome`
  becomes a two line wrapper passing codecast's copy (the exact params are
  in `src/render.golden.test.ts`). `teamInvite`, `artifactComment`, and
  `notificationDigest` stay, importing `EmailBlock`/`RenderedEmail` and the
  bound renderer.
- `emails/send.ts` — `deliver` becomes
  `resendTransportForBrand(brand, process.env.RESEND_API_KEY).send(...)`;
  `EMAIL_FROM` is `senderAddress(brand)`. The `internalAction`s and the
  `notifyPasswordChanged` mutation stay (they are Convex wiring). The
  `resend` npm dependency can be dropped; the transport speaks the same
  HTTP API directly.
- `emails/digest.ts` — the policy half comes from here: constants,
  `digestEligible`, the sweep loop (`runDigestSweep` with hooks over the
  Convex db), token minting, `listUnsubscribeHeaders`, and
  `unsubscribeByToken` (pass a lookup over `by_email_unsub_token` and the
  preferences patch as `apply`). Codecast keeps what is codecast:
  `EMAIL_WORTHY`, `entityUrl`, `notificationEntry`, `digestSubject`,
  `countableChatMessage`, and `buildDigestForUser` — that is the injected
  entity mapping. `oslo` is no longer needed for the token.
- `http.ts` unsubscribe route — the handler body becomes
  `unsubscribeResponse({ ok, method: request.method, brand, settingsUrl })`.
- Tests: the `digestEligible` cases in `emails/digest.test.ts` and the
  generic template cases in `emails/templates.test.ts` are covered here;
  codecast keeps its app specific cases.

### aurora (`packages/convex/convex/lib/email.ts`, `packages/web/worker.js`)

- `lib/email.ts` — delete. `sendEmail` becomes
  `createRelayTransport({ url: process.env.EMAIL_RELAY_URL, secret:
  process.env.EMAIL_RELAY_SECRET }).send(...)`, same warn and skip
  behavior. `passwordResetEmail` is replaced by
  `createTemplates(saplingBrand).passwordReset(...)` — aurora gains the full
  client safe HTML, dark mode, and the plain text twin; give the brand
  Sapling's palette and a serif `fontStack` to keep its look.
- `worker.js` — keep, or replace `relayEmail` with
  `createEmailRelayHandler({ from: { email: "hello@sapling.day", name:
  "Sapling" } })` from `@platform/email/worker`. Behavior is identical
  (verified by `src/worker/relay.test.ts`).

### whisk (minimal wiring)

Define a `Brand`, call `createTemplates(brand)` for verify, reset, changed
and welcome, and pick a transport with `transportFromEnv(process.env,
brand)`. Adopt the digest policy only when whisk grows notifications: supply
`DigestSweepHooks` over its own tables and a cron that calls
`runDigestSweep`.

## Tests

`bun test` — 58 tests: golden byte comparison against codecast fixtures
(`src/__fixtures__/codecast-golden.json`), template invariants and escaping,
both transports against a fake fetch, the digest policy and sweep against
fake hooks, the unsubscribe responses, and the Worker handler against a fake
binding.

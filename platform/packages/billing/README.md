# @platform/billing

Stripe for a subscription product, over fetch. No SDK and no Node built-ins,
so the same code runs in Convex, a Worker, bun and a test with a fake fetch.

It carries the mechanics only. Which price is which plan, what a plan
includes and what a top-up buys belong to the app, which passes a price id in
and maps the events it gets back onto its own records.

## API

**Client** (`src/client.ts`)

- `createStripe({ secretKey, fetch?, apiBase?, apiVersion? })` returns a
  client with `request(method, path, params?, { idempotencyKey? })`,
  `createCheckoutSession(input)` and `createPortalSession(input)`. Both
  sessions return `{ id, url }`: send the person to `url`.
- `createCheckoutSession({ mode, price, successUrl, cancelUrl, customer?,
  customerEmail?, clientReferenceId?, metadata?, quantity?,
  allowPromotionCodes? })`. `mode: "subscription"` for a plan,
  `"payment"` for a one-off purchase such as a top-up. `metadata` is copied
  onto the subscription or the payment intent, so later events carry it.
  A payment without a `customer` asks Stripe to make one, so the buyer has a
  portal afterwards.
- `createPortalSession({ customer, returnUrl, configuration? })`.
- Stripe's refusals throw `StripeError` with `status`, `type`, `code` and
  `param`.
- `encodeForm(params)` is Stripe's bracketed form encoding, exported for
  calls the client does not wrap.

**Webhooks** (`src/webhook.ts`)

- `verifyWebhook(rawBody, stripeSignatureHeader, secret, { toleranceSec?,
  now? })` returns `{ ok: true, event }` or `{ ok: false, reason }`, with
  reason one of `no_secret`, `no_header`, `bad_header`, `bad_signature`,
  `stale` or `bad_payload`. It never throws. Pass the body exactly as
  received: re-serialized JSON no longer matches the signature. The default
  tolerance is Stripe's five minutes, in both directions.
- `signWebhook(payload, secret, timestampSec?)` writes the header Stripe
  would, for tests of an endpoint.

**Events** (`src/events.ts`)

Loose types for the objects a plan product reads (`StripeEvent`,
`StripeCheckoutSession`, `StripeSubscription`, `StripeInvoice`) and
accessors that read a field wherever the account's API version puts it:
since 2025-03-31 the period lives on subscription items and an invoice's
subscription under `parent.subscription_details`.

- `stripeId`, `subscriptionPriceId`, `subscriptionPeriod`,
  `invoiceSubscriptionId`, `invoiceSubscriptionMetadata`, `invoicePeriod`.
  Periods come back in milliseconds.
- `isLiveSubscription(status)`: `trialing`, `active` and `past_due` keep a
  paid plan.
- `invoiceOpensPeriod(invoice)`: true for `subscription_create` and
  `subscription_cycle`. A proration invoice's lines start mid-period, so its
  period is not a billing period.

## Tests

`bun test` in this directory. The signature test checks against a digest
computed with openssl, not with this code.

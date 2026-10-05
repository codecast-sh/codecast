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
  `getPortalConfiguration(id)` reads a portal configuration with its
  products expanded; check it with `portalConfigurationProblem(config,
  prices)` before sending anyone there. `getPrice(id)` reads a price.
- `getSubscription(id)` reads a subscription as it stands now. Stripe does
  not deliver events in order, so map this rather than an event's copy.
  `listSubscriptions(customer)` lists every status, `cancelSubscription(id)`
  ends one at once, and `refundInvoice(invoiceId)` refunds an invoice's
  payment (null when nothing refundable paid it). `getInvoice(id)` reads an
  invoice with its payments, and `invoiceForPayment(paymentIntentId)` names
  the invoice a payment paid. Both work on API versions before and after
  2025-03-31.
- Stripe's refusals throw `StripeError` with `status`, `type`, `code` and
  `param`. `isStripeRefusal(error)` says whether a retry would get the same
  answer (a 4xx other than 429).
- `encodeForm(params)` is Stripe's bracketed form encoding, exported for
  calls the client does not wrap.

**Webhooks** (`src/webhook.ts`)

The HMAC and the constant-time compare come from `@platform/crypto`.

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
  `invoiceSubscriptionId`, `invoiceSubscriptionMetadata`, `invoicePeriod`,
  `invoicePaymentIntentId`, `sessionAmountBeforeTax`.
  Periods come back in milliseconds.
- `portalConfigurationProblem(config, prices)`: null when the portal bills
  an upgrade at once (`always_invoice`), holds a downgrade and a cancel to
  the period's end, keeps the billing cycle, and offers every price; else
  why not. Granting a plan's allowance on the subscription change is safe
  only then.
- `unitPriceProblem(price, unitAmount, currency = "usd")`: null when `price`
  is an active one-off price of exactly `unitAmount` minor units, else why
  not. Check it before selling N units as quantity N.
- `isLiveSubscription(status)`: `trialing`, `active` and `past_due` keep a
  paid plan.
- `invoiceOpensPeriod(invoice)`: true for `subscription_create` and
  `subscription_cycle`. A proration invoice's lines start mid-period, so its
  period is not a billing period.

## Tests

`bun test` in this directory. The signature test checks against a digest
computed with openssl, not with this code.

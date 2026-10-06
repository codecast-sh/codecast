# @platform/assistant

The storage-free half of a hosted assistant: the parts any app hosting one
shares, with the app keeping its storage and wiring. Codecast is the first
consumer (`packages/convex/convex/assistant`, build spec
`docs/architecture/hosted-assistant.md` there); Averil can adopt it on its own
schedule.

| Module | What it holds |
| --- | --- |
| `plans` | `PlanSpec`, `PlanCatalog` (the app's plans plus its free one) and `planIn`. The app keeps its own catalog values. |
| `wallet` | Money, months and periods, room, charge splitting, proration, debt, and `walletRules(catalog)`: the allowance a period grants, opening a period, rollover, and `summaryAt`. |
| `rules` | Approval rules (`withRules`), how an Always allow narrows (`AllowScopes`, `allowScopeIn`), and the card's view of a call (`approvalContext`). |
| `prompt` | `systemPrompt({ name, timezone, now, note, workspace })`. |
| `mail`, `calendar` | The tools over a `Mailbox` and a `Calendar`, with `MAIL_SCOPES` and `CALENDAR_SCOPES`. |
| `whisk` | The Whisk transport (`WhiskCall`, `whiskHttpCall`), what a token's scopes allow (`whiskAbilities`), thread links. |
| `whisk-engine` | `whiskMailbox(call, webUrl?)` and `whiskCalendar(call)`: Whisk as the Mailbox and Calendar. |
| `web` | `fetch_page` and `search_web` over `WebDeps` (a page reader, a Messages API post, the search model, a user agent), `WEB_SCOPES`, and `turnRowRules(formats)` for the gate. |
| `steps` | Each tool call as one plain line that says how it came out (`stepText`, `stepOutcome`, read through `@platform/agent/outcome`), the same action as an approval asks it (`stepAsk`), and how a run of steps folds (`visibleSteps`, `stepCount`), for a transcript a non-developer reads. |
| `zone`, `text`, `messages` | Days in a time zone, HTML as text, and the Messages API request shape with `replyText`. |

`plans`, `wallet`, `zone`, `text`, `whisk` and `messages` import nothing, and
`steps` imports only `@platform/agent/outcome` (itself dependency free), so a
web page or a phone bundle can load them alone; the rest need
`@platform/agent`, which the app installs beside this package. It is only a
dev dependency here (with `@platform/fence`, its own file dependency): bun
writes a file dependency of a file dependency into the consumer's lockfile in
a form it then cannot read back, and ignores the whole lockfile.

## Wiring an app

- Join the scopes of every tool you offer into one `AllowScopes` table and
  pass it to `withRules` and to the card, so both read the same narrowing.
- Supply `WebDeps.readPage` with your own guard against private hosts on
  every redirect hop; the package trusts it.
- `turnRowRules` needs to know which user rows your app writes for an
  approval answer and for a routine fire.
- `fakeWhisk` (`./testkit`) answers Whisk functions by path for tests.
- `callKey` salts the model's call id with codecast's prefix; it stays fixed
  so a call in flight across a deploy keeps its idempotency key.

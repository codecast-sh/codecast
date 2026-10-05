# @platform/agent

The harness for a hosted assistant: a soft fork of pi. It runs
`@mariozechner/pi-agent-core`'s loop over `@mariozechner/pi-ai`'s providers,
both pinned at 0.73.1, and adds what a product needs around that loop: tools
with a risk level, a gate in front of every call, a meter on every model
message, a cost ceiling, a deadline, and conversion to and from codecast's
stored messages.

It is runtime neutral. Nothing in it needs Node, so it runs inside a Convex
action (V8 with `fetch`). `bundle.test.ts` proves it by bundling the package
the way Convex bundles an action.

## Tools

```ts
import { defineTool, Type } from "@platform/agent";

const searchMail = defineTool({
  name: "search_mail",
  description: "Searches the person's mail. Returns sender, subject and a snippet per match.",
  parameters: Type.Object({ query: Type.String() }),
  risk: "read",
  source: "mail",
  async run({ query }, { signal }) {
    const hits = await gmail.search(query, { signal });
    return hits.map((hit) => `From ${hit.from}: ${hit.subject}\n${hit.snippet}`).join("\n\n");
  },
});
```

`run` returns text, or `{ content, details }` where `content` is text or
text and image blocks and `details` is data for logs and UI the model never
sees. A failure is a thrown error; the model gets it as an error result.
`Type` is typebox as pi-ai re-exports it.

`risk` is `read` (only looks) or `write` (acts in the world).

`source` is required in practice for any tool that fetches outside content
(mail, web, calendar): the harness wraps each text block the tool returns
with `untrusted(source, ...)` and adds `UNTRUSTED_GUIDANCE` to the system
prompt, so one forgotten wrap cannot hand a page's or an email's text to the
model as instructions. Such a tool returns raw text and does not wrap it
itself. When it throws, its error message is wrapped too, since fetch and
mail clients quote the page or the subject in their errors. The stored result
row holds the wrapped text, as the model saw it.

A write tool must pass `ctx.callId` to the outside service as its idempotency
key wherever the service takes one (a payment, a calendar event id). The
harness never runs an answered call again, but a run that dies between a
tool's side effect and storing its result row leaves the call unanswered.
The caller closes that gap with `onToolStart` and `startedCalls` (below);
the idempotency key covers what they cannot, such as a crash after the
service accepted the call and before it answered.

A tool that spends money outside the run's model calls (a paid search, a
model call of its own) reports it with `ctx.charge(usd)`. The run adds it to
`costUsd`, reports it as the `costUsd` of the call's result row in
`onMessage`, and counts it against `ceilingUsd` before the next model call,
so a costly tool can end the run with `budget`. `ctx.charge` is the only
route for a tool's spend; there is no second callback to add to a wallet.

No call starts once the run is cancelled or past its deadline, in the loop
or outside it (a resumed approval, a call a dead run left behind): the run
checks before and after the gate decides, and `runTool` refuses to start on
an aborted signal, since an outside service may ignore it. Such a call is
answered "did not run: the run stopped before it could" and `onToolStart` is
not called. A call to a tool that is no longer in `tools` is answered as
unavailable without asking the gate.

## Running

```ts
const result = await runAssistant({
  model: "claude-sonnet-5-5",          // or a pi Model
  system,                              // UNTRUSTED_GUIDANCE is added when a tool has a source
  history: rows,                       // codecast message rows, oldest first
  tools,
  gate,                                // defaults to gateByRisk: reads run, writes ask
  ceilingUsd: reservation,             // zero or more; NaN or negative stops with error
  deadlineMs: 8 * 60_000,              // a duration; Infinity for none; NaN or negative stops with error
  apiKeys: { anthropic: key },         // when given, must hold the model's provider; no env fallback
  signal,
  onText: (text, { messageUuid }) => {},   // full text so far of the message being written
  onMessage: (row, { costUsd }) => {},     // each finished row, in order
  resume,                              // answers to calls the last run left pending
  onToolStart: (call) => {},           // awaited before a write runs: persist call.id as started
  startedCalls,                        // ids persisted by onToolStart that have no result row
});
// result: { reason, error?, messages, pending, costUsd, usage, model }
```

It never throws. `reason` is why it stopped:

| reason | meaning |
| --- | --- |
| `done` | The model finished its answer. |
| `approval` | A call waits on the person; `pending` lists it. |
| `budget` | The next model call could cost more than the ceiling has left, or an answer was cut short by the output cap the money left set. |
| `time` | The deadline passed. A running tool's signal aborts. |
| `error` | A model call failed, the run was cancelled, or the history could not be continued; see `error`. |

`messages` holds the new rows in order (assistant messages and tool results),
the same rows `onMessage` saw. Each model message has one `message_uuid`,
shared by every `onText` call for it and by its finished row, so a caller can
stream into one stored row and finish it in place. Assistant rows carry
`usage` and an `api_message_id`.

Every field a row can carry is listed in `MESSAGE_ROW_FIELDS`
(`@platform/agent/history`), and codecast's `messages:writeHostedMessages`
accepts each one: `api_message_id` feeds its usage rollup, and the
`messages` table stores `thinking_signature` and `thinking_redacted`. A
convex test checks the list against the writer's validator, so pass rows
through whole. The writer redacts secrets in thinking and keeps the signature
only when redaction left the text unchanged, since a signature over altered
text would be refused; such thinking is then not replayed.

### The gate

Before each call runs, `gate(call)` answers `allow`, `ask` or `refuse` (or
`{ verdict, reason }`). `call` is `{ id, name, input, risk }`.

- `allow` runs it.
- `refuse` runs nothing and answers the model with an error (the `reason`,
  or a standard line), and the loop goes on.
- `ask` runs nothing and stops the run with reason `approval` once the
  current batch is done. Other calls in the same batch still go through the
  gate, so reads beside a write still run. The waiting call gets no result
  row.

A gate that throws counts as `ask`.

To continue, call `runAssistant` again with the history (now holding the
first run's rows) and `resume: [{ call, decision: "approve" | "decline",
note? }]`. An approved call runs then, unless the gate now refuses it (an
approval cannot override a refusal); a declined one answers the model with an
error saying so, with the person's note. A resolution for a call that is
already answered or missing from the history does nothing, and the call runs
with the arguments the history holds, so a retried resume is safe. An
approval whose `call.input` differs from those arguments (the stored row was
rewritten after the person saw the card) runs nothing: the run stops with
`approval` again, the call pending with the arguments that would run, so an
approval always covers exactly what runs.

Calls on the model's last message that nothing has answered, with no word
from the person since, go through the gate again at the start of a run:
allowed ones run, refused ones are answered, and the rest are reported as
`pending` with no model call. That covers a run woken again before the person
answered, and a run that died before it stored its results. A caller that
already holds a result can store it as a tool result row instead.

### Writes that may have happened

A retried resume and the recovery above both run a call that has no result
row. That is only safe if the call did not already act. So before a write
tool runs (risk `write`, or a tool the run does not know), the run awaits
`onToolStart(call)`; the caller persists `call.id` as started there, for
example on its turn row. If `onToolStart` throws, the tool does not run and
the model gets an error. The next run receives those ids as `startedCalls`.
A started call with no result row never runs again, whatever the gate or a
resolution says: the model is told it may or may not have happened and to
check before trying again. Answering it this way, not asking the person
again, ends the loop, since the person cannot tell either.

### Metering and the ceiling

Each model message is costed from pi-ai's usage tokens. `PRICE_OVERRIDES` is
the one price table: a model it lists is priced from it whatever pi-ai's
catalog says. Codecast's other model calls read it too, through
`@platform/agent/meter`, which imports no runtime code. A model the table
lacks takes pi-ai's reported cost, then the model's catalog price, then
`FALLBACK_PRICE` (the dearest entry), so a cost is never zero:

| model | input | output | per million tokens |
| --- | --- | --- | --- |
| claude-sonnet-5-5 | $2 | $10 | |
| claude-opus-5-5 | $4 | $20 | |
| claude-haiku-4-5 | $1 | $5 | |

Cache reads bill at a tenth of input and cache writes at 1.25x. A dated id
(`claude-haiku-4-5-20251001`) takes its base id's price.

Before every model call the run projects an upper bound on the input's cost
and caps `max_tokens` at what the money left buys, so one call cannot pass
the ceiling. The bound counts each non-ASCII character as a token and ASCII
at three characters a token, adds the API's tool preamble, each tool
definition, message framing and a flat amount per image, and prices every
token at the dearer of input and a cache write (pi marks the system prompt,
the last tool and the last message for the cache). When the cap is under
`MIN_OUTPUT_TOKENS` (1024) the call is not made and the run stops with
`budget`. With `reasoning`, the thinking budget comes out of that same cap
(`planOutput`): pi adds the budget on top of the cap it is given, so the run
lowers the cap by the budget first, shrinks the budget when the room is
tight, and drops thinking for the call when under 1024 tokens of thinking
would remain. `ceilingUsd` must be zero or more: NaN, undefined or a negative
value stops with `error` before any call, and the meter treats a NaN amount
as nothing left. Real cost is usually lower, mostly from cache reads; the wallet
trues up with `result.costUsd`.

A message cut off midway (a cancel, the deadline, a stream error) is billed
for what it streamed. pi-ai's Anthropic provider reports the output count of
the stream's first event and updates it only at the end, while the API bills
every token generated before the disconnect, so `billedUsage` raises such a
message's output to an estimate of its text, thinking and tool arguments.
`messageCost`, `result.usage`, `result.costUsd` and the stored row's `usage`
all use it.

Every metered message gets a row through `onMessage`, so the rows' `costUsd`
values always sum to `result.costUsd`, and a ledger that charges per row
stays right if the action dies before the run returns. A message that failed
or was cut off before writing any text (it was thinking, or writing a tool
call it never finished) arrives as an assistant row with no content and its
billed `usage`. Store it or at least charge it; it never reaches the model
again, since `prepareContext` drops an empty assistant message.

`deadlineMs` is a duration from the call. `Infinity` sets no deadline, a
finite value is capped at `MAX_DEADLINE_MS` (the longest a timer holds), and
NaN or a negative value stops with `error` before any call.

Temperature is never sent: newer models reject it. `max_tokens` defaults to
`DEFAULT_MAX_TOKENS` (32,000) or the model's cap, because newer models think
inside it.

### Models

`resolveModel(id)` keeps pi-ai's catalog entry for a Claude model it knows and
builds an Anthropic Messages model for an id only the price table knows,
priced from the table either way. An id neither knows throws, so nothing runs
on a model nobody priced. A built model declares no reasoning, so no
`thinking` parameter is sent and the model uses its default (newer models
think by default). `reasoning` asks for budgeted thinking only on a
model that declares `reasoning` (pi's catalog entries, such as
claude-haiku-4-5). On a table-built model it is ignored: claude-sonnet-5-5
and claude-opus-5-5 reject a thinking budget and think by default inside
`max_tokens`. Use effort, not `reasoning`, to steer them once the harness
grows that knob.

`apiKeys` given without the model's provider stops the run with `error`. Only
a run with no `apiKeys` at all lets pi read the provider's env variable, so a
run meant for a person's own key never bills the server's.

Continuing a turn that thought before a tool call (resuming after an
approval) needs the thinking's signature, so the stored rows keep
`thinking_signature` and `thinking_redacted` (see Running).

`streamModel` sends Anthropic calls through a static import of pi-ai's
Anthropic provider. pi-ai's own `streamSimple` loads every provider with a
dynamic `import()`, which a Convex isolate refuses at call time. Other apis
(the faux provider, one an app registers) go through pi-ai's registry.

## History

`rowsToMessages(rows)` and `messagesToRows(messages)` convert between codecast
message rows and pi messages:

- An assistant row's `thinking` (with `thinking_signature` and
  `thinking_redacted`), `content` and `tool_calls` (`input` is JSON text; an
  object is read too) become thinking, text and tool call blocks. A message
  with one thinking block keeps its signature; one with several keeps none,
  and its thinking is not replayed.
- `tool_results` on any row become pi tool results, named from the call they
  answer, with that call's images (`images[].tool_use_id`) attached.
- A user row's text and its own images become a user message.
- A `tool` row's text (output with no `tool_results` to carry it) reaches the
  model wrapped by `untrusted("tool output", ...)`, never as the person's
  words.
- `system` rows are notices for people and are skipped. Images stored only by
  storage id carry no bytes; put the data on the row first.

Rows round trip exactly. Pieces of one row (several results, a result and its
postscript) remember the row (`rowKey`, `rowOrigin`) and merge back into it,
in its own role (a `tool` row stays `tool`) and without the defaults pi needed
for fields it lacked (`timestamp`, `usage`, `is_error`). New tool results are
written as `user` rows, the shape Claude transcripts sync as. Cost is not kept
on rows.

`prepareContext(messages)` shapes history for the model without touching the
transcript: it drops unsigned thinking, drops empty assistant messages, moves a tool result back next to
the call it answers (an approval answered after the person typed again), and
drops results with no call or a second result for one call. The run applies
it before every model call.

## Untrusted content

`untrusted(source, text, { label?, maxChars?, nonce? })` wraps mail, web or
calendar content with codecast's shared fence (`@platform/fence`): a note
saying it is data, not instructions, then an `<untrusted-CODE source="...">`
block whose CODE is random per call, so text inside cannot close it. Control,
bidi and format characters inside are made visible, and the block is capped
at `UNTRUSTED_MAX_CHARS` (24,000) unless `maxChars` says otherwise. `nonce`
fixes the CODE for text wrapped again on every replay; the history does this
for a `tool` row from the row's uuid, so the prompt cache stays warm. A tool
with a `source` gets it applied for free; call it directly only for content
that reaches the model some other way. The run adds `UNTRUSTED_GUIDANCE` to
the system prompt when any tool has a `source` or the history holds a `tool`
row, unless the prompt already contains it.

## Runtime notes

- `@opentelemetry/api` is a dependency only so bundlers can resolve it:
  pi-ai's Mistral provider imports it, and Convex resolves every import in the
  graph even though that provider never loads here.
- The one Node built-in reference in the bundle is pi-ai's
  `require("node:fs")` inside a fallback that runs only under Bun.
  `bundle.test.ts` allows exactly that site and fails on any other.

## Tests

`bun test` from this directory. Everything runs on pi-ai's faux provider
except `stream.test.ts`, which drives the real Anthropic provider against a
stubbed `fetch`.

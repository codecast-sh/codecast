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
import { defineTool, Type, untrusted } from "@platform/agent";

const searchMail = defineTool({
  name: "search_mail",
  description: "Searches the person's mail. Returns sender, subject and a snippet per match.",
  parameters: Type.Object({ query: Type.String() }),
  risk: "read",
  async run({ query }, { signal }) {
    const hits = await gmail.search(query, { signal });
    return hits.map((hit) => untrusted("mail", hit.snippet, `Email from ${hit.from}`)).join("\n\n");
  },
});
```

`run` returns text, or `{ content, details }` where `content` is text or
text and image blocks and `details` is data for logs and UI the model never
sees. A failure is a thrown error; the model gets it as an error result.
`Type` is typebox as pi-ai re-exports it.

`risk` is `read` (only looks) or `write` (acts in the world).

## Running

```ts
const result = await runAssistant({
  model: "claude-sonnet-5-5",          // or a pi Model
  system,                              // include UNTRUSTED_GUIDANCE when tools return untrusted text
  history: rows,                       // codecast message rows, oldest first
  tools,
  gate,                                // defaults to gateByRisk: reads run, writes ask
  ceilingUsd: reservation,
  deadlineMs: 8 * 60_000,
  apiKeys: { anthropic: key },
  signal,
  onText: (text, { messageUuid }) => {},   // full text so far of the message being written
  onMessage: (row, { costUsd }) => {},     // each finished row, in order
  resume,                              // answers to calls the last run left pending
});
// result: { reason, error?, messages, pending, costUsd, usage, model }
```

It never throws. `reason` is why it stopped:

| reason | meaning |
| --- | --- |
| `done` | The model finished its answer. |
| `approval` | A call waits on the person; `pending` lists it. |
| `budget` | The next model call could cost more than the ceiling has left. |
| `time` | The deadline passed. A running tool's signal aborts. |
| `error` | A model call failed, the run was cancelled, or the history could not be continued; see `error`. |

`messages` holds the new rows in order (assistant messages and tool results),
the same rows `onMessage` saw. Each model message has one `message_uuid`,
shared by every `onText` call for it and by its finished row, so a caller can
stream into one stored row and finish it in place. Assistant rows carry
`usage` and an `api_message_id`.

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
note? }]`. An approved call runs then, without the gate; a declined one
answers the model with an error saying so, with the person's note. Called
again with no `resume` while the call still waits, the run reports
`approval` with the same `pending` and makes no model call. A caller that
already holds a result can store it as a tool result row instead.

### Metering and the ceiling

Each model message is costed from pi-ai's usage. When pi-ai reported no cost
(a model its catalog lacks, the faux test provider), the tokens are priced
from `PRICE_OVERRIDES`, then the model's catalog price, then `FALLBACK_PRICE`
(the dearest override), so a cost is never zero:

| model | input | output | per million tokens |
| --- | --- | --- | --- |
| claude-sonnet-5-5 | $2 | $10 | |
| claude-opus-5-5 | $4 | $20 | |
| claude-haiku-4-5 | $1 | $5 | |

Cache reads bill at a tenth of input and cache writes at 1.25x. A dated id
(`claude-haiku-4-5-20251001`) takes its base id's price.

Before every model call the run projects the input's cost (every token as
fresh input, about four characters a token) and caps `max_tokens` at what the
money left buys. When that is under `MIN_OUTPUT_TOKENS` (1024) the call is
not made and the run stops with `budget`. The projection is conservative
because cache reads cost less; the wallet trues up with `result.costUsd`.

Temperature is never sent: newer models reject it. `max_tokens` defaults to
`DEFAULT_MAX_TOKENS` (32,000) or the model's cap, because newer models think
inside it.

### Models

`resolveModel(id)` keeps pi-ai's catalog entry for a Claude model it knows and
builds an Anthropic Messages model for a newer id, priced from the override
table. A built model declares no reasoning, so no `thinking` parameter is
sent and the model uses its default. Pass `reasoning` to ask for extended
thinking on a model pi-ai knows supports it.

`streamModel` sends Anthropic calls through a static import of pi-ai's
Anthropic provider. pi-ai's own `streamSimple` loads every provider with a
dynamic `import()`, which a Convex isolate refuses at call time. Other apis
(the faux provider, one an app registers) go through pi-ai's registry.

## History

`rowsToMessages(rows)` and `messagesToRows(messages)` convert between codecast
message rows and pi messages:

- An assistant row's `thinking`, `content` and `tool_calls` (`input` is JSON
  text; an object is read too) become thinking, text and tool call blocks.
- `tool_results` on any row become pi tool results, named from the call they
  answer, with that call's images (`images[].tool_use_id`) attached.
- A user row's text and its own images become a user message.
- `system` rows are notices for people and are skipped. Images stored only by
  storage id carry no bytes; put the data on the row first.

Rows this package writes round trip exactly: pieces of one row (several
results, a result and its postscript) remember the row and merge back into it.
New tool results are written as `user` rows, the shape Claude transcripts sync
as. Cost is not kept on rows.

`prepareContext(messages)` shapes history for the model without touching the
transcript: it drops unsigned thinking (rows keep thinking text, not its
signature), drops empty assistant messages, moves a tool result back next to
the call it answers (an approval answered after the person typed again), and
drops results with no call or a second result for one call. The run applies
it before every model call.

## Untrusted content

`untrusted(source, text, label?)` wraps mail, web or calendar content in an
`<untrusted source="...">` block that says it is data, not instructions, and
defuses any tag inside the text that tries to close the block. Put
`UNTRUSTED_GUIDANCE` in the system prompt of any run whose tools use it.

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

An agent that reaches a real fork has two bad choices. It can stop and ask, which pulls you out of your own work to read a transcript. Or it can pick a direction alone, and you learn about the choice after code depends on it.

`cast decide` is a third path. The agent writes one question, 2 to 9 options, and the reasoning into a row that lands in a queue. You clear the queue in one sitting, when you choose to. The answer goes back into the asking session as a message, and the agent continues from it.

The cost model is the point. An interruption is expensive, so the usual rule for agents is to decide alone. A queued question costs you almost nothing to receive, so the bar for asking drops. The decide snippet ([how snippets work](/documentation/agent-snippets)) tells the agent this directly: a choice it would have made silently and mentioned in passing goes to the queue instead. Install it with `cast install decide`.

```bash
cast decide "Which schema wins?" \
  -o "Frontmatter wins :: renames keep the id, the daemon changes" \
  -o "Path wins :: the web index changes, old links break" \
  --context - <<'EOF'
The daemon writes note ids from the file path. The web index derives them
from frontmatter. A rename keeps one id and changes the other, so the same
note indexes twice. Either side can be authoritative.
EOF
cast decide "Approve dropping agent_runs_v1?" -o "Approve" -o "Hold" \
  --context "Nothing wrote to it in 40 days." --report drop-analysis.html
cast decide "Which layout?" -o "Dense" -o "Roomy" --context "Both pass review." \
  --option-page 1=dense.html --option-page 2=roomy.html
cast decide "Back off or switch keys?" -o "Back off" -o "Switch keys" \
  --advisory --default 1 --context "429s for 4m. Backing off costs about 20m."
cast decide ls                 # this session's decisions, with ids and answers
cast decide edit --context -   # rewrite the open decision in place
cast decide cancel             # withdraw it
```

## What the agent writes

| Flag | What it carries |
|------|-----------------|
| `-o "Label :: consequence"` | One option. Text after `::` becomes the description shown under the label. Repeat 2 to 9 times; the options map to keys 1 to 9 in the queue |
| `--context <text>` or `--context -` | Markdown reasoning: what the agent found, what each option costs, why it cannot pick. `-` reads a heredoc from stdin |
| `--report <file>` | An HTML or markdown file published through the same path as [`cast publish`](/documentation/publish). The row stores only the page slug, and the page renders embedded with the question |
| `--option-page n=<file, slug or url>` | A page for option n. A file publishes like `--report`. A slug or a codecast page URL attaches a page that already exists. The server refuses a slug that is not published |
| `--doc <file>` | A markdown document as the long body of the decision |
| `--advisory --default <n>` | Do not block. The agent proceeds with option n. Each flag requires the other |

The CLI refuses a question with no `--context`, `--report` or `--doc`. After a post it prints the card back to the agent. It adds a note when the context is under 200 characters with no report, because you would have to open the session to answer. It adds a second note when no option has a consequence.

The command writes one row to the `session_decisions` table. The server returns a short id such as `sd-41` and the agent uses that id for every later command. If the agent posts the same question again from the same session, the server updates the open row. A retry after a crash does not create a duplicate. The server rejects a post into a session that belongs to another user.

## Blocking and advisory

Blocking is the default. The agent posts the decision and ends its turn. The session stays parked until the answer arrives.

An advisory decision keeps the agent working on the default it declared. Your answer can still override that default later. The help text and the snippet both restrict this to a default that is cheap to undo. The reason is timing: the snippet tells the agent that answers tend to land about an hour later and often disagree. Everything built on the default in that hour is then work to remove. If the reversal would cost more than the wait, the agent must block.

`cast decide edit --blocking` turns an advisory decision into a blocking one and clears its default.

## What you see

The decision renders as a card in the conversation, at the place where the agent ran the command. The same row appears in the queue at `/questions`. The snippet tells the agent to write nothing about the decision in prose after the command, because the card already holds the full payload.

The queue has two modes. The list mode groups pending decisions by stack and then by scope, as compact cards that link to each decision's page. The step mode (`/questions?mode=step`) shows one decision at full width and advances when you answer.

| Key in step mode | Action |
|------------------|--------|
| `1` to `9` | Answer with that option |
| `t` | Type your own answer |
| `s` | Skip for now |
| `x` | Dismiss. The row resolves as dismissed, leaves the queue, and the agent is not told |
| `o` | Open the session |

The order is fixed by a rule and not by a score. Blocked decisions whose session can still receive an answer come first. Blocked decisions on a stopped or unresponsive session come second. Advisory decisions come last. Inside each group the oldest decision comes first, because a parked agent costs more the longer it waits.

Each decision also has a document page at `/decisions/<sd-N>`. The page shows the question, the asking session, the body or the embedded report, each option with its own page, and the answer controls. The card links to this page when a decision has a document, an option page, or an answer kind other than a single choice.

## How the answer returns

An answer from the web does two things in one store action. It marks the row answered in the local store, so the card leaves the queue at once. It then sends a normal user message into the asking session through the same path as the composer. The message text is `Decision: <chosen label>` plus a `cast-decision` tag that names the decision id and the question. The conversation uses that tag to render the message as an answer linked back to the ask.

Answers that do not come from the web, such as `cast decide answer <sd-N> <n>` from a shell, go through one server function that writes the same message. The first writer wins. A second answer to a row that is no longer pending changes nothing, and the CLI reports that the first answer stands.

## Keeping an ask correct

A posted decision belongs to the agent until someone answers it.

`cast decide edit` rewrites the question, options, context, report or mode on the open row. The row keeps its id, its age and its place in the queue. With no id, `edit` and `cancel` act on the session's single open decision. With several open, the CLI lists them and asks for an id. `cast decide cancel` marks the row withdrawn, and the conversation shows it as withdrawn. An edit or cancel on an answered row fails and prints the answer.

Staleness is measured, not assumed. Each ask stores the conversation's message count at that moment. `cast decide ls` prints each open decision as `asked 3h ago, 42 messages since`. The card shows the same two numbers. The CLI treats an open ask as stale after 2 hours or 30 messages, and tells the agent to cancel or edit it. A new post also lists the session's earlier open asks with the same numbers, so the agent reviews them at the moment it posts.

## Permission prompts in the same queue

The queue has two more sources: an agent's terminal question and a permission prompt. Neither has an authored payload, so the card shows the last assistant message and the session's [pinned state](/documentation/thread-state).

A permission card renders the real Approve and Deny controls. Number keys are disabled on it. A queue that advances on each key press could otherwise send the digit you meant for the previous card to an approval. From the keyboard, only `y` and `n` answer a permission card. Inside the queue, these cards are answered in step mode, on the session's own pane.

## Decision stacks

On 2026-09-13 a decision became a document, and decisions gained stacks. A stack is an ordered set of decisions that one person clears in one sitting, with an id such as `ds-7`.

```bash
cast stack create "Launch checklist" --policy auto-default:24h
cast decide "Ship the banner?" -o "Ship" -o "Hold" --context "Copy is final." --stack ds-7
cast stack remove ds-7 sd-41
cast stack reorder ds-7 sd-43,sd-41,sd-42     # every member, in the new order
cast stack policy ds-7 --due tomorrow         # or --auto-default 24h, --no-due
```

`--stack ds-N` on `cast decide` appends the new decision to that stack. The queue renders a stack as a checklist, and you can also group selected cards into a new stack from the list. The stack page lives at `/decisions/stacks/<id>`.

A stack has two policies that change runtime behavior. `--due` records when you mean to have cleared the stack, and the queue lists an overdue stack first. `--auto-default <duration>` lets a server job, which runs every 5 minutes, answer advisory members with their declared default after the deadline passes. The deadline counts from when the decision joined the stack. Blocking members never receive an automatic answer. The checklist also has one control that answers every advisory member with its default.

A stack closes when every member is resolved, by any path: answered, dismissed or withdrawn.

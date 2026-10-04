# Decisions as documents, with stacks (W2)

`cast decide` today: a question, 2 to 9 options, markdown context, an optional
published report, blocking or advisory, one owner (the host), answered from the
queue or the card. This workstream makes a decision a document with rich
options, routes it through the org as a race, groups decisions into stacks with
policies, and binds it to the task and station it blocks.

## D1. Fields on `session_decisions`

```
kind?               "single" | "multi" | "rank" | "form"     default single
category?           string   from the vocabulary below (server assigned; asker may propose)
category_proposed?  string
doc_id?             Id<docs>  rich body (markdown doc); report_slug stays for a published page
options[i]          + body_md?, evidence?: { label, url }[], cost?: string, risk?: string, page_slug?: string
form?               { fields: { key, label, type: "text" | "number" | "select" | "bool", options?: string[] }[] }
answer_json?        any      for multi (indexes), rank (ordered indexes), form (values)
task_id?            Id<tasks>        the task this decision blocks or informs
station?            string           task status category or team status id the task is held at
stack_id?           Id<decision_stacks>
holder?             { kind: "user" | "role"; id: string }   who may answer; default the human(s)
holder_key?         "user:<id>" | "role:<id>"   holder flattened for the index
asked_user_ids?     Id<users>[]      the people it is visible to (materialized in decision_inbox)
hops?               { role_id, recommendation?: number, note?, at }[]   recommendations attached on the way up
answered_by?        { kind: "user" | "role" | "policy"; id: string }
grant_id?           Id<decision_grants>   set when a role answered under a grant
scope_keys?         string[]         the scope keys a grant may match for this row
short_id?           "sd-N"
indexes             by_task [task_id, status], by_stack [stack_id], by_holder_status [holder_key, status], by_short_id
```

New tables:

```
decision_inbox     decision_id, user_id, status: "pending" | "done", created_at
                   index by_user_status [user_id, status], by_decision [decision_id]
decision_stacks    short_id "ds-N", title, team_id? / scope_user_id? (anchor style access), owner_user_id,
                   role_id?, decision_ids: Id[] (ordered), policy: { auto_default_after_ms?, delegate_role_id?, due_at? },
                   status: "open" | "done", client_key?, created_at, updated_at
                   index by_team, by_scope_user, by_short_id, by_status
decision_grants    role_id, category, scope_key: string ("role:<id>" | "project:<id>" | "plan:<id>" | "stack:<id>"),
                   granted_by, granted_from_decision_id?, granted_at, expires_at, revoked_at?, revoked_reason?,
                   override_streak?
                   index by_role [role_id, category]
```

Vocabulary: `approach`, `scope`, `priority`, `retry`, `review`, `allocation`,
and the protected set `production`, `billing`, `data`, `access`, `external`,
`product`, plus `limit` (raising a cap) and `unknown`. Protected, `limit` and
`unknown` are always human held. The server assigns the category: the asker's
proposal is accepted only when it is not looser than what a conservative
classifier reads from the question and options (any option naming a deploy,
purchase, deletion, access change, external message or product choice pins
the category to the protected one).

## D2. The race

- Insert (`routeFor` in `convex/sessionDecisions.ts`, org-staffing.md S28):
  people = the asking session's owners plus the first person its reporting
  line ends at. `--to` addresses named people instead and skips the ladder.
  One `decision_inbox` row per person.
- Ladder (`buildLadder`): the roles from the asker up to the first person; a
  role that is not `active` is recorded as a skipped hop with a note. A
  standing session's ladder starts at its parent role. Only the first role
  hears, through its needs-input trigger (`tellHearingRole`); while it can be
  told, the decision enters no person's queue (it answers, recommends, or
  raises it in its own thread). With no role to tell, it lands in the
  people's queue. A role on the ladder attaches a recommendation with `cast
  decide recommend <sd> <n> [--note -]`; past the hop deadline of 5 minutes
  (`HOP_DEADLINE_MS`) it still lands and is reported late.
- Holder: the people, unless a role on the ladder holds a `decision_grants`
  row for (category, scope) that has not expired, in which case that role may
  answer first with `cast decide answer <sd> <n>`. A human answer always wins
  a race (the resolve mutation is idempotent, first writer wins).
- Delivery of the answer: straight to the asking session.
- Grants come from the card: when a person picks the option a role
  recommended, and that role has recommended on 3 decisions of that category
  in that scope from 2 different askers and been agreed with each time, the
  card offers "Let this role answer questions like this here". A grant
  expires after 30 days. Two consecutive overrides (a person reopening or
  disagreeing with a granted answer) revoke it. Granted answers are listed
  under "Handled without you" on the queue and the role page with disagree
  and reopen controls.

## D3. Task and station binding

- `cast decide --task ct-x [--station in_review]` sets `task_id` and
  `station`. Inside a session bound to a task, `--task` defaults to the bound
  task. The task page shows open decisions as cards under the description; the
  task list shows a "decision" chip. The line (W4) treats a blocking decision
  on a task as a gate: the task stays at its station until answered.
- Answering from the task page is the same resolve mutation.

## D4. Documents

- `--doc <file.md>` or `--doc -` creates a docs row (doc_type "decision"; add
  to the union) holding the long body; `--report <file.html>` stays for a
  published page. Option bodies: `-o "Label :: description" --option-body 2=<file.md>`
  (and `--option-page 2=<file|slug|url>` for an option's own page), or a JSON
  spec `--spec decision.json` with kind, options, bodies, evidence, cost,
  risk, form fields.
- Route `/decisions/<sd>`: the document page. Header (question, asker, task,
  station, category with who assigned it, stack), the body (doc markdown or
  the report iframe), the options as full width rows with their bodies,
  evidence links, cost and risk, the ladder with recommendations, the answer
  footer (the existing DecisionAnswerFooter, extended for multi, rank, form).
  The inline card in the conversation and the queue card stay compact and link
  to the page.

## D5. Stacks and policies

- A stack is an ordered set of decisions one person clears in one sitting.
  Created by an agent (`cast stack create "Launch checklist" --policy
  auto-default:24h`) or by the queue ("group into a stack"). `cast decide
  --stack ds-N` appends. The queue groups by stack, then by role, then by
  scope; a stack renders as a checklist with next and previous, keyboard 1 to
  9, and "answer all defaults" for advisory members.
- Policies: `auto_default_after_ms` answers advisory members with their
  default when the deadline passes (blocking members never auto answer);
  `delegate_role_id` grants that role every non protected category for the
  stack's members and records the grant with `granted_from_decision_id` absent
  and `scope_key = "stack:<id>"`.
- Reorder and remove from the stack page; a stack is done when every member is
  resolved.

## D6. CLI

```
cast decide "<q>" -o .. -o .. [--task ct-x] [--station s] [--stack ds-N] [--category c] [--kind single|multi|rank|form] [--line <label>] [--to <who>] [--doc f] [--spec f] [--report f] [--card f] [--advisory --default n]
cast decide recommend <sd> <n> [--note -]
cast decide answer <sd> <n|"1,3"|"2>1>3"|--form key=value...>
cast decide show <sd> | edit | cancel
cast decide ls [--stack ds-N] [--task ct-x] [--mine]
cast stack create "<title>" [--policy auto-default:<dur>] [--delegate @handle] | ls | show ds-N | add ds-N sd-N | remove ds-N sd-N | reorder ds-N sd-a,sd-b | policy ds-N ... | delegate ds-N @handle
```

`resolve` must accept a person who is in `asked_user_ids` (not only the host)
and a role holder under a grant; keep the host check for `edit` and `cancel`.

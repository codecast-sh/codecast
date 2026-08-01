# Organizational Steering

**Status:** Revised canonical direction
**Plan:** `pl-233`
**Date:** 2026-08-01

## Purpose

Codecast should become the conversational operating map of an organization: a
shared, living representation of what the organization wants to change, what
it believes, what it needs to learn, what it is doing, and what it learned.

The baseline has three inseparable outcomes:

1. Establish the right organizational steering data model.
2. Build a polished new Steering tab for maintaining and navigating it.
3. Make Strategy and every Steering Item natively conversational.

Automatic observed-work rollups, inferred attention signals, and autonomous
steering are not phases of this initiative. They may be reconsidered after the
baseline product has been used and reviewed.

## The central model

Organizational work is not a rigid `Goal -> Project -> Task` hierarchy.
Especially while searching for product-market fit, organizations repeatedly:

```text
choose an outcome
  -> make a bet
    -> identify a question
      -> run an initiative
        -> perform tasks
          -> observe evidence
            -> answer and decide
              -> revise the outcome, bet, or approach
```

Objectives, bets, initiatives, and questions share a structural role: they are
things the organization directs attention toward in pursuit of an outcome.
They can be owned, prioritized, nested, discussed, assessed, and connected to
work. They therefore use one recursive primitive: **Steering Item**.

The item kind remains explicit because each kind has a different meaning and
completion contract. Consolidating storage must not erase semantics.

```text
Strategy
  |
  v
Steering Items (recursive)
  - Objective
  - Bet
  - Initiative
  - Question
  |
  v
Plans, Tasks, Subtasks, Sessions

Conversations are native at Strategy and every Steering Item.
Evidence, answers, decisions, and history explain how understanding changed.
```

## Vocabulary

### Strategy

Strategy is the organization's current, versioned synthesis of its situation,
beliefs, choices, and exclusions. It is a coherent argument explaining why the
current portfolio makes sense. It remains distinct from a Steering Item and
should read like a document, not a node in a backlog.

### Steering Item

A Steering Item is an owned unit of organizational intent or inquiry. Items may
nest recursively and may also have constrained typed links.

Every item has common identity and operating state:

- title and description;
- kind;
- owner and priority;
- lifecycle state;
- optional primary parent and ordering;
- relevant dates;
- links, conversations, history, and timestamps.

#### Objective

A desired change in reality. An Objective is successful when its success
criteria become true, not when its child work is merely completed.

Completion contract: **Did the desired state become true?**

#### Bet

A falsifiable belief that justifies committing attention or resources. A Bet
records why the organization expects an approach, market, or mechanism to work
and the evidence that currently supports or challenges it.

Completion contract: **Did evidence support, weaken, or invalidate the belief?**

#### Initiative

A bounded effort undertaken to advance an Objective, test a Bet, or answer a
Question. Initiative is the strategic meaning of what users may colloquially
call a project.

An experiment can succeed by invalidating its hypothesis. Completing its Tasks
is execution completion, not proof that it achieved its intended result.

Completion contract: **Was the effort concluded, and what result or learning
did it produce?**

#### Question

An important uncertainty that needs a sufficiently confident answer. A
Question is first-class work and can contain Initiatives, Tasks,
or smaller Questions.

Completion contract: **Do we have an adequate answer, supporting
evidence, and any resulting decision?**

### Tasks and Plans

Tasks and subtasks remain Codecast's specialized execution system. Plans remain
multi-task orchestration structures. Neither is folded into Steering Items.

They already carry assignment, dependencies, agent runs, workflows, progress,
retries, and verification. Tasks and Plans may attach to any Steering Item.

### Evidence, answers, decisions, and history

Steering depends on how understanding changes, not only the latest field value.
The model should preserve chains such as:

```text
Question -> Investigation -> Evidence -> Answer -> Decision -> Revised Bet
```

Existing Conversations, Docs, Sessions, commits, diffs, task activity, and
other observed records should be linked rather than copied. Explicit learning
records may represent evidence, answers, decisions, and assessments when no
existing object is authoritative.

## Hierarchy and graph semantics

The UI needs a comprehensible tree, but an organization is not literally a
tree. `parent_item_id` means where an item primarily lives for navigation and
context:

```text
Objective: Establish repeatable demand
  Initiative: Run a concierge pilot
    Question: Which buyer feels the pain most strongly?
      Initiative: Interview operations leaders
        Task: Recruit ten interviewees
        Task: Synthesize evidence
```

Typed links represent additional causal relationships:

- an Initiative advances an Objective;
- an Initiative tests a Bet;
- a Question tests a Bet;
- a Question blocks an Initiative;
- evidence supports or challenges a Bet;
- a decision revises or closes another item;
- a Task or Plan executes or investigates an item.

The application exposes domain actions such as `advances`, `tests`, `blocks`,
`supports`, and `challenges`, not arbitrary graph editing. Every parent and link
operation remains inside one authorized workspace, rejects self-links and
cycles, and follows a documented relationship matrix.

## Lifecycle

Every Steering Item has one authoritative `status` field. Its allowed values
and UI language remain kind-aware so each kind preserves its honest completion
contract. Results, answers, and resolutions belong in their corresponding
narrative fields rather than in a second health or condition axis.

## Data model

### Preserve

- `tasks`, including hierarchy, assignment, dependencies, CLI behavior,
  execution state, comments, history, and session links;
- `plans` and orchestration behavior;
- `conversations` and `messages` as the conversational substrate;
- `docs` as the rich-content substrate;
- activity, insight, commit, file-change, and deployment records;
- existing Project IDs and compatibility behavior during migration.

### Keep `strategies`

Strategy supplies identity, workspace, lifecycle, ownership, review timing,
and a link to an existing Doc containing its structured narrative.

```text
user_id, team_id, short_id
title, status
owner_id, doc_id
review_at
created_at, updated_at
```

### Add `steering_items`

Common conceptual fields:

```text
user_id, team_id, short_id
kind                         objective | bet | initiative | question
parent_item_id
title, description
owner_id, priority, sort_order
status
target_date, started_at, review_at, completed_at
created_at, updated_at
```

Type-specific fields may initially live on the same discriminated table so the
client hydrates, caches, subscribes to, and recursively queries one collection.
Validation must be kind-aware.

```text
objective:
  success_criteria

bet:
  hypothesis
  resolution_summary

initiative:
  intent
  rationale
  success_criteria
  result_summary

question:
  why_it_matters
  current_answer
  resolved_at
```

Avoid a generic JSON payload that prevents validation, indexing, or safe
evolution. A sparse discriminated row is acceptable; an untyped universal
object is not.

### Links and conversations

A constrained typed link table connects Steering Items to other Steering Items
and to Strategy, Tasks, Plans, Conversations, Docs, and observed work.

A separate entity-to-conversation association links Conversations to Strategy
or a Steering Item with a relationship such as `discussion`, `investigation`,
`work`, or `evidence`. Messages remain in existing Conversations and Messages;
they are never copied into per-item chat columns.

One Conversation may relate to multiple items. Existing direct Task/Plan
conversation associations remain during compatibility migration.

### Learning records

Use existing authoritative records where possible. If explicit records are
needed, keep the primitive historical and small:

```text
steering_events
  steering_item_id
  kind                         evidence | answer | decision | assessment
  summary
  source entity/link
  actor_id
  created_at
```

These records appear in item context and history, not as another product silo.

## Migration from the first foundation

The first implementation introduced separate `goals` and `questions` tables
and expanded `projects`. Adapt that work rather than extending it into the UI
as the canonical ontology.

- each Goal becomes an Objective Steering Item;
- `parent_goal_id` becomes `parent_item_id`;
- each Question becomes a Question Steering Item;
- each strategic Project becomes an Initiative Steering Item;
- legacy Project IDs and Task/Plan associations remain resolvable through a
  compatibility mapping or dual-read period;
- do not invent Bets from prose or project names;
- preserve short IDs, ownership, containment, timestamps, and history;
- update change feed, hydration, stores, subscriptions, durable mutations,
  authorization, and deletion reconciliation around the unified collection;
- remove separate-entity APIs once compatibility consumers have moved.

The implementation must not ship two competing canonical models.

## Steering tab

Global navigation adds one isolated tab:

```text
Sessions    Tasks    Steering
```

It should feel like one conversational operating map, not separate CRUD tools.

### Primary views

```text
Overview
Map
Strategy
My work
```

Objectives, Bets, Initiatives, and Questions are filters or saved perspectives
over the same collection, not separate product silos.

### Overview

The default page manually represents:

- What outcomes are we pursuing?
- What are we betting?
- What must we learn?
- What are we doing now?
- What recently changed in our understanding?

It must not fabricate automatic assessments or observed-work rollups in this
scope.

### Map

Map presents the recursive hierarchy with clear kind markers and lightweight
expansion. Users can create any kind at the root or beneath another item, move
and reorder without cycles, inspect typed cross-links, filter the portfolio,
and open linked execution.

Mixed nesting should feel natural:

```text
Objective
  Bet
    Question
      Initiative · Experiment
        Task summary
  Initiative · Delivery
    Objective
```

### Item detail

Every item uses one consistent detail shell with kind-specific language:

```text
Intent or inquiry
Current lifecycle
Owner, priority, and dates
Children
Relationships
Linked execution
Conversation
Evidence and history, when explicitly recorded
```

Prompts reinforce meaning:

- Objective: What change should become true? How will we know?
- Bet: What do we believe, why, and what evidence bears on it?
- Initiative: What bounded effort are we undertaking, why, and what outcome or
  learning would make it worthwhile?
- Question: What must we understand, why does it matter, and what is our
  current answer?

### Strategy

Strategy remains a readable structured document for situation, beliefs,
approach, choices, and exclusions. Its surrounding rail links to the Steering
Items it informs and includes the same conversational affordance.

### My work

My work is a deterministic view across owned Steering Items and existing Tasks.
It is not an inferred or autonomously reprioritized queue in this scope.

### Tasks boundary

Steering explains intent, inquiry, bets, and outcomes. Tasks manages detailed
execution. Steering shows compact Task and Plan summaries and opens detailed
execution in Tasks with relevant context preserved.

## Conversation everywhere

Conversation is core product behavior, not a later intelligence layer. Every
Strategy and Steering Item has a reusable conversation panel and composer.

When someone sends a message from an object:

1. Codecast creates or resumes a linked Conversation.
2. The agent receives the selected object, its ancestors, children, relevant
   links, Strategy, and current execution context within authorization bounds.
3. The conversation proceeds through the existing agent system.
4. Related discussions, investigations, and work sessions remain visible from
   the object.

The baseline must support natural questions such as:

- "What evidence currently supports this Bet?"
- "What would resolve this Question?"
- "Does this Initiative still advance the Objective?"
- "Turn our conclusion into a proposed update."

The agent may explain or draft a proposed structured change. Consequential
mutations require explicit human confirmation; autonomous reprioritization and
unsolicited steering remain out of scope.

## Authorization and synchronization

Steering is team-scoped first. Membership is the organization boundary;
ownership expresses responsibility rather than exclusive visibility. Every
read, write, parent, link, hydration path, and assembled agent context fails
closed across workspaces.

The unified collection participates fully in Codecast's local-first system:

- change-log schema and write interception;
- owner/team catch-up queries;
- batch hydration and browser-store collection;
- subscriptions and optimistic or durable mutations;
- deletion and migration reconciliation;
- containment and convergence tests.

## Delivery and acceptance

The work is one baseline with three workstreams, not a sequence of speculative
future phases.

### 1. Unified data model

- Replace separate Goal/Question/strategic-Project ontology with recursive,
  typed Steering Items.
- Implement kind-aware validation, safe recursive parenting, typed links, and
  migration compatibility.
- Complete authorization, local-first synchronization, and regression tests.

Accepted when all four kinds can be created, updated, nested, moved, linked,
and archived; cycles and cross-workspace relationships fail closed; old data
survives without invented meaning; Tasks and Plans remain operational; and one
canonical strategic-item model remains.

### 2. Polished Steering tab

- Build Overview, Map, Strategy, My work, portfolio filters, and consistent
  item detail.
- Support manual creation, editing, nesting, movement, lifecycle, ownership,
  links, and execution navigation.
- Verify responsive layout, empty/loading/error states, keyboard behavior, and
  important accessibility paths.

Accepted when a team can understand and maintain its outcomes, bets, questions,
initiatives, Strategy, and connected execution as one coherent portfolio, and
the interface is polished enough for sustained dogfooding.

### 3. Conversation everywhere

- Add the reusable conversation surface to Strategy and every item kind.
- Create and resume entity-linked Conversations.
- Ground agents in authorized connected context.
- Show related discussions and investigations.
- Require human confirmation for consequential structured mutations.

Accepted when users can converse naturally from every strategic level without
leaving the object, conversations retain their links, context is correct and
workspace-contained, and existing messaging behavior is reused rather than
duplicated.

## Explicitly out of scope

- automatic evidence extraction and observed-work rollups;
- inferred attention queues;
- autonomous prioritization or state changes;
- unsolicited strategic briefs or recurring rituals;
- an always-running autonomous steering partner;
- generalized graph editing;
- replacement of Tasks or Plans.

## Product principles

1. **One structural primitive, honest semantic kinds.**
2. **Model the learning loop, not only work breakdown.**
3. **Objectives describe reality, not activity.**
4. **Failed bets can produce successful learning.**
5. **Hierarchy is primary placement, not total truth.**
6. **Tasks stay specialized and lightweight.**
7. **Strategy remains a coherent argument.**
8. **Conversation is native to every strategic level.**
9. **The agent helps users reason before it changes structure.**
10. **Organization boundaries are real.**

## Completion point

This initiative is complete when Codecast has:

1. a trustworthy recursive typed Steering Item model integrated with existing
   execution;
2. a polished Steering tab for maintaining and navigating it; and
3. contextual conversation on Strategy and every Steering Item.

Nothing beyond that baseline is required for completion.

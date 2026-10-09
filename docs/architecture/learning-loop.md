# The learning loop

How a product learns from what happens to it. One model, any product, with the
product doing as much or as little of it as it wants. Sections are LL1 onward.

## LL1. The loop is one graph

```
expectations ─► observe ─► judge ─► problem ─► fix ─► decide ─► ship ─► watch
     ▲                                                                   │
     └──────────────── what the loop learns about itself ◄───────────────┘
```

Each step is a node in a codecast graph, the same engine the line already
runs on. A node is one of three kinds:

- **an agent session**, which reads and writes code and data;
- **a model call**, one prompt and one answer, cheap enough to run thousands of times a day;
- **a script**.

A step can also be **supplied by the product**: the product does that step
itself and hands codecast its result. Codecast treats a supplied step and its
own step the same way. They're versioned, measured and shown on the map, with
their results traceable.

## LL2. The objects

| Object | What it is |
|---|---|
| **Expectation** | One sentence about how the product should behave, quoted from where a person said it. Versioned. |
| **Moment** | One thing that happened, frozen with what's needed to judge it. Optional: only when codecast judges. |
| **Finding** | Something that broke an expectation: what, how bad, a quote, a link to where it happened, and which judge (and version) said so. |
| **Problem** | Findings with one root cause. The only unit of work. |
| **Change** | One attempt to fix a problem, with proof that it failed before and passes after. |
| **Decision** | A question to a person, with an owner they can talk to. |
| **Outcome** | After ship: the problem stayed fixed, or came back. |

Every object has one home, and every result names the version of the step that
produced it.

## LL3. Two ways to plug in a product

**Bring findings.** The product watches itself: it runs its own judges and
groups findings into issues. It sends codecast one problem per issue, with the
issue's findings, and keeps the issue's id as the problem's key. From there,
codecast runs everything else: admission, the fix, your decision, ship, watch.

**Bring moments.** The product sends a one-line event when something worth
judging happens. Codecast pulls the moment, judges it and groups the findings
itself. The product only gives access: its repo, a read-only copy of its data,
and its commands.

Both modes end in the same problems, the same line and the same map. A product
can start with findings and move one judge at a time to moments.

## LL4. Codecast can write the product's parts

The product-specific pieces are judges, moment extractors and event calls.
Whichever side runs them, codecast's coding sessions can write and improve
them, with full access to the product's repo, its read-only data and its tools:

- **Set up judging.** For a new project, one session drafts the expectations, judges and (for moments) extractors. It runs them on yesterday's data and brings one card: here's what it would have found, here's what it costs.
- **Improve a judge.** When a finding is marked wrong, a short diagnosis asks one question: was the needed fact missing from what the judge saw, or present and misread? That opens a problem against the judge or the extractor. The line fixes it like any change: the wrong cases become its test, it runs evals before and after, and you get one card.

In "bring findings" mode the judge lives in the product's repo, and the change
is an ordinary product change made by a codecast session. In "bring moments"
mode it lives in codecast. Either way, the loop improves its own senses.

## LL5. Phases for Union

1. **Union brings findings.** AgentWatch keeps judging and grouping. Each AgentWatch issue is one codecast problem, by its id. When Union merges or splits issues, codecast follows.

   Union deletes everything that duplicated the work record:
   - attempts and claims;
   - the planner and campaign switch;
   - the bind, stamp, finish, rule and release scripts.

   Codecast's start switch decides when problems start, per project. Wrong findings open problems against the AgentWatch judge, fixed by codecast sessions in Union's repo.
2. **One judge moves to moments, in shadow.** Union emits events next to its comms judge. Codecast extracts, judges and compares, without filing anything, until it matches or beats AgentWatch.
3. **Judges move one at a time.** When a judge's shadow run matches or beats it, codecast's version takes over, and Union deletes its version of that judge.

## LL6. The words people see

Expectation, finding, problem, change, decision, outcome. "Signal", "cause",
"cluster" and "fingerprint" are plumbing and never appear in the product.

# Set up judging for {{project.name}}

{{focus}}

## Why this matters

Codecast's learning loop turns what happens in a product into problems it can
fix (https://github.com/codecast-sh/codecast/blob/main/docs/architecture/learning-loop.md).
Its senses are judges. A judge reads one thing that happened and says which of
the project's expectations it broke. It can only be as right as the
expectations it grades against and the facts it is shown: a missing
expectation means a miss nobody hears about, and a missing fact means a judge
that guesses. Every wrong finding costs a person's attention and every missed
one costs a customer. This session gives {{project.name}} ({{project.ref}})
senses a person can trust, and brings them one decision: whether to turn
them on.

You have the product's repository (this checkout), its read-only data and its
commands. Read before you draft. Nothing you write here goes live, ships, is
published or spends money before a person answers your card.

## Find how the product plugs in

A product plugs in one of two ways (learning-loop.md LL3), and which one
decides the work:

- **It brings findings.** The product already judges itself: judge prompts
  and the code that groups their findings live in its repository, and their
  findings reach codecast as problems. Then the work is reviewing those
  judges against the expectations and proposing changes to them as ordinary
  changes to the product, made the way its repository says changes are made.
- **It brings moments.** Nothing judges the product yet, or a judge is moving
  to codecast. Then the work is drafting the events, extractors and judges
  codecast runs.

Learn it from the record, not the names: the repository's
`.codecast/line.toml` and docs, `cast line profile`, `cast sources ls`,
`cast line moments ls`, `.codecast/judges/` and `.codecast/moments/`, and the
product's own judging code if it has any.

## Expectations first

A judge grades only against written expectations (`cast expectations show
--project {{project.ref}}`). Where a behavior the team clearly cares about has
no line, or a line is too vague for a judge to tell a miss from a pass,
propose the change through the expectations path: `cast expectations routine
--project {{project.ref}}` prints how sources are read, quoted and proposed.
Every line carries the words of the person who said it. Propose; never apply.

## Drafting, when the product brings moments

- **Events.** A moment is one thing a person on the other side lives through
  as a whole (a conversation, a call, an order), judged once on its newest
  state. Choose the few kinds where the product's behavior reaches people and
  can break an expectation. For each, find the place in the product's code
  where it happens and draft the one-line event it would post, without
  shipping it.
- **One extractor per kind** (`.codecast/moments/<kind>.ts`; `cast line
  judges try --help` shows both file shapes). It reads the product's read-only
  data and prints everything a judge needs to decide and nothing it does not:
  what each side said, when, through which channel, whether it was delivered,
  and the facts an expectation turns on (what was promised, what was due). A
  fact a judge must infer is a fact it will get wrong.
- **One judge per kind** (`.codecast/judges/<name>.md`: a header naming the
  moment kind and projects, then the prompt). The prompt says what good looks
  like for this kind of moment and what a person on the other side would feel
  as a miss. Codecast already gives every judge the clock, the expectations
  with their ids and the output format, so the prompt does not repeat them.
  Leave the mode at shadow.

## Reviewing, when the product brings findings

Read each judge with the expectations beside it. Look for expectations no
judge can see (the facts it needs are not in what it reads), judges that flag
things no expectation states, findings that do not name the expectation they
break, and the findings people dismissed or marked wrong. Each gap you find is
a change to the product's own judge or what it reads, drafted in the product's
repository.

## Try the drafts on real recent data

Run what you drafted on a sample of recent real cases, enough to see both
what it catches and how often it is wrong, with ordinary cases that went well
among them. Run an extractor with `bun` on an event on stdin. `cast line
judges try <judge> <moment.json>...` runs a judge exactly as codecast will,
on the team's model budget; when the budget is off it says so and names the
most one call can cost. For a product that judges itself, use its own way of
replaying a judge. Read every finding you get and say which you believe.

## The report and the card

The product's data can hold its customers' words. Refer to a case by its
reference and say in your own words what happened; never copy a customer's
message into the report, the card or anything codecast keeps.

Write a short report: what the judges would have found on the sample (how
many, against which expectations, how severe, the strongest few by
reference), which of those you doubt and why, what they would still miss, and
what judging costs per day (cases per day, read from the product's data,
times the cost of one case, with how you measured both).

Then bring one card (`cast decide`, the report as its context): Turn on
judging for {{project.name}}. Say exactly what turning on does here. For
moments: publish the drafts in shadow, where judges record what they find and
file nothing, and the monthly model budget that needs, which a team admin
sets in the team's settings (you never set it). For findings: the changes to
the product's judges, made as the product makes any change. Offer the honest
alternatives (turn on part of it, or not yet and what is missing), then stop
and wait for the answer.

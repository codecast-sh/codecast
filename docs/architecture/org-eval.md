# Evaluating the org system end to end

Written 2026-09-20 from the founder's question: "Are you iterating the
prompting and system by running our org update through the new system and
evaluating the output suggestion, both in terms of the actual suggestion and
how it is presented to the user in conversation and UI? That is what you
should ground all of your changes in." Until now the dry runs were graded
mostly on the letter's writing. This is the loop that grades the whole thing.

## The loop

One round: build the ground truth once per workspace; run the analyzer on
the workspace's saved inputs through `packages/cli/scripts/prompt-dry-run.ts`
(never a bare `claude -p`); check the spec; render the proposal on the real
proposal page (the DEV preview mounted on the run's proposal JSON, in the
founder's Chrome, desktop and phone width); grade substance and presentation
against the rubric below; write the round to `~/.cache/org-eval/<workspace>/
round-N/` (inputs hash, prompt hash, proposal.json, captures, grades,
the three worst things); change the prompt or the page at the site that
caused the worst thing; run again. A change is kept only when the next
round's grades say it helped and nothing else fell. Three samples per
prompt variant before believing a difference, because runs vary.

Init and update are both graded. Update is a second run whose served inputs
are the first run's inputs with its proposal applied (and, once S21 lands,
a real apply and undo on a scratch workspace): a good update proposes
little, never proposes again what was just accepted, and notices what
changed since.

## Ground truth, built by reading, not by the analyzer

For the workspace under test (Union first): every project with work planned
or in progress and who actually works in it (commits and sessions of the
last 30 days, by person); the long running sessions that behave as roles
(age, helper sessions, routines, pinned purpose) with a judgement for each:
name it or not, and why; the initiatives and whether each has an owner; the
work that happens outside any project; a sample of 30 stale looking records
read on their own pages and labelled by hand (landed, stalled, never
started, alive). This is written once to `ground-truth.md` with the evidence
beside each line, and corrected when a round shows it was wrong.

## Substance rubric (each 0 to 3, with the evidence)

1. Coverage: every project with work has a lead after the proposal, or a
   stated reason it does not. Leads wrap the projects that exist.
2. Shape: about one role per project; every departure has a reason a
   person would accept; no role whose area nobody works in; no two roles
   on one area without saying who leads.
3. Named sessions: the sessions ground truth says are roles are named, with
   their seat, their own reporting line kept, a scope from what they
   touched; none named that ground truth says is a finished job.
4. Records: precision on the hand labelled sample (a record closed that was
   alive is the worst error a proposal can make), and recall on the stale
   ones.
5. Initiatives: read as the top of the tree; an ownerless one is the first
   finding; owners proposed are the people or roles who drive that work.
6. Sizing: daily limits follow the measured load of the area, and the cost
   line compares with today in one sentence a person can picture.
7. Stability: three runs on the same inputs agree on the asks; where they
   differ, the difference is judgement the letter explains, not noise.
8. Update: the second run proposes nothing already accepted and finds what
   changed.

## Presentation rubric (each 0 to 3, with the capture)

1. The ten second read: a person who has never seen the feature reads the
   bubble and says what is asked, what it changes, and what to press.
2. Asks: titles read cold, why is one sentence, effect names what the person
   will notice; the counts on the cards match the rows inside.
3. No internal word on the first screen, and one word for one thing across
   the letter, the cards, the rows and the chart's ghosts.
4. The fold: opening an ask shows rows a person can decide one at a time,
   each a sentence, with evidence that opens.
5. The conversation: a question about one ask gets an answer in plain words
   that uses the evidence, a revise updates the card under the reader, and
   the refusal after a revise is understood (S18, ct-52787).
6. The chart behind the page: ghosts, leads and named sessions are where
   the letter says they are.
7. Phone: the same, at 390 wide.

## Done

The loop stops when every line is 2 or better across three consecutive
samples, no record in the labelled sample is closed wrongly, and a person
who did not build this (a cold reader session) reads the final proposal on
the real page and passes the S19 test. The result goes to the founder as one
page: the final proposal as rendered, the grades by round, what changed each
round and why, and what is still weak.

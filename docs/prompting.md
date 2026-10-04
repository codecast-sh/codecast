# Prompting standard

Every prompt this product ships, and every prompt a node on the line runs,
follows this standard. A change to a prompt is a change to behavior, and it
ships the way a code change does: proven broken, rewritten, proven fixed
(docs/architecture/the-line-end-to-end.md LE8). Sections are numbered P1 onward so a review can
cite them. The prompting principles in docs/principles.md (PR-prompt-1 to
PR-prompt-3) are the source of the rules here, and P11 carries the rule on
correcting a tendency toward balance; this file is how they apply to a prompt.

## P1. A prompt states intent, not a script

Start from the highest principle that produces the behavior: what the reader
is for, what a good outcome looks like, and why. Escalate to a more directive
instruction only when a measured run shows the principle failing, and say at
that site what the instruction protects.

- Name the reader's job and the person it serves before any rule.
- Give the reason with the rule. A model that knows why generalizes to the
  case the rule did not name.
- Do not script phrasing or put words in the model's mouth. Describe the
  quality of the output instead (short, plain, cites the line it read).
- Write the smallest self-contained set of principles that produces the
  behavior: the intent, why it matters, and its exceptions. Forms, rigid
  structure and spelled-out mechanics of tools the reader already knows
  bury the intent; a conversational reader also needs room to converse.

## P2. One prompt, one decision

A prompt that scores, extracts and classifies in one call is three prompts.
Split until each call makes one decision with one output shape, so each can be
evaluated, replayed and improved on its own. A call that returns JSON states
the schema once, with what each field means and the value to use when unsure.

## P3. Examples are a last resort

Examples anchor. Use one only when the behavior cannot be conveyed by a
principle, keep it far from the likely inputs, and prefer a contrast (this,
not that) over a single model answer. Never paste a production failure into a
prompt as an example of what not to do: fix the instruction that produced it.
A lesson an eval taught enters the prompt as the general principle behind it,
not as the case that taught it.

## P4. Write it clean

A revised prompt reads as if it had always said what it says now. It never
mentions what was removed, never says "no longer", never carries a dated
changelog. History lives in git and in the eval run sets.

## P5. Fix behavior where it is caused

A bad output means the prompt holds an instruction that causes it, or lacks
one that covers it. Find that instruction and rewrite it at its own site.

Never add, around a model call:

- a deterministic guard or post-hoc filter that catches what the prompt got
  wrong,
- a retry loop that hopes for a better draw,
- an auxiliary model call that checks the first one.

The one mechanism allowed outside the prompt is conditional context
injection (emphasis added at a specific point in the run), and only after a
prompt rewrite was tried and measured.

## P6. Facts, not adjectives

Give the model the facts it needs (who, what state, which numbers, what was
already done) in a stable, labeled block, and keep instructions separate from
data. Untrusted text (a user message, a signal, a web page) is fenced and
named as data; it never carries authority.

## P7. Scope what the model sees

A node reads only what its decision needs. A reviewer sees the task, the
criteria and the diff, not the builder's reasoning. A judge sees the reply and
the expected behavior, not the prompt that produced it. Smaller context is
cheaper, faster and harder to fool.

## P8. Shared text has one home

Text that two prompts need (a policy, a vocabulary, a lifecycle) lives in one
partial and both render it. A lifecycle described in a prompt and again in a
UI string will drift; render both from the same source.

## P9. Prove it: the eval protocol for a prompt change

1. **Freeze the miss.** Turn the real moments where the prompt failed into
   freezes, each with one judge sentence stating the behavior a correct reply
   shows. Add two or three moments where the prompt already behaves well, as
   regression guards.
2. **Show it red.** Replay the freezes on the current prompt, five reps each
   on a call surface and eight on an agent surface. The miss freezes must fail. If they pass, the bug is not in this prompt:
   stop and find where it is.
3. **Rewrite at the site** (P5), clean (P4).
4. **Show it green.** Replay the same freezes on the new prompt, at the same
   rep count. Ship only when the miss freezes pass, every guard still passes, no
   gate fails in any rep, and no surface is `separated: worse`.
5. **Show the difference.** The card carries at most three before/after pairs:
   the input, the old reply, the new reply, and the judge's note.

The freezes and judges are the bar, not the obstacle: a red eval goes green
by changing the prompt, never by loosening a judge or dropping a freeze.
Before calling one model worse than another at a job, tune the prompt for
that model and read both models' outputs side by side; a prompt written for
one model measures the prompt, not the other model.

Claims of improvement need `separated: better` from `./evals check` (a one
sided Mann-Whitney at p <= 0.05, with five or more reps a side on a call
surface and eight on an agent surface; docs/architecture/evals.md). "Looks
better on two draws" is not evidence.

## P10. Context the reader can reason over

What a node or an agent reads is part of its prompt, and it is judged the
same way: does the reader get what its decision needs, in a form it can
reason over?

- Long history goes in as a faithful condensation built from the full
  sources, with stable ids and a tool to open any original. A crude
  truncation or a hand-cut window hides exactly the detail that mattered.
- Facts carry their dates, and the reader knows the current time and how
  long it has been since the last activity, so it can judge freshness.
- Every source that bears on the decision is in (chat, calls, linked work,
  images); everything else stays out (P7).
- A continuing session already holds its role and standing instructions. A
  wake carries what changed, not the role again. Guidance that applies only
  in a situation arrives in tool output at the moment it applies, not in the
  standing prompt.

## P11. Correct toward balance

A prompt change that fixes a tendency often swings to the opposite failure.
The target is the balanced behavior, not the reverse of the miss.

- Understand why the current prompt produces the tendency before changing
  it, and make the smallest change that fixes it.
- Judge it on varied scenarios and personas, including ones where the old
  behavior was right, with enough samples to tell the variants apart (P9).
- When outputs keep missing round after round, simplify the prompt rather
  than add to it. Accumulated rules contradict each other and the model
  follows the loudest one.

## P12. Review checklist

A reviewer of a prompt change answers each, pass or fail with one line:

1. Does the rewrite sit at the instruction that caused the miss (P5)?
2. Does it state intent and reason before rules (P1)?
3. Does each call still make one decision (P2)?
4. Are new examples justified and non-anchoring (P3)?
5. Does it read clean, with no history (P4)?
6. Is shared text rendered from its one home (P8)?
7. Is there red, then green, on the same freezes, with guards, and no
   loosened judge (P9)?
8. Does the reader get what its decision needs, condensed and dated, with
   nothing resent on a wake (P10)?
9. Does the change aim at the balanced behavior, smallest change first, and
   not the opposite failure (P11)?

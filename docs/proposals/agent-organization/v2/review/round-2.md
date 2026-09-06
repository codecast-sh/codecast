# Review round two, 5 September 2026

Four critics read the revised draft: product, safety and cost, the agent's side, and visual design. Two hit the account's session limit and retried; all four returned. Findings were judged by the author against the code and the text. The full return is in workflow journal `wf_0317e89a-a8a`.

## Changes made

- **One story for the sample decision.** The mockups told four incompatible stories about cd-1042. Now: the Sync reliability lead recommended at 07:55, the Codecast lead answered at 08:02 under a retry grant it earned earlier from cd-0871 and cd-0902, the plan brief and the workspace brief list it under handled, and the decision card shows a different, still open question (cd-1044) with the recommendation in slot 2.
- **Decisions wake a lead at once.** A 5 minute hop deadline under a 5 minute coalescing window could never be met. Decision wakes now bypass the window like a human ask, bounded by an hourly wake cap of 12; the deadline counts from the wake; hops run in parallel. Chapter 8's table gained wake cap and batch lease rows.
- **Disagree and reopen.** The one key override became two controls: disagree records the override on every handled item; reopen, where it can act, puts the decision back with the human as holder and tells the worker, or reopens a closed task.
- **Human held decisions beyond the six classes.** Raising any limit is a policy revision and always human held; a question from a session a human started belongs to that human; a decision a lead asks for itself is held by the scope's responsible human, not the lead's host.
- **Honesty about stages one and two.** A worker on its host can act on a lead's answer. The defenses at those stages are named; bound approval arrives with stage three. The stage two exit audits option text for protected effects.
- **Caps before dollars.** The hire flow asks for a concurrency cap, a daily turn cap and an hourly wake cap at understand; the dollar budget is optional until direct unlocks. Estimates are labeled where the account is a subscription.
- **Safe mode for leads.** Stage one and two leads run in the trigger runner's existing safe mode, which removes edit tools and blocks push, commit and deploy, alongside the per session credential.
- **Server rules, not prompt rules.** A filing change from a role credential or the claimant session is refused; a close from a role credential needs a matching verdict; the server sets the default review policy from the diff.
- **Reviewer provisioning.** At direct stage the lead above provisions the independent reviewer against its own budget; otherwise the human control path. Recorded as a change from version one.
- **Per reader rendering closed.** The lead's conversation shares the brief's declared audience; cost totals are computed server side and never enter the model's context; scope note entries carry an audience; chat answers are built at the intersection of brief audience and channel membership.
- **Wake acknowledgment.** A batch id in the wake message, `cast org ack <batch> --defer`, a 15 minute batch lease, an event table and batch builder in front of the delivery function, which deduplicates but does not merge.
- **The lead's page.** Designed and drawn: standing brief editor, scope notes, grants with their cards and expiry, overrides with reasons, session history, pause, refresh, retire.
- **CLI corrections.** `cast summary` then `cast read 40:` instead of a flag that does not exist; `--author` and `--reports-to` marked new; `cast anchor create --scope`; `cast decide --class` as the one optional flag a worker may learn; `cast org reply` for asks; the tools list as one table by verb, stage and target.
- **Stall definition.** On work state plus last activity time and message count, both existing fields, not on a state revision that does not exist.
- **Design.** Callout padding restored; level glyph letters in dark text on bright fills; avatars darkened; the recommended option labeled rather than filled and never in a fixed slot; row layout with flexing names; app tables at 760px minimum with no mid word breaks; SVG figures at full size with a scroll hint and edge fade on phones; legend letters; phone rules for the mobile mockup; app bar wrapping at phone width.

## Findings not adopted

- Stack the ladder figure vertically under 720px. Not adopted for this version: the scroll region with a hint and fade is enough for a diagram whose caption carries the conclusion.
- Widen the tree pane further than 340px. Not adopted: names now wrap instead of truncating.

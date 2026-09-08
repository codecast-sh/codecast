# Three proposals for the agent organization, compared

Written 7 September 2026 by session jx74ksj, the author of version two, after reading the other two pages. Read it as one author's comparison checked against the documents, not as a neutral referee. Where draft three is stronger, this says so.

## Lineage

| Page | Author | Published | Views | What it is |
|---|---|---:|---:|---|
| [Agent Organization · Codecast](https://codecast.sh/a/d0vFfz4flyqj) | jx70p9m, tracked by jx72cr9 | 4 Sep | 40 | Version one. A control plane specification: roles, credentials, admission, budgets, decision routing, 32 failure cases, 16 implementation tasks. Plan pl-519, roadmap pl-529. |
| [Agent Organization v2](https://codecast.sh/a/ry98DnT8971a) | jx74ksj | 5 Sep | 14 | Version two, built on version one. The product design: briefs, the morning brief, the tree, trust granted from the decision card, hiring, the lead's page, health, mobile. 12 chapters, 8 mockups, two review rounds. Plan pl-544. |
| [An organization of agents](https://codecast.sh/a/aubDNdj6ufCe) | jx7anwb | 5 Sep | 28 | Draft three, written from first principles on Ashot's instruction to ignore the other two. Roles on the work graph, wake frames, an outbox, seats, altitudes, four phases. Two review rounds. Plan pl-545. |

Version one and version two are one lineage. Two keeps the contracts of one by reference and does not restate them. So the real choice is between two designs: the version one and two lineage, and draft three. Draft three was a deliberate independent attempt, which makes the agreement below evidence rather than coincidence.

## Where the two designs agree

Both arrive at the same core, independently.

- Roles hang on the existing work graph: workspace, project, plan. There is no second org chart.
- The anchor is the root role. Every other role is an anchor with a narrower scope and a parent.
- The brief is the role's memory and the session is disposable. A role restarts from its brief and the records.
- Facts are computed by the server, narrative is written by the agent, and every narrative line links to evidence.
- Sleep by default, wake on scope events, coalesce. A quiet scope costs nothing.
- Advise first. Authority starts empty. Escalate with a recommendation. Production, destructive and product decisions are never grantable.
- Reuse the rails. Wakes are pending messages, hands are spawns, reports are project updates, escalations are session decisions, briefs and charters are docs, identity is the anchor's bot user.
- Daily caps enforced from the first phase. Pause is a real gate.
- Chat mentions per role and channel binding. A line an agent typed never wakes anyone.
- A first phase that only advises, proven on this workspace before anything more.

That is most of the design. Choosing between the two is choosing between two treatments of one idea.

## Where they differ, and which is stronger

| Dimension | Version two | Draft three | Stronger |
|---|---|---|---|
| Decision delivery | A race. The human sees every decision at insertion. Leads recommend in parallel within a 5 minute hop deadline. A lead with a grant may answer first. | Phase 1 is escalate only: every hand decision passes through the lead, which must attach a recommendation and escalate. A routing deadline and a "with a lead" group let the human pull it early. Never grantable classes go to the person and the lead in parallel. | Version two. Draft three's phase 1 puts a lead's turn in front of the human on ordinary questions. Two of version two's own critics caught the same regression in its first draft and it was removed. Draft three's routing deadline softens it; the race removes it. |
| How trust grows | From the decision card, after 3 agreements from 2 askers on one class in one scope. 30 day expiry. After a grant: a "Handled without you" section with disagree and reopen, sampled cards, and two consecutive overrides revoke. | An authority list on the role row, edited by the host or an admin on the role page. A fixed category vocabulary. The hand proposes a category and the role confirms it. Agreement rate is a phase 4 number. | Version two. A permissions list asks the human to predict; the card asks them to confirm what they just saw. Draft three's fixed vocabulary and the confirm rule are worth keeping. |
| Wake mechanics | An event table, a batch builder, a batch id, `cast org ack` with defer, a 15 minute lease, a wake message with role, documents, events, decisions and asks. | A scope event collector in the change tracked write path, flushed once per mutation. An outbox table. A frame built as a query snapshot at flush time and stored on the pending row, because the rail confirms delivery by matching stored text. Passive facts that fold and never schedule. Facts as diffs after the first frame. Charter by hash. A frame size budget. Automatic restart on counted context tokens instead of compaction. | Draft three, clearly. It is engineered against the real delivery rail and names where the collector sits. Version two's wake sections should be replaced by it. |
| The brief | Six fixed sections. Per claim source and audience. Rendered per reader with coverage required. Versions and a diff since the reader last read. | A fact block computed on read beside a narrative. The first line is the state line. A digest posted to the project's Updates tab. | Both, merged. Draft three's computed fact block prevents drift. Version two's per claim audience and per reader rendering is a privacy property draft three lacks: its frames are read as the bot user, which bounds what the role sees but not what a wider audience then reads in the narrative. |
| Several humans | An owner per scope. Decisions climb to the asker's responsible human. "Needs you" beside "Needs Maya". | An owner set on the team anchor, default admins. One inbox row per person asked; the first answer resolves the rest. | Both, merged. Draft three's per person rows are the right storage. Version two's per reader brief is the right surface. |
| A person inside the org | Not designed. | Seats. A person holds a role, the standing session sleeps, and the person receives what the role would have. | Draft three. Adopt as is. |
| Independent review | A reviewer from a different delegation root. The server sets a default review policy from the diff. A close from a role needs a matching verdict. "Checked by the lead" is never "verified". | Named as the weakest part of its own design, then proposed from the factory research: a second hand on a different backend that sees only the branch and the criteria, two cycles, then a draft PR. | Version two has the contract; draft three's station is the concrete form of it. Merge. |
| Safety of the first phase | A per session role credential and a server allow list, plus the trigger runner's safe mode, before the first dogfood step. Today's token identifies a user, so a lead would otherwise hold its host's full authority. | Caps, role creation fenced to scope, a charter write fence, an actor resolver. Roles run on the host's account as the anchor does. The host token problem is not addressed. | Version two. |
| Cost unit | Turn and wake caps first. Dollars stay unpriced until version one's receipts exist. | Tokens, with a usage writer in Claude transcript sync in phase 1, an honest unknown for other backends, dollars later. | Draft three. It names the writer and the field. Adopt. |
| Rollout | Three stages gated by trust: understand, decide, direct. Measured exits, a baseline week, a dogfood order on this workspace. | Four phases with scenario acceptance tests and estimates of about three weeks each. | Comparable. Draft three's scenario tests read better than a threshold table. Version two's baseline week and trust gating are the right gate. Merge. |
| Surfaces | Morning brief, tree, decision card, chat, hire flow, the lead's page, health, mobile. 8 mockups verified on desktop and phone. | An org page with three altitudes, a role page, an inbox section, project header, chat, decision card, mobile. | Comparable. Version two's hire flow, health page and lead page are more complete. Draft three's altitude control is the better single interaction. |
| Words | lead, worker, brief, standing brief, ladder, grant, holder | role, hand, charter, brief, wake, escalation, altitude, seat | Taste. Draft three's nine words are tighter. "Hand" beats "worker" and "charter" beats "standing brief". |
| Outside research | None. | Warp Factories, Vercel Foreman, Factory.ai, OpenAI Symphony, with 8 ranked takeaways: stages as task statuses, review as a station, structured handoffs, a repo brain, charters mirrored to the repo, principal based approvals, outcome metrics, credential brokering. | Draft three. Additive to either base. |
| Failure modes | 12 product failures with defenses, on top of version one's 32. | 16 failures, each marked prevented or visible. | Both. The prevented versus visible column is worth adopting. |

## Recommendation

Use version two, with version one under it, as the base. The reason is the three rows where the difference is not taste: decision delivery, how trust grows, and the first phase's credential. Those are the places where a wrong choice costs the human latency or hands a lead more than it earned. Version two's answers there were hardened by two adversarial review rounds aimed at exactly those rows.

Fold five things from draft three into it, as version 2.1.

1. Its wake mechanics, whole: the scope event collector, the outbox, the frame stored at flush, passive facts, facts as diffs, the frame budget, automatic restart. These replace the rhythm and wake sections of version two chapter 8.
2. Seats.
3. The token usage writer in phase 1, and tokens as the first unit.
4. The computed fact block in the brief, beside the per reader narrative.
5. The factory research: review as a station on a different backend, stages as task statuses, a structured handoff at the end of every hand, charters mirrored to the repo.

And take its words where they are better: hand, charter, altitude, seat.

The cost is four chapters rewritten, mockups touched for seats and the altitude control, and one review round. A few hours of one session.

The honest case for the other choice. Draft three is one document of about 12,000 words that stands alone. The version one and two lineage is two documents of about 44,000 words. If compactness matters more than the three rows above, draft three is the base and those three rows are folded the other way. That fold is harder, because the race and the card grants sit at the center of draft three's routing and role page.

## What the founder decides

1. Which base. Recommended: version two on version one.
2. Who merges. Session jx7anwb was told to ignore the other two documents, and only Ashot can lift that. Session jx74ksj, which wrote this comparison, is under no such rule and can do the merge from it.
3. Naming, and the taste choices both documents list for the founder. Three overlap: whether the anchor keeps its name, the coalescing default (version two says 5 minutes, draft three says 2), and tokens versus dollars.

Version one alone is not a candidate base. Version two already contains it by reference.

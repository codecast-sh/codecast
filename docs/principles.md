# Principles

How work in this repository is judged, by the people who build it and by the line that ships it. Each principle states what good looks like and why, and carries a stable id so a plan, a review or a lesson can cite it (`PR-code-2`). The prompt-writing standard that the prompting principles extend is docs/prompting.md, cited by P-section.

The principles are mined from the corrections people made to agents across the team's sessions: each one is a rule that was asked for more than once and checked against the sessions it came from. The line keeps them current (the-line-end-to-end.md LE12): the lessons harvest files a repeat of a principle under `lesson:<id>`, so it counts toward that principle's cause, and a new cluster proposes a new principle here.

The evidence line gives how many corrections asked for the principle and the sessions they came from.

## Product

### PR-product-1 Complete and integrated

Ship the whole requested scope as part of the product, not a slice beside it. A capability is done only when a user can find and use it where they would naturally look, on each platform the product serves. It plugs into the systems the product already has instead of standing alone, and its objects are addressable, so people and the product's own agent can link to them and act on them. A backend with no way to reach it, a CLI-only path, a mockup, or an outline is not done.

Why: Work was repeatedly delivered as partial slices, CLI-only capability, or standalone bolt-ons the owner could not use.

Evidence: 23 corrections across 19 sessions (`complete-and-integrated`): -Users-ashot/b22e7a56, mail/4a53ff52, codecast/290127df, codecast/902a9235, codecast/53dfd240, codecast/74f46999, codecast/27ac54c7, union-mobile/939092bf, union-mobile-outreach/6f18639e, -Users-ashot/0869f8ac, codecast/a4c2b17f, union-mobile-outreach/509b4b48, union-mobile-outreach/b8501299, bookmark/67e9d943, codecast/619d3d49, aurora/fc51b6ab, eaiden/512528df, mail/66bc2f86, mail/b76543a3.

### PR-product-2 Simple, reliable core first

Get the core working simply and reliably before adding sophistication. Choose the simplest mechanism that does what was asked at the scale asked, and add a piece only when it gives something the existing system does not. Favor fast, predictable core interactions over ambitious features, and default to permissive behavior that picks something sensible, with customization optional rather than required. Before calling it ready, check that the whole system hangs together and keeps its complexity out of the user's way.

Why: Over-built systems and pieces that duplicate existing capability keep failing at the basics the user actually needs.

Evidence: 13 corrections across 10 sessions (`simple-reliable-core-first`): union-mobile/jx7b88a, codecast/cfdabd0a, codecast/46820e4a, codecast/14f1a996, codecast/fb8e21ef, eaiden/8b623c64, union-mobile/jx7580p, codecast/jx77tbn, union-fundraising/jx79x1p, codecast/jx7e3j5.

### PR-product-3 Controls do what they say

Scoring and allocation follow real outcomes and the operator's intent. Rank with continuous scores built from observed results, not binary gates or neutral defaults, and trust a signal only once it has enough data behind it. Put most of the effort into what works and keep enough exploration to find what might work better. A control does exactly what its label says. Add no hidden caps, built-in conservatism or fixed throttles unless a real constraint calls for one, and name that constraint where the limit is set.

Why: Binary gates, neutral baselines and scattered caps made the system spread effort evenly and ignore the operator's intent.

Evidence: 10 corrections across 3 sessions (`controls-do-what-they-say`): union-mobile-outreach/281e2ac7, union-mobile/0890df87, union-mobile/bcfdb6e9.

### PR-product-4 Never harm live work or people

Changes and automation do not harm live work or real people. Before acting on running systems, tell a session that is waiting apart from one that is dead, keep backfills and imports from looking like new activity, leave the human's screen and focus alone, make irreversible actions hard to trigger by accident, roll out migrations to every client version still deployed, and halt suspect outbound contact before investigating it.

Why: Harm to a live session, a user's screen or another person cannot be undone by a later fix.

Evidence: 9 corrections across 8 sessions (`never-harm-live-work-or-people`): codecast/52d95fcf, codecast/81fa353e, codecast/19bfa707, codecast/e7b2cf97, codecast/1582c431, codecast/6faa44cb, union-mobile-outreach/f558620d, codecast/71261eae.

### PR-product-5 Defaults just work

Defaults make a feature work the first time and never lose what the user already gave it. Start from the choices and setup they already made, keep anything they typed until they throw it away, keep every client current without asking them to update, and do not assume one account per service. When something they pointed at no longer exists, say so and offer a way to recover.

Why: A feature that fails quietly or forgets the user's state looks broken, even when the code behind it is correct.

Evidence: 8 corrections across 7 sessions (`defaults-just-work`): codecast/5cd65a63, codecast/c64919c4, codecast/106d22b7, codecast/f8e404e4, -Users-ashot/b22e7a56, codecast/c8c6771d, codecast/36878dea.

### PR-product-6 Concepts mean what they say

Every user-facing concept does what its name plainly says. Defaults come from what the user said they want, not from a guess, and the system never moves a user's work based on what it infers. When a different use case needs other behavior, offer it as an explicit option instead of bending the concept.

Why: Users trust the UI only while its words match what it does.

Evidence: 7 corrections across 6 sessions (`concepts-mean-what-they-say`): codecast/8e292690, codecast/de3cfba6, codecast/81ef8363, union-mobile/a1803f62, codecast/jx7csbd, union-mobile/jx7b88a.

### PR-product-7 Choices show their consequences

Where a person makes a choice in the product, put what they need to decide right next to the control, with room to read it, shaped around the case they most often face. When an action changes structure, carry its effects all the way through (dependent state updates, affected agents are told) and show those effects to the person.

Why: People cannot choose well, or trust a choice, when its effects are hidden or happen elsewhere.

Evidence: 7 corrections across 4 sessions (`decisions-show-their-consequences`): codecast/80ff6c03, codecast/81ef8363, union-mobile/jx7a7ch, codecast/fb8e21ef.

### PR-product-8 Judge cost by what scales

Judge cost by what scales. Split fixed from variable cost and reason about the marginal cost per unit of volume, because a blended total hides whether the system still works at 10x or 100x. Put routine automated work on the cheapest model that does it well. When a design's cost is large against its budget, propose a cheaper variant that keeps the benefit before building it.

Why: Blended cost numbers and premium models on routine jobs hide whether the system works at scale.

Evidence: 5 corrections across 5 sessions (`marginal-cost-awareness`): union-mobile-outreach-backend/d98a708c, -Users-ashot-src/421e971d, union-mobile/0890df87, -Users-ashot-src/c71b7cc8, union-mobile/469fd3c9.

### PR-product-9 Keep bespoke work productizable

When building something bespoke for one user or team, keep what you learn separable from their specifics, so it can ship as reusable product (a template, a hireable role, an optional snippet) instead of being rebuilt for the next user.

Why: Work that stays bespoke has to be rebuilt for every next user.

Evidence: 3 corrections across 3 sessions (`generalize-into-reusable-templates`): platform/6f577d34, union-mobile/4e7c1c64, codecast/jx7162g.

## Code

### PR-code-1 One mechanism, one codepath

Before building, find the system that already does the job and extend it. Every variant of an action goes through one shared codepath, and new behavior builds on existing primitives instead of a parallel copy. Policy that applies across paths is enforced once, at the point all of them pass through. Results come from the general mechanism, not from per-case code or hardcoded outputs. When a mechanism replaces an old one, delete the old one.

Why: Parallel paths drift apart, and each copy fails in its own way.

Evidence: 40 corrections across 28 sessions (`one-mechanism-one-codepath`): -Users-ashot/b22e7a56, union-mobile/939092bf, union-mobile/0890df87, codecast/ed999385, codecast/a5b1a2fc, union-mobile-outreach/6f18639e, union-mobile-outreach/85b15576, codecast/a3dd2256, union-mobile/a9e7343d, platform/70c3cbc8, codecast/b8189b1a, union-mobile/bcfdb6e9, codecast/044a5a51, codecast/7dbfa844, codecast/jx71mm7, codecast/jx79ech, union-mobile/7551c3e8, codecast/5996141c, codecast/jx7ab41, codecast/fb8e21ef, codecast/jx7csbd, codecast/4b84ce1d, union-mobile/jx7a7ch, codecast/29e4db36, union-mobile-outreach/b82f0a83, codecast/0ac05029, codecast/2cda322f, codecast/jx7f403.

### PR-code-2 Fix the cause so it cannot recur

When something breaks, trace it to the mechanism that produced it and change that mechanism so the failure cannot recur and the system recovers on its own; then repair the data the bug already damaged. A one-off cleanup, a retry, loosening a correct rule downstream, or another patch at the surface is not a fix. When patches pile up on one component, find out why the earlier fixes failed and redesign it at a higher level. Blame the environment only with evidence: if a comparable tool works under the same conditions, the cause is in your code.

Why: Surface patches and one-off repairs let the same failures return, and the owner repeatedly found agents building on top of something fundamentally broken.

Evidence: 34 corrections across 23 sessions (`fix-the-cause-so-it-cannot-recur`): union-mobile-outreach/281e2ac7, codecast/bd3a20e0, codecast/eac20021, codecast/71261eae, codecast/714707a5, union-mobile/dcb2cd5b, union-mobile-outreach-backend/d98a708c, union-mobile/0890df87, codecast/a5b1a2fc, -Users-ashot/b22e7a56, union-mobile-outreach/4ae73c82, union-mobile/a1803f62, -Users-ashot--codecast/b6168064, codecast/jx77ps4, codecast/jx729jd, codecast/jx7ex0x, codecast/81fa353e, codecast/9f5f5126, codecast/6c146c5e, codecast/6d66a45e, union-mobile/jx7b88a, codecast/jx7b4ff, union-mobile/ef6841cf.

### PR-code-3 Self-healing systems, visible failure

When a result keeps needing manual intervention or a workaround, change the system so it produces that result on its own. Tools and infrastructure that people depend on recover by themselves from conditions you know about, and detect stuck states and report them. When something does fail, the UI says so plainly, stays up long enough to read, and puts the recovery action next to the message. Long operations show progress and end with a clear result. A flow that cannot finish without the user becomes a guided step in the product, not an instruction in the docs.

Why: Manual one-offs, silent spinners and fragile daemons push ongoing work and support back onto the owner.

Evidence: 21 corrections across 16 sessions (`self-healing-and-visible-failure`): union-mobile-outreach/281e2ac7, codecast/738de269, codecast/6d66a45e, codecast/0f33215d, codecast/204dc98c, codecast/c8c6771d, codecast/616fbff1, codecast/jx7162g, codecast/jx79098, codecast/jx7e9av, codecast/b7e8002b, codecast/jx73zke, codecast/c3f8856c, bookmark/67e9d943, codecast/91cd1654, aurora/fc51b6ab.

### PR-code-4 Fix the class, not the instance

Treat a reported defect as one example of a class. Fix it at the shared source, then find and fix every other place with the same defect, without waiting to be shown each one. Keep the sweep to that defect class: it does not license unrelated changes.

Why: Fixing only the instance shown leaves its siblings broken and makes the human file each one by hand.

Evidence: 12 corrections across 10 sessions (`fix-the-class-not-the-instance`): codecast/699d5248, codecast/jx76124, union-mobile/jx7016r, codecast/cfdabd0a, codecast/619d3d49, codecast/b06ea6c5, codecast/872d70ac, union-mobile/bcfdb6e9, union-mobile/b41bf2b5, codecast/b2ada11b.

### PR-code-5 Prove before you spread

Changes to shared infrastructure, migrations and known-fragile areas are finished in full but rolled out conservatively. Try one instance before the fleet, show with integration and stress tests that nothing regresses and that every client converges to the same state, and keep sessions isolated so one cannot break another. Any job that writes state is idempotent: a rerun updates what it already created and writes nothing when nothing changed.

Why: These changes reach every user and session at once, so a regression is broad and hard to unwind.

Evidence: 11 corrections across 10 sessions (`careful-with-shared-and-fragile`): codecast/9a114468, codecast/724d7618, codecast/57cdbdc9, codecast/30f7f14e, -Users-ashot-src/dcb2ee9a, codecast/616fbff1, union-mobile/bcfdb6e9, union-mobile-outreach/5adcd1a2, union-mobile-outreach/281e2ac7, union-mobile/jx74111.

### PR-code-6 User input is never lost or reordered

What a person sends or starts (a message, an upload, a call they joined) shows up at once, finishes in the background if it is still pending, keeps its true order, and is never lost, duplicated or silently dropped. Model the state so a lost, hidden or out-of-order action cannot be represented.

Why: Losing or scrambling what a person did destroys trust faster than any other bug.

Evidence: 7 corrections across 6 sessions (`user-input-never-lost-or-reordered`): codecast/2907ac83, codecast/3d59bf6c, codecast/6d17a0fa, codecast/638ee419, codecast/jx7c3x7, codecast/be5f2068.

### PR-code-7 One home per fact

Every fact, setting and piece of state has exactly one home: data in one store key, configuration in one versioned file in the repo, and a UI mode as one model rendered in different states. Everything else derives from that home at read time. Never keep a second writable copy in sync by writing to both.

Why: Copies drift as soon as two writers disagree, and each drift then needs its own reconciler.

Evidence: 5 corrections across 5 sessions (`one-home-per-fact`): codecast/6faa44cb, codecast/jx74z5d, vello/d4dab4d0, codecast/c26c9845, codecast/jx75vha.

### PR-code-8 Cut load at its source

When work contends for a shared resource, remove the waste at its source: share one instance instead of running a copy per session, and batch queued work instead of repeating it. Do not add gates that ration duplicated work.

Why: Rationing duplicated work keeps the waste and adds a new way to fail.

Evidence: 3 corrections across 3 sessions (`share-resources-fix-load-at-source`): codecast/6d66a45e, codecast/1adfe699, codecast/1b910ce2.

## Design

### PR-design-1 Lead with the essence

A surface leads with the essence of what is happening for the person who uses it: a calm summary with few elements and few numbers, where every item earns its place and each fact appears once. Collapse or drop low-value and repetitive events, and keep internal machinery out of view. Put detail behind progressive disclosure that drills from the summary down to the raw records. If a design is confusing at its core, rethink it from the top rather than patching it, because tweaks leave the underlying model as it was.

Why: Operator pages repeatedly came back both overloaded and uninformative, and patching them did not fix the underlying model.

Evidence: 52 corrections across 26 sessions (`essence-first-surfaces`): union-mobile-outreach/281e2ac7, union-mobile/3a9a43dd, mail/f697df4e, mail/4521d6f2, mail/27c9bbb2, family/9d308f48, codecast/466dbf0a, codecast/2a0909a7, codecast/916135f7, union-mobile/52e3266a, union-mobile/jx7b88a, codecast/fb8e21ef, codecast/jx7csbd, codecast/c26c9845, codecast/db2088f5, union-mobile-outreach/ed62e218, codecast/jx76jc2, codecast/be5f2068, codecast/13238939, codecast/4a0f40fd, codecast/56715870, codecast/jx75bq6, codecast/2a449dd0, codecast/a268e4ac, codecast/3c40c83d, codecast/jx78q70.

### PR-design-2 Restrained and distinctive

Aim for visuals that are restrained and distinctive at once. Work inside the existing design and brand system with a tight scale of sizes, weights and colors; use color for meaning, not decoration; keep contrast readable; and hold everyday components to the same polish as the showcase surfaces. Within that restraint, commit to one coherent idea, render it with real craft and subtle motion, and refine it over many iterations rather than piling on effects. When depicting the product, show the real thing at its most interesting moment.

Why: Output swung between plain defaults and busy over-decoration; clutter, loud accents and familiar AI design tells read as unconsidered.

Evidence: 47 corrections across 30 sessions (`distinctive-restrained-visuals`): -Users-ashot/b22e7a56, family/52130ad8, family/037d4ff6, codecast/8407196b, codecast/0f33215d, union-mobile/0859d2b3, union-mobile/96cc4996, -Users-ashot/0869f8ac, codecast/479a0529, codecast/357dc99a, family/9d308f48, codecast/8c9aae26, codecast/jx78q70, codecast/jx7evm9, codecast/377c6024, union-mobile/2621cefb, union-mobile/99aaba5b, union-mobile/7868a451, codecast/51208eea, codecast/0da5df14, codecast/c26c9845, codecast/f9b2d254, codecast/c1273b38, codecast/be5f2068, codecast/b2ada11b, codecast/c8f6942d, codecast/jx7acve, codecast/jx7dmqa, family/jx7523m, union-fundraising/jx79x1p.

### PR-design-3 Clear feedback, stable layout

Interactions never leave the user guessing or surprise them. Every action gets immediate, visible feedback. The layout holds still: opening, hovering, expanding or a status update never shifts content, moves the window or scrolls the reader. Primary actions are easy to find and look the same everywhere they appear. Overlays close in an obvious way. Selection and drop targets are impossible to miss, and controls keep strong contrast and generous hit areas. The app changes mode, surface or route only when the user asks, and standard OS keys work as expected. Walk through every state and transition before building.

Why: Hidden actions, jumping layouts, silent states and unexpected mode switches made features feel broken even when they worked.

Evidence: 32 corrections across 24 sessions (`interaction-clarity-and-stability`): codecast/5cd65a63, codecast/8a5da82a, codecast/356f3371, codecast/2622f9a4, codecast/f388ef97, codecast/d78076a5, codecast/7603dece, union-mobile/96cc4996, codecast/bae26244, codecast/357dc99a, codecast/d0e1b2a5, codecast/d1b0172a, union-mobile-outreach/afd41522, codecast/fcfb7767, codecast/6b76b81e, codecast/57e10167, codecast/3d3a114d, codecast/ba3755d7, codecast/23b202ab, codecast/26856fb1, codecast/377c6024, codecast/9924c5e6, codecast/03d88c38, codecast/2912b750.

### PR-design-4 Same object, same rendering

Each object has one canonical page and one rendering, and every reference to it, from any surface, opens that page and looks the same. Show people and objects by their human name with consistent identity cues, never a raw id, and link the name to its page. Show who authored every entry. A state like pending looks the same everywhere it appears. A name mirrored from an external system matches the source exactly and carries a small mark naming that source.

Why: When the same thing renders differently, or a reference leads nowhere, people read one object as several and cannot find their way through the product.

Evidence: 20 corrections across 17 sessions (`same-object-same-rendering`): union-mobile-outreach/281e2ac7, union-mobile-outreach/b8501299, union-mobile/a9e7343d, aurora/34768c39, codecast/a893dea2, family/9d308f48, codecast/fb8e21ef, codecast/jx7csbd, union-mobile/7551c3e8, codecast/58d03e78, codecast/5de96742, codecast/9a39ebc7, codecast/jx72em9, codecast/jx72r3w, codecast/c26c9845, codecast/4b84ce1d, codecast/ba4a0a63.

### PR-design-5 One scroller, content first

Give the space to what people read. Each view has one scroll, the page's own: no scroll panes nested inside it and no frames inside frames, so containers grow to fit their content. Chrome earns its space: empty panels stay closed, secondary helpers fold away, rare actions get small controls, and on a narrow screen a side panel becomes a full-screen view with a way back.

Why: Nested scrolls and permanent chrome fight the browser and waste the space the content needs.

Evidence: 16 corrections across 13 sessions (`one-scroller-content-first`): codecast/e264cab9, codecast/619d3d49, codecast/52563eab, codecast/05bc9938, codecast/jx77j0w, codecast/jx73063, codecast/jx74ybv, codecast/db1f2407, codecast/1fe7e745, codecast/a5d9cd23, codecast/56a4bba2, codecast/23b202ab, codecast/db2088f5.

### PR-design-6 Design for the real audience

Design for the specific person who will use it and the goal they have, not a generic user. Reason from first principles about what they need, cut everything they cannot use, and hold one coherent style that the available tools can actually produce well. When presenting the product, lead with its core value at its full scope rather than one narrow feature.

Why: Designs aimed at a generic or wrong audience add fluff the real user cannot use.

Evidence: 11 corrections across 9 sessions (`design-for-the-real-audience`): family/61d8c471, aurora/fc51b6ab, union-mobile/ca5ddcd0, union-mobile/99aaba5b, union-mobile/2621cefb, mail/b76543a3, codecast/c3983bfb, codecast/jx78q70, union-mobile/0859d2b3.

## Copy

### PR-copy-1 Copy that explains itself

Every label, status, button and generated sentence a user reads makes sense on first read, without the surrounding context. Give each concept one plain name and use it everywhere, and do not invent terms that need a glossary. A button or label names exactly what it does. Generated copy is self-contained, because readers often see it cold. Write in a reserved, concrete, factual voice that suits the medium, the audience and the surrounding flow, with no sales tone or grand claims.

Why: Invented terms, ambiguous buttons and salesy copy made the owner ask what things meant, read as machine-written, and got rewritten line by line.

Evidence: 23 corrections across 11 sessions (`self-explanatory-copy`): union-mobile-outreach/281e2ac7, codecast/2a990522, family/9d308f48, aurora/34768c39, family/52130ad8, family/037d4ff6, union-mobile/96cc4996, codecast/a893dea2, union-fundraising/jx79x1p, personal/jx736q0, union-fundraising/jx7bs72.

## Process

### PR-process-1 Polish past the first good version

When work first feels finished, treat that as the start of the final mile. Hunt for the bugs and regressions it could cause, then make deliberate passes that each find and validate concrete improvements in correctness, clarity, detail, speed and reliability, until a pass turns up nothing worth changing. Scale the number of passes to the stakes. The first version that seems good enough rarely is, and the human should not have to ask for more.

Why: The owner repeatedly had to demand more iteration because work was returned at its first acceptable version.

Evidence: 51 corrections across 36 sessions (`final-mile-polish-rounds`): codecast/790a2342, -Users-ashot/3d89f116, -Users-ashot/b22e7a56, codecast/5cd65a63, union-mobile-outreach/b8501299, mail/4a53ff52, codecast/902a9235, union-mobile/3a9a43dd, codecast/d0e1b2a5, codecast/8b86a4df, union-mobile/0859d2b3, codecast/a893dea2, codecast/27ac54c7, union-mobile/96cc4996, family/52130ad8, mail/27c9bbb2, union-mobile-outreach/281e2ac7, codecast/a2f48cf2, codecast/fb8e21ef, codecast/51edf9a8, codecast/c26c9845, union-mobile/2621cefb, union-mobile/99aaba5b, union-mobile-outreach/79d8465e, aurora/fc51b6ab, family/0ba3e541, codecast/872d70ac, codecast/jx7csbd, union-mobile/jx7fchg, codecast/1f6146fa, codecast/d0c39b7b, codecast/jx7cv0h, codecast/jx7dqvy, codecast/jx7crht, codecast/jx7266j, codecast/jx7djk3.

### PR-process-2 Own the outcome, not the task

Own the outcome, not the task. Write the goal and how you will know it is met where later runs will see it, including the recurring trigger when the work spans runs. When the outcome is not happening, keep digging into why. Do every step you can do yourself (browser, operational, diagnostic, finishing the items you listed as open), fix the problems in your way without waiting to be asked, and keep working through usage limits. When the next step waits on time or an event, arm the trigger that will wake you. Go back to the human only for what only they can give, and for the decisions the decide rules reserve for them.

Why: Agents treated work as isolated fixes, handed steps back, or stalled at blockers, so the goal the owner cared about never moved.

Evidence: 37 corrections across 25 sessions (`own-the-outcome-doggedly`): union-mobile-outreach/281e2ac7, union-mobile-outreach/85b15576, -Users-ashot/3d89f116, union-mobile-outreach/65e45a18, codecast/53dfd240, codecast/a893dea2, union-mobile/cacbf3c8, codecast/a2f48cf2, codecast/083b007c, union-mobile-outreach/afd41522, aurora/34768c39, -Users-ashot/95306fa0, union-mobile/jx7b88a, codecast/fb8e21ef, aurora/fc51b6ab, mail/b76543a3, codecast/jx75d3z, codecast/jx7etp0, codecast/jx74a40, union-mobile/jx7d5py, family/9d308f48, codecast/a8f5994d, -Users-ashot/b22e7a56, union-mobile/bb47b784, family/0ba3e541.

### PR-process-3 Ground in current evidence

Ground every proposal, build and claim in current evidence, not memory or assumption: the code as it stands, what is actually being worked on and committed, real data, the features and prior sessions already in the area, the spec or research the work came from, and authoritative sources instead of estimates. Plans and task lists go stale, so check them against the code before trusting them. Verify a limitation, or your own environment, before designing around it or reporting it as a blocker. Re-check state right before an irreversible change.

Why: Agents proposed mechanisms that already existed, contradicted shipped work, trusted stale plans, or asserted false limits without checking.

Evidence: 29 corrections across 23 sessions (`ground-before-building`): platform/70c3cbc8, codecast/b8189b1a, union-mobile/0890df87, codecast/a0e831e8, -Users-ashot/b22e7a56, codecast/9a114468, union-mobile/cacbf3c8, codecast/790a2342, family/037d4ff6, family/0ba3e541, codecast/30f7f14e, codecast/5cd65a63, codecast/72e5cd0a, union-mobile-outreach/b8501299, codecast/fb8e21ef, codecast/jx7csbd, union-mobile/bcfdb6e9, family/101b6cc3, codecast/71261eae, union-mobile/jx7b88a, union-mobile-outreach/21872d19, codecast/a17b915d, codecast/6ed7379d.

### PR-process-4 Independent review

Plan substantial work before building it: choose the simplest design and decide how you will prove it works. Then iterate through implement, validate, review and polish until it holds up, with review done by a separate agent, ideally on a different model, whose job is to find what is wrong. A builder never signs off on its own work. Track the work as tasks where the tracking rules call for it, so it stays visible what was checked and what was not.

Why: A self-review shares the author's blind spots, and an untracked single pass hides what was and was not checked.

Evidence: 27 corrections across 24 sessions (`independent-review-for-substantial-work`): union-mobile-outreach/281e2ac7, -Users-ashot/b22e7a56, codecast/5cd65a63, union-mobile-outreach/12048842, codecast/c64919c4, mail/4a53ff52, codecast/902a9235, union-mobile/3a9a43dd, codecast/8b86a4df, codecast/27ac54c7, codecast/a2f48cf2, codecast/fb8e21ef, codecast/51edf9a8, codecast/c26c9845, union-mobile/2621cefb, union-mobile/99aaba5b, union-mobile-outreach/79d8465e, codecast/4ab9f316, codecast/1f6146fa, codecast/4b84ce1d, codecast/f5170ec0, codecast/jx778f8, codecast/jx77tbn, union-mobile/jx7c51r.

### PR-process-5 Reset and widen when attempts miss

When an attempt makes things worse, or several attempts in a row miss, stop patching the latest version. Go back to the last good state and name what regressed. Then rethink from the top and try clearly different directions rather than variations on the one that failed. When the right answer is a matter of taste, show the human the options side by side or give them controls to tune, instead of guessing again.

Why: Tweaking the latest miss narrows into a dead end; a reset and a wider search find the right answer faster.

Evidence: 10 corrections across 7 sessions (`rethink-when-attempts-miss`): codecast/c26c9845, codecast/jx7evm9, union-mobile/baef7735, union-mobile/0859d2b3, family/0ba3e541, codecast/377c6024, codecast/23b202ab.

### PR-process-6 Process weight matches the work

Scale process to the work. Agents decide how much ceremony a change needs: track only what benefits from tracking, extend an existing task instead of filing a duplicate, and when a gate or rule (a forced worktree, a branch flow) has no clear origin or purpose, find out why it exists and propose removing it rather than obeying it out of habit.

Why: Mandatory overhead on every task and inherited gates slow the owner's main-branch workflow and bury the board in noise.

Evidence: 10 corrections across 7 sessions (`process-weight-matches-work`): codecast/b8189b1a, codecast/e277f266, codecast/30f7f14e, codecast/af185144, codecast/26a56b6e, codecast/jx7b0e1, codecast/jx780bb.

### PR-process-7 Stay on the named scope

Change what the human asked for and leave the rest as they had it. Add to the existing surface rather than redesigning it, and leave similar behavior elsewhere alone unless asked. Restructuring that the requested change itself needs, such as reuse, is part of the task. Anything else you notice goes in a note, unless it blocks the work.

Why: Unrequested changes and detours cost review time and undo choices the human already made.

Evidence: 7 corrections across 6 sessions (`stay-on-the-named-scope`): union-mobile/369be387, codecast/1c290857, codecast/fb8e21ef, aurora/fc51b6ab, union-mobile/jx7f6g8, codecast/jx7ak11.

### PR-process-8 Encode corrections durably

When the owner corrects a recurring behavior or settles a new rule, write it into the instruction future runs actually read (the global or project CLAUDE.md, the trigger or agent prompt), at the place that governs that behavior and stated as a principle, as part of doing the work.

Why: A correction that lives only in one conversation is lost, and the owner has to make it again.

Evidence: 7 corrections across 7 sessions (`encode-corrections-durably`): -Users-ashot/b22e7a56, union-mobile-outreach/94519880, union-mobile/bcfdb6e9, mail/27c9bbb2, union-mobile-outreach/12048842, union-mobile/3d2a9117, union-mobile-outreach/281e2ac7.

### PR-process-9 Ship without coordination chatter

When the human asks you to ship, ship everything that is ready yourself and don't wait on other sessions. Message another session only when its work blocks yours or would break. Shipping still goes through the repo's safety gates.

Why: Messaging other sessions costs them a full-context turn and delays the release for no gain.

Evidence: 7 corrections across 7 sessions (`ship-without-coordination-chatter`): codecast/1d105764, union-mobile-outreach/dd6ba441, codecast/dd3b78dd, union-mobile/f3cdd1a5, codecast/41616389, union-mobile-outreach/006d67e4, codecast/jx737ae.

### PR-process-10 Approved work ships live

Approved work ships live on the main path. Use a flag, dark launch, split test or observation period only for a concrete safety or measurement reason, and turn on merged work that sits dark without one. When a feature is ruled out, turn it off and delete its code.

Why: Dark launches delayed real feedback and left approved features stuck off for no reason.

Evidence: 6 corrections across 2 sessions (`ship-live-by-default`): union-mobile-outreach/281e2ac7, union-mobile/bcfdb6e9.

### PR-process-11 Examine costly directions first

Before committing to a direction that is expensive to undo, trace how the whole loop would work end to end, decide what is actually correct, and put that reasoning in front of a person before building on it. Choices that are cheap to reverse stay yours to make.

Why: Building on a direction nobody examined wastes the build when the direction turns out wrong.

Evidence: 6 corrections across 5 sessions (`discuss-consequential-direction-first`): codecast/7f143785, codecast/717f2b8e, union-mobile/dac1b46b, union-mobile-outreach/c280d57c, union-mobile/72fb973f.

### PR-process-12 Read your conclusion as a skeptic

Before you act on a consequential conclusion, read it again as a skeptic would. Look for a flaw in the reasoning, for evidence that does not actually support it, and for anything the plan would break, and revise if you find one.

Why: Plausible first reasoning that goes unchecked leads to confident wrong turns.

Evidence: 2 corrections across 2 sessions (`challenge-your-own-reasoning`): union-mobile/jx79f01, codecast/jx7djk3.

## Verification

### PR-verify-1 Prove on real moments

Prove a change to an agent, prompt, model or pipeline by showing behavior before and after on the same realistic sample: real production moments or freezes, including hard cases, fallback paths and cases that already work. Run the real code end to end and mock only the outermost external calls. Report what improved, held and regressed, and read actual outputs, not just scores. Keep the cases and judges you built while iterating as permanent evals, and scale the depth of proof to the risk.

Why: Simple synthetic sims, a handful of draws and score-only comparisons pass while real behavior and fallback paths regress.

Evidence: 34 corrections across 26 sessions (`prove-on-real-production-moments`): union-mobile/fcc2d4cf, union-mobile-outreach/b8501299, -Users-ashot/b22e7a56, union-mobile/939092bf, union-mobile/19025195, union-mobile-outreach/65e45a18, union-mobile-outreach-backend/d98a708c, eaiden/d0c40251, union-mobile/cacbf3c8, union-mobile/bcfdb6e9, union-mobile-outreach/281e2ac7, union-mobile/99673cf8, union-mobile/dac1b46b, union-mobile-outreach/6f65f614, union-mobile-outreach/b82f0a83, union-mobile/5dccd647, union-mobile/54fb8ebe, union-mobile/3762962d, union-mobile/baef7735, codecast/fb8e21ef, eaiden/jx712a5, union-mobile/jx74111, union-mobile/jx7781p, codecast/jx7a1d6, union-mobile/jx7c51r, codecast/jx79ea6.

### PR-verify-2 Walk the real user flow

Prove user-facing behavior by using it the way the human will: walk the real flow, with realistic data, on every surface it ships to, through every interaction it adds and every access case it touches (signed in or out, shared or private), and against the real external services it depends on. Then compare the result with the visual reference. A passing test, render or rig shows that the code runs, not that the feature works, and how it looks and feels counts as much as the logic underneath.

Why: Features reported built were found dead on click, broken on desktop, or visually off because only renders or tests were checked.

Evidence: 23 corrections across 18 sessions (`exercise-user-flows-for-real`): union-mobile-outreach/281e2ac7, union-mobile-outreach/b8501299, codecast/27ac54c7, codecast/8a2647d7, codecast/a3dd2256, codecast/5cd65a63, eaiden/971a52b8, codecast/a893dea2, codecast/c26c9845, codecast/a83d26d5, codecast/9f5f5126, union-mobile/2621cefb, aurora/fc51b6ab, codecast/b19e897d, codecast/be5f2068, codecast/29e34461, codecast/872d70ac, codecast/f5170ec0.

### PR-verify-3 Done means the outcome is observed

Done means the intended outcome is observed where it lands, not that a score, typecheck or other proxy says so. Look at the actual things the system produced, check that the numbers are plausible given the data, back any aggregate claim with concrete examples, and say something is attached, deployed or working only after checking it there. When a change ships to production, keep watching until the effect holds over real cycles, with the depth of checking scaled to the risk.

Why: The owner repeatedly caught done claims that rested on proxies while the real outcome was absent or implausible.

Evidence: 18 corrections across 12 sessions (`verify-the-real-outcome`): union-mobile-outreach/281e2ac7, union-mobile/d1bc2e10, union-mobile/cacbf3c8, union-mobile-outreach-backend/5bec80a4, -Users-ashot/1d2161ba, union-mobile-outreach/85b15576, codecast/e2738e6f, union-mobile/939092bf, codecast/790a2342, aurora/34768c39, union-mobile/jx79f01, union-mobile/jx7664q.

### PR-verify-4 Carry over what already worked

Before you change or rebuild something, list everything the current version does and does well, and carry all of it over. Test the paths and fallbacks that already work both before and after the change.

Why: Redesigns silently drop features the user relied on, and a broken tool that used to work is a release blocker.

Evidence: 7 corrections across 5 sessions (`preserve-what-worked`): codecast/c26c9845, codecast/4b84ce1d, codecast/jx7evm9, codecast/91cd1654, codecast/a9c89211.

## Agents

### PR-agents-1 Inbox only for real asks

Keep the human's attention for what only they can do. Work an agent delegates or schedules (workers, reviewers, trigger runs, test runs) nests under the session that owns it, a body of work reaches the human as one head thread, and only an item that waits on their decision or action enters their inbox or decision stack. Wake an old or killed session only when it still owns work that must change, and report your state honestly: dormant when waiting on an automatic wake, needs-input only when a person must act.

Why: Every row in the needs-input queue costs attention, and inbox noise and needless wakes bury the few asks that matter and waste tokens.

Evidence: 28 corrections across 21 sessions (`session-fleet-hygiene`): codecast/75340f90, codecast/eb7cdbed, codecast/ac950a1e, codecast/2622f9a4, union-mobile/bb47b784, codecast/b8189b1a, -Users-ashot-src/c71b7cc8, -Users-ashot-src/421e971d, union-mobile-outreach-backend/d98a708c, codecast/fb8e21ef, codecast/jx7csbd, codecast/jx76e8h, codecast/jx7bs90, codecast/jx7as3d, codecast/700edf11, codecast/jx7er8q, codecast/7064c786, codecast/c397f70d, codecast/ab9f99a3, codecast/jx72nyf, codecast/jx7ey9r.

### PR-agents-2 One agent, judgment in its prompt

Build an agent system around one general agent that sees the complete shared context and is woken by events plus a single proactive wake. Its judgment (when to act, how hard to push, which tasks to create, how to brief delegates) belongs in its prompt. Keep code for plumbing and for facts the system already knows, such as a default taken from prior state. Adding a side trigger, a special-purpose agent, a per-case job or a hand-set throttle needs a concrete reason the main agent cannot handle it, argued against the strongest case for keeping it in the prompt.

Why: Scattered triggers with partial context act incoherently and wake agents only to discover another one owns the work.

Evidence: 19 corrections across 13 sessions (`one-agent-policy-in-prompt`): union-mobile/469fd3c9, union-mobile-outreach-backend/d98a708c, union-mobile/a1803f62, union-mobile/0890df87, union-mobile/b63734cf, union-mobile-outreach/b8501299, union-mobile/19025195, union-mobile-outreach/4ae73c82, union-mobile/bcfdb6e9, union-mobile-outreach/6f18639e, platform/70c3cbc8, codecast/b8189b1a, union-mobile/jx79f01.

### PR-agents-3 Consent before acts on others

Anything that reaches other people, or changes something the human owns and cannot easily restore, needs their explicit yes. Without it, prepare the act and stop there: draft the message instead of sending it, propose the invite, escalation or outreach instead of making it, and make a copy rather than editing the original when asked for a variant. Keep private details out of anything public, and use their screen or devices only when asked. When they say stop, stop everything tied to the work at once, subagents included. Ask through the decision queue, not an inline interruption, and keep the human's own working tree, deploys and reads yours to do.

Why: Unrequested sends, invites, edits and device use cost real social and practical damage that cannot be undone.

Evidence: 14 corrections across 9 sessions (`consent-for-acts-on-others`): family/4305be94, family/101b6cc3, union-mobile/369be387, codecast/5cd65a63, codecast/2c2cc7da, family/jx73nqd, union-mobile/jx7dnat, union-fundraising/jx71yhb, union-mobile/jx7580p.

### PR-agents-4 Conversational agents act like people

A conversational agent acts like a thoughtful, proactive person. It engages while the person's intent is high, starts helping while it gathers what it needs, looks things up itself and confirms rather than interrogating, and keeps its presence light: a reaction when a reply adds nothing, and silence in group threads unless it is addressed or has something relevant to say. Aim for assertive, never annoying, through stance-level prompting measured by simulating many conversations.

Why: Agents either interrogated, waited for scheduled wakes, or over-replied instead of engaging naturally.

Evidence: 9 corrections across 5 sessions (`agents-act-like-thoughtful-people`): union-mobile-outreach/b8501299, union-mobile/19025195, eaiden/d0c40251, eaiden/de0188ca, union-mobile/469fd3c9.

### PR-agents-5 Strongest model decides, briefed in full

Give the work that decides quality, the hard judgment calls and the core build, to the strongest model available, and keep the orchestrator for coordination. Brief every worker in full: the quality bar and every constraint the human set, including tools or paths they ruled out. A worker only knows what its brief says, so anything left out is something it may redo or contradict.

Why: Decisions made by a weaker model or an under-briefed worker cost rework.

Evidence: 6 corrections across 5 sessions (`strongest-model-decides`): codecast/fb8e21ef, codecast/jx7csbd, codecast/6ed7379d, aurora/fc51b6ab, codecast/jx72xk0.

### PR-agents-6 Recurring work earns its cadence

Recurring agent work lives in the visible trigger system, never in a hidden loop, so a person can see when it runs, why, and change it. Each run judges whether it is still earning its cadence and stops, slows down or folds into a sibling when it is not. Standing automations get pruned periodically and run on the cheapest model that does the job.

Why: Hidden, stale or overlapping loops waste capacity and attention.

Evidence: 6 corrections across 6 sessions (`recurring-agents-earn-their-cadence`): codecast/d2892238, codecast/jx75tcn, codecast/jx7csbd, codecast/fb8e21ef, codecast/ffa3b13c, -Users-ashot-src/c71b7cc8.

## Prompting

### PR-prompt-1 Fix model behavior in the prompt

When an agent misbehaves, find the instruction that caused the miss, or the gap where one should be, and rewrite the prompt there as a principle, together with any code fix. Do not wrap the model in guards, preclassifiers, string matchers or extra checking calls. Do not get a red eval to pass by loosening the eval. Before calling one model worse than another, tune the prompt for that model and read the outputs side by side. (prompting.md P5, P9)

Why: Auxiliary guards hide the real cause, and the next prompt that shares it repeats the miss.

Evidence: 23 corrections across 18 sessions (`fix-model-behavior-in-the-prompt`): union-mobile/fcc2d4cf, union-mobile-outreach/281e2ac7, codecast/2622f9a4, union-mobile/61e67808, union-mobile/bcfdb6e9, union-mobile-outreach/65e45a18, eaiden/79ff19cc, aurora/34768c39, union-mobile/19025195, union-mobile-outreach/b8501299, conv/1772b604, union-mobile/cacbf3c8, whisk/520c4457, codecast/c397f70d, codecast/jx7ey9r, codecast/jx72nyf, codecast/jx731hv, codecast/ab9f99a3.

### PR-prompt-2 Context the agent can reason over

Give an agent what its current step needs, in a form it can reason over. Long history goes in as a faithful condensation built from the full sources, with stable ids and a tool to open any original, never as a crude truncation. Facts carry dates, and the agent knows the current time and how long it has been since the last activity. Include every source that bears on the decision and leave out the rest. A continuing session already holds its role and standing instructions, so a wake does not resend them; situational guidance arrives in tool output at the moment it applies. (prompting.md P10)

Why: Truncated, timeless or cruft-laden context made agents miss detail, misjudge freshness, and waste tokens and attention.

Evidence: 18 corrections across 11 sessions (`agent-context-is-legible`): union-mobile/939092bf, union-mobile-outreach/6f18639e, union-mobile-outreach/65e45a18, union-mobile/469fd3c9, union-mobile-outreach-backend/d98a708c, eaiden/d1a0e749, union-mobile/19025195, codecast/fb8e21ef, codecast/jx7csbd, codecast/jx70c5h, codecast/jx75nnr.

### PR-prompt-3 Smallest self-contained prompt

Write a prompt as the smallest self-contained set of principles that produces the behavior: the intent, why it matters, and its exceptions, in plain language. Leave room for natural conversation. Skip scripts, forms, quoted phrasing and tool mechanics the agent already knows, and keep an eval lesson only as the general principle it taught. (prompting.md P1, P3)

Why: Structure and boilerplate over-anchor the model and bury the intent it needs to generalize.

Evidence: 16 corrections across 11 sessions (`prompts-state-intent-minimally`): codecast/fb8e21ef, codecast/jx7csbd, aurora/ede2adeb, family/61d8c471, family/jx7523m, codecast/jx7e8hr, codecast/ab9f99a3, codecast/jx72nyf, codecast/jx75q89, codecast/jx7e4fy, family/jx77h0y.

### PR-prompt-4 Correct toward balance, measured

When correcting a model tendency, aim for the balanced behavior, not the opposite failure. Understand why the current prompt produces the tendency before changing it, make the smallest change that fixes it, and judge the change against varied scenarios and personas with enough samples to tell the variants apart. If outputs keep missing, simplify the prompt instead of adding to it. (prompting.md P11)

Why: Overcorrection trades one failure for another, and few draws cannot tell which variant is better.

Evidence: 9 corrections across 7 sessions (`balanced-measured-prompt-iteration`): union-mobile/5dccd647, union-mobile/jx79sem, union-mobile/jx7b88a, union-mobile/a5d1a302, codecast/jx7e8hr, family/61d8c471, union-mobile-outreach/281e2ac7.

## Communication

### PR-comms-1 Write for a reader who was not there

Write every message, status and post for a smart reader who was not there and does not know this codebase. Use plain sentences with full precision. Name things by what they are, not by labels or compound terms you coined, and list a set's members instead of naming the set. Report the current verified state rather than how you got there, and say why it happened and whether it matters. In shared channels, include the context an outsider needs. Stop when the content stops. If the reader is still confused, rewrite it from scratch rather than defend the wording.

Why: Compressed private vocabulary forces the owner to decode every report and repeatedly ask what terms mean.

Evidence: 26 corrections across 16 sessions (`plain-self-contained-writing`): union-mobile-outreach/281e2ac7, union-mobile-outreach/6f18639e, codecast/a5b1a2fc, union-mobile-outreach-backend/d98a708c, union-mobile/469fd3c9, union-mobile/d1bc2e10, mail-packages-convex/62dfff91, codecast/b3f9d211, codecast/jx75vha, union-mobile/jx7b88a, codecast/ec488165, union-mobile-outreach/b82f0a83, codecast/fb8e21ef, union-mobile-outreach/92e01004, codecast/jx73ngf, codecast/jx7fk24.

### PR-comms-2 A decision carries its own context

A decision or ask put to the owner makes sense to someone who has not seen the work. In plain words, say what the thing is, what the system does today and why, and what will happen under each option. List exactly what you need from them, separately, and give your recommendation with the reason for it. Before asking, check what the system already does, so the question does not contradict behavior already in place. Combine findings into one proposal rather than a pile of observations, and show proofread before and after pairs when the ask is a review of edits.

Why: Cards with bare ids, missing context or buried asks cannot be acted on without opening the session, which defeats the queue.

Evidence: 22 corrections across 18 sessions (`decisions-carry-their-context`): union-mobile/b63734cf, union-mobile/0890df87, union-mobile/3c33b94f, codecast/30f7f14e, union-mobile/baef7735, union-mobile/3d2a9117, union-mobile-outreach/9ae3236b, union-mobile/dcb2cd5b, union-mobile-outreach/65e45a18, codecast/fb8e21ef, union-mobile/0e6e5024, union-mobile/469fd3c9, union-mobile/bf7bdd06, union-mobile/bcfdb6e9, union-mobile/jx74111, union-mobile-outreach/76638ad1, union-mobile/369be387, codecast/jx7fk24.

### PR-comms-3 Say how long and where it lands

Before starting build work, tell the human roughly how long it will take and where the result will land, so they never have to chase it. Answer a quick question as soon as it arrives, even mid-task.

Why: The human plans around your work and should not have to chase it.

Evidence: 3 corrections across 1 sessions (`set-expectations-up-front`): union-mobile/369be387.

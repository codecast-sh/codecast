# Codecast's principles

How work on codecast is judged, beyond the shared principles in docs/principles.md (ids `PR-<area>-<n>`), which apply here as well and are not repeated. This file holds what is codecast's own: principles whose evidence comes almost entirely from codecast sessions, and the codecast form of a shared principle where codecast's steering names something concrete in this codebase. Each carries a stable id (`CC-<area>-<n>`) so a plan, a review or a card can cite it.

Codecast is a local-first product used all day by the people who build it, across web, desktop, mobile and the CLI, with many agent sessions working in one checkout at once. Most of what follows comes from those facts: a lag, a lost message or a flicker is felt immediately, and a mistake in shared infrastructure reaches every session and every client at once.

The evidence line gives the corrections and sessions the principle was asked for in, and names the section of CLAUDE.md where the team recorded the rule, when there is one. A shared principle a codecast form extends is named in brackets.

## Store and data

### CC-store-1 Every fact has one home, and the surface paints from the store

Server data a surface renders lives in the store, and the surface reads the store; a live query only feeds it. A populated cache is the ordinary first paint, so a skeleton is honest only for a genuinely cold cache. Each field, membership or count is written in exactly one place, and every other view derives it at read time through a selector, never through a second writable copy kept in step. Derived or joined fields from the server (an assignee's avatar, a plan's progress) are re-derived live from their raw fields rather than stored optimistically. A new synced collection is one registration that everything else derives from.

Why: copies drift the moment two feeders or two readers disagree about which one is current, and each drift then needs its own reconciler. A surface that waits on the network when the answer is already local feels slow in a product built to feel instant.

Evidence: 5 corrections across 5 sessions [PR-code-1]: codecast/6faa44cb, codecast/jx74z5d, codecast/c26c9845, codecast/jx75vha, vello/d4dab4d0. Recorded in CLAUDE.md (Store: Local-first is the law).

### CC-store-2 What a person does shows at once and is never lost

Every user action renders from the local store synchronously: the optimistic write happens in the action's draft and a side effect carries it to the server, and a create writes a stub row that the server's row supersedes. The store already provides this, so a feature adds no parallel optimistic state, timers or hand-written pending locks. What a person sends or starts (a message, an upload, a call they joined) keeps its true order, finishes in the background if still pending, and can never be lost, duplicated or silently dropped; model the state so those outcomes cannot be represented.

Why: losing or scrambling what a person did destroys trust faster than any other bug, and a second optimism layer beside the store's is where the losses came from.

Evidence: 7 corrections across 6 sessions: codecast/2907ac83, codecast/3d59bf6c, codecast/6d17a0fa, codecast/638ee419, codecast/jx7c3x7, codecast/be5f2068. Recorded in CLAUDE.md (Store).

### CC-store-3 Workspace is access, team_id is routing

Two fields answer two questions and are never read for each other. `workspace` decides who may read a row; `team_id` decides whose inbox, feed and notifications it flows to and grants nothing. Personal is a positive value, an unresolved viewer matches nothing, and reads may default while writes name their workspace explicitly. Reads, visibility writes, enumeration and team switches go through the existing chokepoints, so the rule is enforced where every path passes.

Why: conflating the two leaked private rows into team views and made the personal workspace unreachable, a class of bug that one field per question removes.

Evidence [PR-code-1, PR-product-6]: recorded in CLAUDE.md (Workspace access vs routing).

## Code

### CC-code-1 Self-healing systems, visible failure

When a result keeps needing manual intervention or a workaround, change the system so it produces that result on its own. The daemon, the browser bridge, sync and the other tools people depend on recover by themselves from conditions already known, and detect stuck states and report them. When something does fail, the UI says so plainly, stays up long enough to read, and puts the recovery action next to the message. Long operations show progress and end with a clear result. A flow that cannot finish without the user becomes a guided step in the product, not an instruction in the docs.

Why: manual one-offs, silent spinners and fragile daemons push ongoing work and support back onto the owner.

Evidence: 21 corrections across 16 sessions [PR-code-2]: codecast/738de269, codecast/6d66a45e, codecast/0f33215d, codecast/204dc98c, codecast/c8c6771d, codecast/616fbff1, codecast/jx7162g, codecast/jx79098, codecast/jx7e9av, codecast/b7e8002b, codecast/jx73zke, codecast/c3f8856c, codecast/91cd1654, union-mobile-outreach/281e2ac7, bookmark/67e9d943, aurora/fc51b6ab.

### CC-code-2 Cut load at its source

Many sessions share one machine, so work that contends for it is shared or batched at its source rather than rationed. Typecheck through `cast check`, which keeps one watcher per tree, never a fresh `tsc`; run the test files a change touches, and keep whole-suite runs rare. One window per origin syncs and the rest replicate. An always-mounted component subscribes to a signature of the fields it shows, not to a whole high-churn collection.

Why: a copy of the same work per session put the machine into swap and stalled everything on it, and gates that ration duplicated work keep the waste while adding a new way to fail.

Evidence: 3 corrections across 3 sessions: codecast/6d66a45e, codecast/1adfe699, codecast/1b910ce2. Recorded in CLAUDE.md (Typechecking; Store: One window syncs; Reading state in components).

## Shipping

### CC-ship-1 The backend ships before the client that calls it

Convex ships only when a person runs `packages/convex/deploy.sh`, and web ships on every push, so a commit that adds a function and the code calling it deploys convex first, from a tree that contains origin/main, and pushes after. Never deploy from a tree behind origin/main, by any other route, because a deploy is a whole-tree snapshot that deletes what it lacks. A query that only enriches a surface tolerates a missing function, and code that reaches mobile works on binaries built before a native module it uses was added.

Why: every gap between the two clocks took a live surface down: deploys from stale trees deleted production functions three times in one day, and a client asking for a function prod lacked took out the whole conversation header.

Evidence [PR-product-4, PR-code-5]: 9 corrections across 8 sessions, 7 of them codecast: codecast/52d95fcf, codecast/81fa353e, codecast/19bfa707, codecast/e7b2cf97, codecast/1582c431, codecast/6faa44cb, codecast/71261eae. Recorded in CLAUDE.md (Convex deploys; Mobile bundle and native modules).

### CC-ship-2 Process weight matches the work

Work happens in the main checkout, with no branch, pull request or worktree unless someone asks for one, and a change is done when it is validated in the working tree. Agents decide how much ceremony a change needs: track only what benefits from tracking, extend an existing task instead of filing a duplicate, and when a gate or rule has no clear origin or purpose, find out why it exists and propose removing it rather than obeying it out of habit. Other sessions' uncommitted work in the tree is theirs: read it before editing a shared file and never revert it.

Why: mandatory overhead on every task and inherited gates slowed the owner's main-branch workflow and buried the board in noise.

Evidence: 10 corrections across 7 sessions: codecast/b8189b1a, codecast/e277f266, codecast/30f7f14e, codecast/af185144, codecast/26a56b6e, codecast/jx7b0e1, codecast/jx780bb. Recorded in CLAUDE.md (Working directory; Git history).

## Verification

### CC-verify-1 Carry over what already worked

Before changing or rebuilding something, list everything the current version does and does well, and carry all of it over. Test the paths and fallbacks that already work both before and after the change, such as the relay path behind a new direct one.

Why: redesigns silently dropped features the owner relied on, and a broken tool that used to work is a release blocker.

Evidence: 7 corrections across 5 sessions [PR-verify-2]: codecast/c26c9845, codecast/4b84ce1d, codecast/jx7evm9, codecast/91cd1654, codecast/a9c89211.

### CC-verify-2 A prompt change is proven on frozen moments

A change to a prod prompt is shown on real codecast moments before and after: freeze the moments that matter, take a baseline, change the prompt, and run `./evals check` until the verdict separates. A win needs `separated: better`; a handful of draws decides nothing, and gates fail on a single sample. Every headless model run, whether a dry run, a grade or a rehearsal, goes through `packages/cli/scripts/prompt-dry-run.ts`, the only harness that keeps the run out of the owner's inbox. Real content never enters git; only synthetic fixtures do.

Why: score-only comparisons on a few synthetic draws passed while real behavior regressed, and bare headless runs leaked into the founder's inbox on four separate days.

Evidence [PR-prompt-1]: codecast/fb8e21ef, codecast/jx7a1d6, codecast/jx79ea6. Recorded in CLAUDE.md (Prompt evals; Prompt dry runs).

### CC-verify-3 Done is observed where it lands

A green `cast check` or a passing test shows that code runs, not that the feature works. Client behavior is checked in the owner's own Chrome through `cast browser`, with screenshots in the thread; backend changes and anything that touches other sessions' work get an end-to-end run; something is deployed or attached only once it has been seen there. Scale the depth of checking to the risk: copy and small visual changes need a read and a typecheck, not a browser session.

Why: the owner caught done claims that rested on scores and typechecks while the real outcome was absent.

Evidence [PR-verify-2]: codecast/e2738e6f, codecast/790a2342.

## Design

### CC-design-1 Clear feedback, stable layout

Interactions never leave the user guessing or surprise them. Every action gets immediate, visible feedback. The layout holds still: opening, hovering, expanding or a status update never shifts content, moves the window or scrolls the reader. Primary actions are easy to find and look the same everywhere they appear. Overlays close in an obvious way. Selection and drop targets are impossible to miss, and controls keep strong contrast and generous hit areas. The app changes the visible conversation, surface or route only when the user asks, and standard OS keys work as expected. Walk through every state and transition before building.

Why: hidden actions, jumping layouts, silent states and unexpected view switches made features feel broken even when they worked.

Evidence: 32 corrections across 24 sessions: codecast/5cd65a63, codecast/8a5da82a, codecast/356f3371, codecast/2622f9a4, codecast/f388ef97, codecast/d78076a5, codecast/7603dece, codecast/bae26244, codecast/357dc99a, codecast/d0e1b2a5, codecast/d1b0172a, codecast/fcfb7767, codecast/6b76b81e, codecast/57e10167, codecast/3d3a114d, codecast/ba3755d7, codecast/23b202ab, codecast/26856fb1, codecast/377c6024, codecast/9924c5e6, codecast/03d88c38, codecast/2912b750, union-mobile/96cc4996, union-mobile-outreach/afd41522.

### CC-design-2 One scroller, content first

Each view has one scroll, the page's own: no scroll panes nested inside it and no frames inside frames, so containers grow to fit their content. Chrome earns its space: empty panels stay closed, secondary helpers fold away, rare actions get small controls, and on a narrow screen a side panel becomes a full-screen view with a way back.

Why: nested scrolls and permanent chrome fight the browser and waste the space the content needs.

Evidence: 16 corrections across 13 sessions: codecast/e264cab9, codecast/619d3d49, codecast/52563eab, codecast/05bc9938, codecast/jx77j0w, codecast/jx73063, codecast/jx74ybv, codecast/db1f2407, codecast/1fe7e745, codecast/a5d9cd23, codecast/56a4bba2, codecast/23b202ab, codecast/db2088f5.

### CC-design-3 One design language on every platform

Codecast speaks one visual language: JetBrains Mono everywhere, mobile included through the Themed text components; colors from the `--sol-*` tokens, so a theme reaches every surface; keyboard keys rendered as `<KeyCap>` with the platform's modifier name, never as bare glyphs in the surrounding text. Color carries meaning, and everyday components get the same polish as the showcase surfaces. An object looks the same and opens the same page wherever it is referenced.

Why: too many font styles, weights and loud colors made surfaces read as uncohesive, and each surface that bypassed the shared fonts, tokens or components needed its own fix.

Evidence [PR-design-2, PR-design-4]: 18 of the 30 sessions behind PR-design-2 and 11 of the 17 behind PR-design-4 are codecast's, among them codecast/357dc99a, codecast/377c6024, codecast/c26c9845, codecast/be5f2068, codecast/58d03e78, codecast/9a39ebc7. Recorded in CLAUDE.md (UI conventions).

## Product

### CC-product-1 Defaults just work

Defaults make a feature work the first time and never lose what the user already gave it. Start from the choices and setup they already made (the last microphone and camera, the open repo and team), keep anything they typed as a draft until they throw it away, keep every client current without asking them to update, and do not assume one account per service. When something they pointed at no longer exists, say so and offer a way to recover.

Why: a feature that fails quietly or forgets the user's state looks broken, even when the code behind it is correct.

Evidence: 8 corrections across 7 sessions: codecast/5cd65a63, codecast/c64919c4, codecast/106d22b7, codecast/f8e404e4, codecast/c8c6771d, codecast/36878dea, -Users-ashot/b22e7a56.

## Agents

### CC-agents-1 Inbox only for real asks

Keep the human's attention for what only they can do. Work an agent delegates or schedules (workers, reviewers, trigger runs, test runs) nests under the session that owns it, a body of work reaches the human as one head thread, and only an item that waits on their decision or action enters their inbox or decision stack. Wake an old or killed session only when it still owns work that must change, since a wake reloads its whole context, and report state honestly: dormant when waiting on an automatic wake, needs-input only when a person must act.

Why: every row in the needs-input queue costs attention, and inbox noise and needless wakes buried the few asks that mattered and wasted tokens.

Evidence: 28 corrections across 21 sessions: codecast/75340f90, codecast/eb7cdbed, codecast/ac950a1e, codecast/2622f9a4, codecast/b8189b1a, codecast/fb8e21ef, codecast/jx7csbd, codecast/jx76e8h, codecast/jx7bs90, codecast/jx7as3d, codecast/700edf11, codecast/jx7er8q, codecast/7064c786, codecast/c397f70d, codecast/ab9f99a3, codecast/jx72nyf, codecast/jx7ey9r, union-mobile/bb47b784, -Users-ashot-src/c71b7cc8, -Users-ashot-src/421e971d, union-mobile-outreach-backend/d98a708c.

### CC-agents-2 A decision card carries its own context

Before a direction that is costly to undo (a schema, a protocol, a migration), trace how the whole loop would work and queue the choice with `cast decide` rather than building on a guess. The card is the whole message: what the thing is, what the system does today, what each option costs, your recommendation and why, and exactly what you need, in plain words someone who never opened the session can act on. Check what the system already does before asking, and withdraw a card the work has moved past.

Why: cards with bare ids and buried asks could not be decided without opening the session, which defeats the queue, and directions nobody examined wasted the build.

Evidence [PR-agents-3]: codecast/30f7f14e, codecast/fb8e21ef, codecast/jx7fk24, codecast/7f143785, codecast/717f2b8e.

### CC-agents-3 Strongest model decides, briefed in full

Give the work that decides quality, the hard judgment calls and the core build, to the strongest model available, and keep the orchestrator for coordination. Brief every worker in full: the quality bar and every constraint the human set, including tools or paths they ruled out. A worker only knows what its brief says, so anything left out is something it may redo or contradict.

Why: decisions made by a weaker model or an under-briefed worker cost rework.

Evidence: 6 corrections across 5 sessions: codecast/fb8e21ef, codecast/jx7csbd, codecast/6ed7379d, codecast/jx72xk0, aurora/fc51b6ab.

### CC-agents-4 Recurring work earns its cadence

Recurring agent work lives in triggers, never in a hidden loop, so a person can see when it runs, why, and change it. A standing duty runs as a fresh spawned session with a precheck that spends nothing when nothing changed. Each run judges whether it still earns its cadence and stops, slows down or folds into a sibling when it does not. Standing automations get pruned periodically and run on the cheapest model that does the job.

Why: hidden, stale or overlapping loops wasted capacity and attention; one cleanup found 51 triggers.

Evidence: 6 corrections across 6 sessions: codecast/d2892238, codecast/jx75tcn, codecast/jx7csbd, codecast/fb8e21ef, codecast/ffa3b13c, -Users-ashot-src/c71b7cc8.

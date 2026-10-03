# Changes: a daily edition of what the team shipped and why

Status: proposal, ready to build. Route: `/changes`. Feature flag: `teams.features.changes` (default off, on for Ashot's teams first).

This spec starts from the "editorial" design (a fixed day edition built from stories). It adds the live strip, the deploy markers and the computed risk flags from "ship-log", and the scheduler, stable story keys and later the Why box from "zoom". It also fixes every flaw the three reviews found. Those fixes are listed in section 13 so a reviewer can check them one by one.

## 0. Page shape

The page is one timeline, newest day first, that loads older weeks as the reader scrolls. There are no per-day pages and no Day/Week switch.

- Each day is a date, one short sentence about the day (the edition headline), a quiet meta line (changes, releases), and its stories one line each: a short headline and a one-line dek. Housekeeping folds under "N small changes".
- A story opens in place: its body, where its why came from, its worded risks, its people, then its commits, sessions and (folded) files.
- A finished week's notes sit where the timeline enters that week; the week in progress has none, and notes that restate a day are dropped.
- The header holds the rest, tucked: the repository, one line of what is live, an "in progress" disclosure (In the works), and one filter button (areas, people, risks, all branches, text).

Prose is written to be scanned: story headlines aim under 60 characters and deks under 80, and the day sentence under 80. Sections 3 to 6 below describe the earlier per-day edition; where they differ from this section, this section holds.

## 1. Intent

A team ships code faster than anyone can read it. On codecast a day is 8 to 45 commits, the average commit touches 23 files, and 12% of commits are version bumps. On Littlebird a day is about 760 commits across dozens of branches. The commit is the wrong unit for reading: it is either release noise or a batch with no single intent.

`/changes` changes the unit of reading to the **story**: one intent, told in plain sentences, built from the team-visible sessions and commits behind it. Each day is an **edition** with a headline, a lead story, sections by code area, and a strip that says what is live right now. Every sentence traces back to its sources, and every "why" says where it came from. A founder catches up on a 45-commit day in about 90 seconds.

Three rules hold everywhere:

1. **Nothing waits on a model.** Every story and every edition has a deterministic version built from commit subjects, areas and counts. Prose replaces it when it arrives.
2. **"Why" is never invented.** The model states a reason only when an input states one, and it reports which input (`why_source`). The page shows that source on every story.
3. **Private work never enters prose.** Narratives are built only from inputs that pass one gate, `teamVisibleInputs()`, which applies both the conversation's visibility and the owner's membership level.

## 2. Who it is for and the questions it answers

| Reader | Question | Where the page answers it |
|---|---|---|
| Founder or lead, every morning | What did we ship yesterday, and why does it matter? | Edition headline, standfirst, lead story |
| Anyone about to tell a user "it's fixed" | Is it live? What is waiting behind the last release? | Live strip at the top |
| Lead before a deploy | Is anything risky right now? | Risk flags on the strip and on stories |
| Teammate back from a few days off | What happened while I was away? | Week view (phase 2), day navigation with `[` and `]` |
| Engineer chasing a change | Which session or commit did this, and what was it asked to do? | Evidence drawer: commits, session pill, the session's asks and dids |
| Anyone | What is still in progress or stuck? | "In the works" column |

The page does not measure effort. Messages, durations and per-person output stay on `/team/activity`.

## 3. Zoom levels and why

There are four levels. The day is the home level and the story is the core unit.

1. **Day edition** (default, `/changes?d=2026-10-02`). An edition headline, a standfirst, one lead story, sections by area, In brief, In the works, and the live strip. This is the 90-second read. The day is in the team's local time (section 7.6).
2. **Story** (`/changes?d=...&story=<story_key>`). One intent: a headline, a one-sentence dek with the why, a body of at most 3 sentences, the area, the release that carried it, the people and sessions behind it, and its diffstat.
3. **Evidence** (the drawer inside a story). Deduped commits in mono (sha, subject, DiffStat, author), the session pill with its insight headline and its turns as ask/did pairs, PR pills, and the files grouped by area. From a commit row, `o` opens the existing `/commit/<sha>` page, which has the diff.
4. **Week** (phase 2, `/changes?w=2026-W40`). A 3 to 5 sentence standfirst, the 5 biggest stories, a release ledger ("cli 1.1.157 to 1.1.163, 7 releases"), and area totals. Built only from the seven day editions, never from raw commits.

Why the story is the unit. A session is the best source of "why", and 79% of codecast commits link to one. A commit carries no single intent often enough (the 10-02 `feat(web): line pages, share pages, org staffing and app updates` holds five stories) that it cannot be the reading unit. A release is the boundary users feel, but most teams have no release signal, so releases are markers on the day, not the unit.

Levels left out:
- **Hour:** noise.
- **Person:** reads like a performance review and duplicates `/team/activity`. Person is a filter.
- **Release as the top level:** web and Convex deploys are not recorded today, and most teams never tag. Releases appear as stamps between stories and as tiles in the live strip.
- **Semantic zoom as navigation** (the "zoom" design's altimeter and pinch): a page people read in seconds needs a fixed front page. Expanding a story keeps its position fixed (FLIP), which keeps the one good part of that idea.

## 4. Page anatomy

Full width inside `DashboardLayout` (an `isOnChangesPage` flag), `max-w-[1180px] mx-auto px-6`. At 1100px and wider it is a 12-column grid. Below 1100px it is one column in this order: header, live strip, headline, lead, sections, In brief, In the works, footer.

```
+------------------------------------------------------------------------------------+
| HEADER                                                                             |
|  Changes   codecast-sh/codecast v     < Wed 1 | Thu 2 Oct | today >     Day | Week |
|  [M][T][W][T][F][S][S]  (7 day cells, ink underline by commit volume)              |
|  =================================================================== double rule   |
|  16 commits . 9 stories . 3 releases . 4 people . 11 sessions   [main | all]  [/]  |
+------------------------------------------------------------------------------------+
| LIVE STRIP (only surfaces with a release signal; hidden when there are none)       |
|  +--------------+ +----------------+ +------------------+ +----------------+       |
|  | cli          | | desktop        | | backend          | | web            |       |
|  | 1.1.163      | | 1.1.123        | | 3250f11          | | no signal yet  |       |
|  | 15:27 today  | | 15:21 today    | | deployed 16:02   | |                |       |
|  | 1 waiting    | | up to date     | | 3 waiting  ////  | |                |       |
|  +--------------+ +----------------+ +------------------+ +----------------+       |
+------------------------------------------------------------------------------------+
| EDITION HEADLINE (span 12, 30px, max 2 lines)                                      |
|  Desktop 1.1.123 and CLI 1.1.163 go out as agent helpers stop starving under load  |
| STANDFIRST (span 8, 15px/1.6)                                                      |
|  A slow day for volume and a big one for reliability. Watchers now start at        |
|  interactive priority, the web gained line and share pages, and two releases       |
|  shipped within six minutes of each other.                                         |
+-------------------------------------------------+----------------------------------+
| LEAD STORY (span 8, bg-sol-card, 2px area rail) | IN THE WORKS (span 4, sticky)    |
|  [] cli    shipped in cli 1.1.163               |  Stuck                           |
|  Agent helpers no longer starve when the        |   | "Codex Cloud fixture replay  |
|  machine is busy                       (22px)   |   |  fails on rewritten jsonl"   |
|  Bridge host and tsc watchers inherited the     |  Building now                    |
|  agent shell's background priority and stalled  |   "Added zoom support and        |
|  for tens of seconds; they now launch as        |    debugged image pill click"    |
|  interactive launchd jobs.                      |  In review                       |
|  why: from session jx7abcd . 3 commits +412 -88 |   #412 Line pages  checks red    |
|  (A) (jx7abcd)                    [e] evidence  |  On branches                     |
|-------------------------------------------------|   dmitriy/vfs-output-dest... 48  |
| SECTIONS (span 8, grid of independent blocks)   |   . backend/lb                   |
|  Web .................................. 4       |  ------------------------------- |
|   Line pages and share pages land     +1.2k     |  Areas today                     |
|   Right-click spelling suggestions     +210     |   web     ############ 135       |
|  - - - - - - [ cli 1.1.163, 15:27 ] - - - - -   |   cli     ########   175         |
|  CLI .................................. 3       |   convex  ####       71          |
|   Fleet migration finds the right agent  +96    |                                  |
|  Convex / Desktop / Mobile ...                  |                                  |
+-------------------------------------------------+----------------------------------+
| IN BRIEF (span 12, one line each, dotted leader to the area)                       |
|  Architecture docs and agent guide refreshed ........................... docs      |
|  Codex Cloud fixtures scrubbed for the test suite ...................... cli       |
+------------------------------------------------------------------------------------+
| FOOTER                                                                             |
|  Written from 9 team-visible sessions and 16 commits. 4 sessions are not shared    |
|  with the team and contributed commit messages only.   [ [ ] [ ] ] days  [j][k]    |
+------------------------------------------------------------------------------------+
```

### 4.1 Header

- "Changes" in `var(--font-ui)` 20px semibold. No kicker above it.
- Repo picker, shown only when the team has commits in more than one repo in the last 14 days. Default: the repo with the most commits in 14 days. Reuses `Pill` from `components/feed/ExternalEventRow.tsx`.
- Date navigation: previous and next arrows, plus a strip of 7 day cells. Each cell has a 2px ink underline whose opacity tracks that day's commit count (one hue, `var(--sol-text)` at 15% to 70%). It does not reuse `HEAT_COLOR` (section 5.2).
- Day | Week segmented control (Radix tabs). Week is disabled with a tooltip until phase 2.
- The double rule: two hairlines of `color-mix(in srgb, var(--sol-text) 70%, transparent)` with a 1px gap, 3px total. It is the one newspaper device on the page.
- Stats line: mono 11px, `tabular-nums`, `MetaDot` separators. Then the branch toggle (main | all branches, default main) and the filter button.

### 4.2 Live strip

One tile per **surface** that has at least one release signal in the last 30 days. A surface is a product that ships separately: on codecast `cli`, `desktop`, `extension`, `backend`, `web`. Surfaces are detected, not configured (section 7.3). A team with no release signals gets no strip at all, and a one-line hint in the footer: "Tag releases or post deploy markers to see what is live." This fixes ship-log's flaw where most teams would get a hollow version of its signature visual.

Each tile (CSS grid, `auto-fit, minmax(150px, 1fr)`, gap 8px):
- Surface name, `var(--font-ui)` 12px, `text-sol-text/70`.
- Version (or short sha for deploy-only surfaces), JetBrains Mono 20px `tabular-nums`. This is the one large mono element on the page.
- Ship time through `formatDateSmart`.
- "N waiting": stories in this surface's paths that landed on the default branch after this ship. "up to date" at zero.
- A 2px top border in the surface accent.
- A risk shows as a hatched corner with a tooltip naming the signal and its evidence.

Clicking a tile filters the page to that surface's areas. A surface whose deploys are not recorded (web, until Railway webhooks exist) shows "no signal yet" rather than a stale or guessed value.

### 4.3 Edition headline and standfirst

Written by the edition call. Sentence case, no italics, no accent-colored clause. The headline is the one large prose element. Before prose exists, the headline is the stats line in large type ("16 commits, 3 releases, 9 stories") and the standfirst slot is empty with its height reserved.

### 4.4 Lead story

`bg-sol-card rounded-lg border border-sol-border/25 px-5 py-4 shadow-sm` with a 2px left rail in the area color.
- Area tag: a 6px square in the area color plus the area name, mono 11px.
- Release tag when a release in the story's surface followed its last commit: "shipped in cli 1.1.163".
- Headline 22px semibold, dek 15px/1.6, body at most 3 sentences.
- Provenance line, mono 11px `text-sol-text/55`: "why: from session" with the session pill, or "why: from commit message", "why: from PR", or "why: not stated". This is the trust mechanism.
- `DiffStat`, `AuthorAvatar` stack, session `EntityIdPill`s, and an "evidence" button labelled with `<KeyCap>e</KeyCap>`.
- Risk flags attached to the story render as a 3px hatched left edge in place of the area rail, with the worded risk as one line under the dek.

### 4.5 Sections

A CSS grid of independent blocks, one per area, in the edition's `section_order` (fallback: file-touch volume). Not CSS `column-count`, which rebalances when a row expands and breaks the j/k reading order. At 1100px and wider the blocks sit in two grid columns with `grid-auto-flow: row`, so visual order matches focus order (left to right, then down).

- Block header: area name 15px semibold, a hairline `h-px bg-sol-border/15`, and a count. The `DaySection` idiom from `ActivityFeed.tsx`.
- Story rows: a 14px medium headline, right-aligned `+insertions` in mono 10px. The dek sits in a reserved second line at `text-sol-text/70` that is always rendered (not revealed on hover), so expanding never shifts layout. Rows show a kind glyph: feature (small up chevron, green), fix (stitched dot, orange), perf (bolt, cyan), revert (back arrow, red). Docs, test and chore have no glyph.
- **Release stamp**: where a release lands between two stories of its surface, a perforated divider. A 1px dashed line drawn with `repeating-linear-gradient(90deg, var(--sol-border) 0 4px, transparent 4px 7px)` and a centred mono pill "cli 1.1.163, 15:27". It is the page's signature mark.

### 4.6 In brief

Stories the edition ranked at importance 1 (docs, tests, chores, small single-commit fixes, and weak slices of batch commits). One line each, 13px, with a dotted leader (`radial-gradient(var(--sol-text-dim) 0.6px, transparent 0.6px)` at 4px repeat on a flex filler) to the area tag.

### 4.7 In the works (right column)

Sticky at `top-16`, grid span 4. Five short groups with 13px semibold sentence-case labels:
- **Stuck:** team-visible insights from the last 48 hours with `outcome_type = blocked`, quoting the headline. A 2px rule in `color-mix(in srgb, var(--sol-red) 80%, transparent)`.
- **Building now:** team-visible insights from the last 48 hours with `outcome_type = progress` whose sessions have no landed commits yet. Headline quoted verbatim.
- **In review:** open PRs with `PrStatusChip` and checks state, capped at 6.
- **On branches:** non-default branches with commits today: branch, commit count, top area. Phase 2 adds a prose line per branch.
- **Areas today:** ink bars per area (file touches), in area colors, with a tooltip "web: 135 file touches in 6 commits".

This is where 92% of Littlebird's volume lives without swamping the front page.

### 4.8 Footer

Provenance and privacy accounting, generated deterministically: "Written from N team-visible sessions and M commits. K sessions are not shared with the team and contributed commit messages only." K is a count, never a title. Then the keyboard hint row in `<KeyCap>`. Then "notes written 16:08" and, when generation is capped or failed, one quiet line saying so.

## 5. Visual language

### 5.1 Type

- Prose (headlines, standfirst, deks, bodies, In the works) uses `var(--font-ui)`. It is JetBrains Mono in the default themes and SF Pro under `minimal-style`.
- Facts (shas, versions, times, diffstats, counts) use `font-mono` with `tabular-nums`, always.
- In mono, the edition headline uses `font-variant-ligatures: none` and `letter-spacing: -0.02em`, which reads as a typewriter broadsheet. All text inputs on the page also set `font-variant-ligatures: none` (JetBrains Mono calt trap).
- Scale:

| Element | Size / line height | Weight | Color |
|---|---|---|---|
| Edition headline | 30 / 1.15 | 600 | `text-sol-text` |
| Lead headline | 22 / 1.25 | 600 | `text-sol-text` |
| Standfirst, lead dek | 15 / 1.6 | 400 | `text-sol-text/80` |
| Section header | 15 / 1.3 | 600 | `text-sol-text` |
| Story row headline | 14 / 1.4 | 500 | `text-sol-text/90` |
| Section dek, In brief, In the works | 13 / 1.55 | 400 | `text-sol-text/70` |
| Live strip version | 20 mono | 500 | `text-sol-text` |
| Meta | 10 to 11 mono | 400 | `text-sol-text/45` to `/55` |

No serif anywhere. No italic. No uppercase letterspaced labels.

### 5.2 Color

- Surfaces: `bg-sol-bg` for the page, `bg-sol-card` for the lead story and live tiles, `border-sol-border/25` on cards. The background stays plain: ink on paper.
- **Area and surface colors come from a new token module**, `packages/web/components/changes/areaColor.ts`, that returns `var(--sol-*)` strings, never Tailwind accent classes. `HEAT_COLOR` and `PROJECT_PALETTE` in `ActivityFeed.tsx` are hardcoded Solarized hex classes and break the minimal and graphite themes, so they are not reused here. The module maps: web `--sol-blue`, cli `--sol-green`, convex/backend `--sol-violet`, desktop/electron `--sol-cyan`, mobile `--sol-magenta`, shared `--sol-orange`, docs `--sol-text-dim`, extension `--sol-yellow`, others by a stable hash over `[blue, cyan, green, violet, magenta, orange, yellow]`. The same module is the one source for both areas and surfaces, so cli the area and cli the surface share a color.
- Accents render only as: the 6px area square, the lead story's 2px rail, ink bars, the live tile top border, kind glyphs. Fills use `color-mix(in srgb, var(--sol-x) 14%, transparent)`.
- Releases: `var(--sol-green)` for the stamp pill border.
- Risk is a texture, not a fill: `repeating-linear-gradient(135deg, color-mix(in srgb, var(--sol-red) 22%, transparent) 0 2px, transparent 2px 6px)` on a 3px edge or a 14px tile corner.
- Review rule: `grep -E "text-sol-(blue|green|cyan|violet|magenta|orange|yellow|red)|bg-sol-(blue|green|cyan|violet|magenta|orange|yellow|red)" packages/web/components/changes` must return nothing. It runs as a source test (task 13).

### 5.3 Spacing and density

Generous above the fold, dense below it. Header to strip 16px, strip to headline 28px, headline to standfirst 10px, standfirst to lead 28px, section blocks 24px apart, story rows 6px apart. The headline, lead story and the top of In the works fit above the fold at 900px tall with the strip present.

### 5.4 Motion

CSS only (keyframes in `globals.css` plus `tailwindcss-animate`). Nothing measures through `requestAnimationFrame`, because the Cast background tab stalls it.

- **First paint of an edition:** regions rise 4px and fade in over 220ms ease-out, staggered 40ms in reading order (headline, standfirst, strip, lead, In the works, sections). `animation-delay: calc(var(--i) * 40ms)` with `--i` set inline, capped at 10.
- **Prose arriving:** the deterministic text crossfades to prose over 180ms. No layout shift: dek and standfirst slots reserve their line count.
- **New ship while open:** the tile's version rolls in vertically (translateY 40% to 0 inside a clip, 220ms) and the top border pulses once. Nothing animates continuously; there is no ambient motion on a page meant to be left open.
- **Evidence drawer:** Radix accordion height animation. The story stays pinned at its screen position: its top is measured by `data-story-key` before the drawer opens, and the scroll takes up any difference after (a closing drawer above it). `useFlipAnimation` slides elements to new positions, so it cannot hold one still.
- **Changing day:** content slides 12px horizontally in the direction of travel, 160ms.
- `prefers-reduced-motion`: every transition becomes an instant swap.

## 6. Interactions, URL state, keyboard

### 6.1 Keyboard

Registered through the `shortcuts/` registry. Every hint renders as `<KeyCap>` with `isMac` and `formatShortcutParts`.

| Key | Action |
|---|---|
| `[` / `]` | Previous / next day (week in week mode) |
| `t` | Today |
| `j` / `k` | Next / previous story in reading order: lead, section blocks, In brief |
| `Enter` or `e` | Open / close the focused story's evidence drawer |
| `o` | Open the story's primary session, else its largest commit's `/commit/<sha>` |
| `u` | Scroll to the live strip and show "waiting" stories only |
| `r` | Risks only |
| `b` | Toggle main / all branches |
| `w` | Toggle Day / Week (phase 2) |
| `/` | Focus the filter field |
| `c` | Copy a permalink to the focused story |
| `Esc` | Close the drawer, then clear filters |

No Cmd or Ctrl wheel handling and no pinch handling. Browser zoom stays the browser's.

### 6.2 Hover

- Session pills: existing `EntityIdPill` hover cards (`SessionHoverContent`), which re-check session access.
- Commit sha: tooltip with the full subject.
- Release stamp or live tile: `HoverCard` listing the stories it carried and the version range.
- "why: from session": shows which insight it quoted.
- Risk hatch: tooltip with the computed signal and its evidence (shas, times).

### 6.3 URL state

All view state is in the query string, so a link pasted in team chat lands on the same view:

`/changes?repo=codecast-sh/codecast&d=2026-10-02&area=cli,web&person=<userId>&branches=all&risk=1&story=<story_key>`

- `story=` scrolls to the story, focuses it and opens its drawer.
- `w=2026-W40` selects week mode (phase 2).
- Day changes use `pushState`; focus and drawer use `replaceState`.
- `story_key` is a stable hash (section 7.2), so a permalink survives late commits and regenerations.

### 6.4 Filters

Filters run client-side over store rows and are instant. Repo (single select), area (multi), person (commit authors and team-visible session owners), branches, risk. Area filtering dims non-matching section blocks to 35% instead of removing them, so the shape of the day stays visible. **Filters never regenerate prose.** The edition headline and standfirst stay as written, and a deterministic line appears under them: "Showing 3 of 9 stories (cli)".

## 7. Generation pipeline

All generation lives in a new module `packages/convex/convex/changes.ts` (functions) with pure logic in `packages/shared/changes/`, exported as `@codecast/shared/changes` (imported by both Convex and web). Building runs inside an internal action that calls small paged internal queries, so the 1s user-JS and 16 MiB caps never apply to clustering.

### 7.1 Layer 0: facts (deterministic, free)

`changes.buildDay(team_id, repository, date)`:

1. **Read** commits for the team-local day through `commits.by_team_timestamp`, 200 per page, projecting only: sha, subject, body (600 chars), author name and email, timestamp, branch, repository, conversation_id, task_ids, insertions, deletions, and `files` collapsed to `{area: touches}` plus the top 8 paths. A 760-commit Littlebird day is about 400 KB.
2. **Dedupe rebase twins** on `(author_email, timestamp, subject)`. Keep the sha on the default branch (`repo_sources.default_branch`, else `main`, else `master`), else the newest `_creationTime`. Test fixtures: `c0e2a7aed`/`ca172db32` and `830683c2f`/`3d5b5984f` each collapse to one.
3. **Classify** each commit:
   - Release: `^(chore|release)(\((?<scope>[^)]+)\))?: (bump|release)\b.*?v?(?<ver>\d+\.\d+\.\d+)`. Restamp commits (`^chore\(cli\): restamp daemon build id`) fold into the nearest release burst. A burst is release commits within 10 minutes.
   - Conventional type and scope.
   - Area: `packages/<x>`, `apps/<x>`, `backend/<x>`, else the first path segment. The scope names the area when the files agree.
4. **Resolve sessions** through `teamVisibleInputs()` (section 8.4). A commit whose conversation fails the gate is "private provenance": its commit text is usable (it is team-readable today through `canAccessCommit`), its session is not.
5. **Cluster into stories**, in order:
   - (a) commits sharing a team-visible conversation, or team-visible conversations sharing a task. A session whose commits that day span 4 or more areas (`SPREAD_AREAS`) is committing a tree rather than pursuing one intent: it stays listed on every story its commits land in, but its commits group by rule (b). A session can cross that line mid-day, which retires its anchored story key; `buildDay` deletes stories whose key disappeared, and the commits land under their rule (b) keys;
   - (b) remaining commits grouped by (branch if not default, else area plus conventional scope) with a 3 hour gap;
   - (c) a default-branch batch commit touching 3 or more areas is split by area into slices, each joining the nearest default-branch story of its area within 3 hours; slices nothing claims stay together as the commit's own story. MVP splits by path only; phase 2 attributes slices to sessions through `file_changes` (section 12).
6. **Join PRs** through `pull_requests.linked_session_ids` and `external_events` `pr_merged` rows.
7. **Assign releases**: a story gets "shipped in X" when the first release of a surface whose paths cover the story's area comes after its last commit.
8. **Compute risk signals** (code decides, the model only words them):
   - `skew`: backend-path commits landed after the latest backend deploy marker while a web ship is newer than those commits. Suppressed when the team has no backend deploy markers (no false alarms).
   - `schema`: touches `schema.ts`, `migrations/`, `*.sql`, `prisma/`.
   - `revert`: a revert commit.
   - `bulk`: over 1,500 changed lines with no PR, no team-visible session and no task.
   - `blocked`: a team-visible blocked insight linked to the story.
   - Phase 2: `red_main` (latest default-branch check failed), `hotfix` (two or more fixes in the same area within 24h after a ship).

Output per story: `story_key`, commit shas, visible conversation ids, PR ids, area, branch, on_default_branch, diffstat, author names, first_at, last_at, release, risks, a deterministic headline (the cleaned subject of the largest commit, conventional prefix stripped, first letter capitalized) and a deterministic dek (other subjects joined, 160 chars), and `inputs_hash`.

### 7.2 Keys and hashes

- `story_key = hash64(team_id, repository, date, anchor)` where anchor is the anchor conversation id, or `branch|area|scope|first_sha` for clusters. Stable as late commits join.
- `inputs_hash = hash64(PROMPT_VERSION, sorted shas, for each visible insight its _id and generated_at, each visible conversation's effective visibility mode, each owner's membership level for the session, PR ids with updated_at, risk codes)`. Only fields the prompt uses are hashed, so unrelated churn never regenerates.
- `hash64` (`packages/shared/changes/keys.ts`) is a pure JS 64-bit hash, because Convex's default runtime has no node crypto: two independent 32-bit lanes, the existing FNV-1a and a multiply-xorshift lane.

### 7.3 Release and deploy signals

MVP sources, all landing as `external_events` rows so the existing team event stream sees them too:

1. **Version-bump commits on the default branch** (layer 0 regex). Zero setup; covers cli, desktop, extension on codecast.
2. **Tag pushes.** `githubWebhooks.ts:1356` returns "Not a branch push" today. Handle `refs/tags/*` there: insert `external_events { kind: "release", repository, payload: {tag, sha} }`.
3. **Convex deploy marker.** `packages/convex/deploy.sh` runs `cast ship mark --surface backend --sha <HEAD>` after a successful deploy. The CLI command posts to a new authenticated mutation `changes.markDeploy` that inserts `external_events { kind: "deploy", payload: {surface, sha, version?} }` for the repo's team. If the CLI is logged out, the mark is skipped with a warning and the deploy still succeeds.

Surface detection: a surface exists when it has at least one signal in 30 days. Path map defaults live in `packages/shared/changes/surfaces.ts`: cli `packages/cli/, packages/shared/`; desktop `packages/electron/, packages/web/, packages/shared/`; backend `packages/convex/`; web `packages/web/, packages/shared/`; extension `packages/chrome-extension/, packages/browser-extension/`. Teams without a mapped surface but with tags get one surface, `release`, covering everything.

Phase 2: GitHub `release` and `deployment_status` webhooks (Railway web deploys), which need a GitHub App permission update.

### 7.4 Layer 1: story prose (Haiku)

- **When:** for each story whose `inputs_hash` changed and that has settled (no new commit in the cluster for 20 minutes, or the day has ended).
- **Model:** `STRONG_MODEL` (Sonnet) through `callModel` in `convex/lib/anthropic.ts`, no temperature passed. `max_tokens` 400. Haiku was measured first and kept supplying motives no input stated (14 of 20 eval replays passed against Sonnet's 20 of 20).
- **Inputs**, in this order:
  - commit subjects and bodies (body 600 chars, at most 12 commits, largest first, `Codecast-Session` trailer stripped);
  - per-area diffstat and the top 8 file paths;
  - branch, and the release that carried it;
  - linked PR title and the first 800 chars of its body;
  - for each session that passed `teamVisibleInputs()`: insight `headline` and `summary` at mode `summary` or above, plus up to 8 `turns` (did items trimmed to 160 chars) only at mode `full` or `detailed`;
  - the risk codes with their evidence.
  - Never: `goal`, `what_changed`, `key_changes`, `next_action` (always empty), `themes` (noisy), titles or prompts of sessions that failed the gate.
- **Prompt intent** (principle level, no scripted phrasing): write for a teammate who was not there; say what changed for users or developers in plain words; state why only when an input says why and name which input in `why_source`; never name a session or person absent from the inputs; keep short ids like `jx7c6zk` and `#412` verbatim so `TextWithMentions` renders them; word each given risk in one line; no em dashes.
- **Output JSON:** `{headline ≤ 90, dek ≤ 160, body ≤ 3 sentences, kind: feature|fix|perf|infra|docs|test|release|revert, importance 1..5, why_source: session|commit|pr|none, risk_lines: {code: text}}`.
- **Skip path:** a single-commit story whose subject is a fix or feat sentence of 60 chars or more and has no session gets its subject as the headline and `why_source: commit` with no call.
- Example (real data): insight "Fixed slot starvation with launchd priority and queue batching" plus 3 cli commits produces "Agent helpers no longer starve when the machine is busy", `why_source: session`.

### 7.5 Layer 2: edition (one call per team, repo and day state)

- **When:** after a buildDay whose story set, importance ranking or release set changed. At most once per 60 minutes while the day is live, then a final pass after the day ends.
- **Model:** `STRONG_MODEL` (Sonnet) for every day, no temperature. It led with the day's news more reliably than Haiku on the edition evals (10 of 10 against 7 of 10).
- **Inputs:** for each story `{story_key, area, kind, importance, headline, dek, diffstat, release, author count, session count, risks}` (at most 80, ranked by importance then lines), release bursts and deploy markers, branch aggregates, team-visible blocked headlines, deterministic counts.
- **Output JSON:** `{edition_headline ≤ 110, standfirst ≤ 60 words, lead_story_key, section_order: area[], brief_story_keys[]}`.
- The edition reads only story prose and facts, so it inherits the story privacy boundary.

### 7.6 Day boundaries

The team day uses the timezone of the team's earliest admin member (`users.timezone`), else UTC. Task 1 adds `teams.timezone` (optional) and reads it first, so a team can set it explicitly. A team spread across zones gets one edition keyed to that zone; this is accepted.

### 7.7 Triggers and scheduling

Adopted from "zoom": a dirty row, debounced, owned by the scheduler. **A page view never spends tokens.**

- `change_dirty { team_id, repository, date, since, scheduled_id }`, index `by_key [team_id, repository, date]`.
- `markChangesDirty(ctx, team_id, repository, timestamp)` upserts the row for the team-local date and, if no run is scheduled, schedules `changes.rebuildDay` with `runAfter` 10 minutes, storing `scheduled_id`. A burst of 45 commits causes one rebuild. Called from:
  - commit insert sites: `githubWebhooks.ts` push handler (~1411), `repos.ts` (~743), `commits.ts` (~56);
  - `sessionInsights` upsert, when the insight's conversation has commits on that day;
  - `pr_merged` handling;
  - `changes.markDeploy` and the tag push branch;
  - `patchConversationVisibility` and membership visibility changes (through `invalidateForConversation`, section 8.4).
- `rebuildDay` runs layer 0, upserts stories, generates changed stories in parallel (8 at a time), then the edition if needed, then deletes the dirty row. It also rebuilds yesterday's edition until 03:00 team-local.
- A cron every 6 hours reconciles: it finds days with commits and no `final` edition in the last 3 days for teams with the flag on, and marks them dirty. This replaces editorial's 30-minute cron sweep.
- Rollout backfill: an internal action marks the last 14 days dirty for a team when its flag turns on, spaced 5 seconds apart per day.
- The page shows `stale` (a quiet "summarizing" dot) when a dirty row for the viewed day is older than 15 minutes.

### 7.8 Cost and caps

Haiku 4.5 at $1 / $5 per million tokens in / out; Sonnet at about $3 / $15.

| Team | Stories/day | Story calls | Edition | Total/day |
|---|---|---|---|---|
| codecast (~20 commits) | 9 to 20 | 20 × (2.5k in, 300 out) × 1.5 rewrites ≈ $0.12 | Haiku, 4 × (6k in, 800 out) ≈ $0.04 | about $0.16 |
| Littlebird (~760 commits, main only gets prose) | ~40 main | 40 × $0.0045 × 1.5 ≈ $0.27 | Sonnet, 4 × (15k in, 1.2k out) ≈ $0.25 | about $0.52 |
| Week (phase 2) | | | 1 Sonnet call | about $0.05 / week |

- **Per-team daily cap: $2.** Every call writes `model`, `input_tokens`, `output_tokens`, `cost_usd` on its row; `rebuildDay` sums today's cost for the team from `change_stories` and `digests` before calling. At the cap it stops, the deterministic text stays, the day's edition gets `capped_at`, and the footer says "Prose paused for today (daily limit)" whenever `capped_at` is set, whether or not the edition already has prose. The cap counts the spend on rows of one team day (its stories and editions), not calls made on one calendar day, so a 14-day backfill can spend up to the cap on each day it builds, and rows deleted by pruning take their spend with them. The check runs before each call while up to 8 story calls are in flight, so a day can pass the cap by a few cents.
- Branch-only stories never get prose in MVP; they live in In the works as counts.

### 7.9 Evals

Register `changes-story` and `changes-edition` as surfaces in `packages/evals`. Committed synthetic fixtures (the repo is public): a batch commit, a commit-only story with no stated why, a private-session case where the session is withheld, a member at `hidden` level, a Littlebird-style branch flood. Private freezes from the real 2026-10-02 codecast day live in `EVALS_HOME`. Gates in code: valid JSON, length limits, no em dash, `why_source = none` when no input states a reason, no session id or person name outside the inputs (the leak gate). Prompt changes are proven with `./evals check` reaching `separated: better`, never with post-hoc filters.

## 8. Data model, queries, store, access

### 8.1 Tables (`packages/convex/convex/schema.ts`)

**`change_stories` (new)**

| Field | Type | Notes |
|---|---|---|
| team_id | id teams | routing |
| repository | string | |
| date | string | team-local YYYY-MM-DD |
| story_key | string | stable hash |
| area, branch | string | |
| on_default_branch | boolean | |
| commit_shas | string[] | deduped |
| conversation_ids | id conversations[] | passed `teamVisibleInputs()` at build time, by construction |
| pr_ids | id pull_requests[] | |
| author_names | string[] | commit authors (already team-readable) |
| actor_user_ids | id users[] | owners of the visible sessions |
| insertions, deletions, files_changed | number | |
| area_counts | record | |
| release | optional {surface, version?, sha, at} | |
| risks | {code, evidence: string[]}[] | computed |
| first_at, last_at | number | |
| headline, dek | string | deterministic first, replaced by prose |
| body | optional string | |
| kind | string | |
| importance | number | deterministic default 2, prose overrides |
| why_source | optional "session"\|"commit"\|"pr"\|"none" | |
| risk_lines | optional record | |
| prose_status | "pending"\|"written"\|"failed"\|"skipped" | |
| inputs_hash | string | |
| generated_at, model, input_tokens, output_tokens, cost_usd | optional | |
| private_session_count | number | count only |

Indexes: `by_team_repo_date [team_id, repository, date]`, `by_story_key [story_key]`.

**`change_story_inputs` (new, side table for invalidation)**: `{story_id, conversation_id, owner_id}`, indexes `by_conversation`, `by_owner`, `by_story`.

**`change_dirty` (new)**: as in section 7.7.

**`digests` (reshaped; unused today, only `admin_mergeUser.ts` touches it)**:
- `user_id` becomes optional (it is required at schema.ts:3760); `events` becomes optional; `narrative` keeps the standfirst so old rows stay valid.
- Add optional: `repository`, `headline`, `lead_story_key`, `section_order: string[]`, `brief_story_keys: string[]`, `releases: [{surface, version?, sha, at}]`, `stats: {commits, stories, releases, people, sessions, private_sessions}`, `inputs_hash`, `model`, `input_tokens`, `output_tokens`, `cost_usd`, `status: "facts"|"written"|"final"|"failed"`, `capped_at` (when the daily cap first left prose of the day unwritten, independent of status).
- Scope stays `day | week | month`; team editions use `day` and `week`.
- Add index `by_team_repo_scope_date [team_id, repository, scope, date]`.
- `admin_mergeUser.ts` must skip rows with no `user_id`.

`day_timelines` is untouched.

### 8.2 Queries and mutations

Public queries live in `convex/changesQueries.ts`, `markDeploy` in `convex/changesDeploy.ts`, prose in `convex/changesProse.ts`, and the internal build functions in `convex/changes.ts`. All public functions call `requireTeamMembership(team_id)` and the feature flag check.

- `listStories({team_id, repository?, from_date, to_date})`: `change_stories` rows in the window. Delta feed.
- `listEditions({team_id, repository?, scope, from_date, to_date})`: `digests` rows plus a `stale` flag from `change_dirty`.
- `liveStatus({team_id, repository})`: per surface, the latest ship (version, sha, at, kind) and its waiting story count. Small, deterministic, read from `external_events` `release`/`deploy` rows plus layer 0 release commits cached on stories.
- `storyEvidence({story_id})`: the story's commit rows, each through `canAccessCommit`. Registered as an extra feed of the existing `commits` collection, so the drawer paints from the same cache `/commit` uses.
- `inTheWorks({team_id, repository?})`: team-visible insights from the last 48 hours with outcome `progress` or `blocked` (through `teamVisibleInputs()`, returning headline, outcome_type, conversation_id only), open PRs (capped 6), branch aggregates for today.
- `markDeploy({repository, surface, sha, version?})`: mutation for `cast ship mark`; requires the caller to be a member of the repo's team.
- Internal: `buildDay`, `rebuildDay`, `writeStory`, `writeEdition`, `invalidateForConversation`, `invalidateForMember`, `reconcile`, `backfill`.

Every read uses a team-scoped index window, never the global `by_timestamp` index that drops a team's commits on `/timeline`.

### 8.3 Web store (`packages/web/store/clientSyncRegistry.ts`, one registration each)

| Key | Kind | Sync | Indexes | Feeds | Replication |
|---|---|---|---|---|---|
| `changeStories` | collection, deferred hydration | `isDelta: true` | `_id, team_id, repository, date, area` | `changes.listStories` | shared |
| `changeEditions` | collection, deferred | `isDelta: true` | `_id, team_id, repository, scope, date` | `changes.listEditions` | shared |
| `changeLive` | collection, deferred | snapshot | `_id, team_id, repository, surface` | `changes.liveStatus` | shared |
| `changeWorks` | collection, deferred | snapshot | `_id, team_id, kind` | `changes.inTheWorks` | shared |

- Add `changes.storyEvidence` to the existing `commits` entry's `feeds`.
- Bump `CACHE_SCHEMA_VERSION` in `store/idbCache.ts`.
- Feeders: `packages/web/hooks/useSyncChanges.ts` beside `useSyncTimeline.ts`, using `useSyncCollection`, feeding a 7-day window around the viewed date. Per-view queries, so no `HostFeeders` gating.
- Readers: `useCollectionRows` with signatures of rendered fields only (story: `story_key|headline|dek|importance|prose_status|why_source|generated_at`; edition: `headline|status|inputs_hash`). Liveness churn never re-renders the page.
- Session pills and author faces: `EntityIdPill` (uses `useQueryNoThrow`) and the live roster through `lib/liveEntities`. No stored name blobs for people beyond commit author strings.
- The deterministic dek and headline shown before prose come from the row itself (layer 0 writes them), so the client never clusters a day. The shared module is imported by the client only for formatting helpers (`cleanSubject`, `areaOf`) used in the evidence drawer.

### 8.4 Access rules

**Both new tables are team-only by construction.** They carry no `workspace` key: a story cannot be private to one owner inside a team, because private inputs never enter it. Reads gate on `requireTeamMembership(team_id)`. No access path reads `team_id` as a grant for private data, because private data is never written to these rows.

**One gate: `teamVisibleInputs(ctx, team_id, conversationIds)`** in `convex/lib/changesAccess.ts`. It returns, for each conversation, either nothing or a mode: `summary` (headline and summary allowed) or `full` (turns allowed too). A conversation qualifies only when all of these hold:

1. `teamVisibleConvTeam(conv) === team_id` (privacy.ts:372);
2. the effective mode `resolveVisibilityMode(conv.team_visibility, ownerMembershipVisibilityAt(conv.started_at), true)` (privacy.ts:527) is not `minimal`. The membership level comes from `team_memberships.visibility_history` at the session's start time, so a member at `hidden` or `activity` contributes nothing to prose. This fixes the flaw all three designs shared;
3. the insight's own `team_id` equals the team.

Turns pass only at mode `full` or `detailed`. A source-level test (`changesAccess.guard.test.ts`) asserts that `buildDay` and the prompt builders read `session_insights` and `conversations` only through this helper.

**Invalidation.**
- `patchConversationVisibility` (lib/access.ts:188) schedules `invalidateForConversation(conversation_id)`. It finds stories through `change_story_inputs.by_conversation`, synchronously resets their prose to the deterministic text (`prose_status: pending`, body and why cleared) and marks their days dirty. The old text disappears in the same transaction, before any regeneration.
- A membership visibility change schedules `invalidateForMember(owner_id, team_id)` through `change_story_inputs.by_owner`, with the same behavior.
- The edition for each affected day is reset to its stats headline in the same pass.

**Commit messages from private sessions (explicit decision).** Commits are team-readable today through the `canAccessCommit` team fallback (lib/access.ts:123), so their subjects and bodies feed stories as commit-derived text. This matches current access and keeps the page truthful about what landed. The footer counts how many sessions contributed commit text only. Tightening this (dropping commit bodies of private-session commits, keeping subjects) is a one-line change in layer 0 if the founder wants it; it is listed as an open decision in section 12 rather than silently chosen.

## 9. Empty, loading, error and privacy states

| State | What the page shows |
|---|---|
| Cold cache | Skeleton only when `!ready && rows.length === 0`: header lines, one 30px bar, a 22px bar, four section rows. |
| Facts ready, prose pending | Deterministic headlines and deks render at once; a 1-line shimmer only where a dek is empty. Edition headline is the stats line in large type. A quiet "summarizing" dot in the header. |
| Prose failed | Deterministic text stays. Footer: "Prose unavailable for this edition; showing commit subjects." No client retry loop. |
| Daily cap reached | Deterministic text stays. Footer: "Prose paused for today (daily limit)." |
| Flag off | EmptyState: "Changes is not turned on for this team yet." |
| No team (personal workspace) | EmptyState: "Changes is written for a team. Join or create one to see it." |
| No commits ever | EmptyState: "Changes is written from your team's commits. Connect GitHub or run cast in a repo to start the first edition," with the existing GitHub install action. |
| Quiet day | "Nothing landed on main on Wed 1 Oct." Link to the previous edition. In the works still shows if branches moved. |
| No release signals | No live strip; footer hint about tags and deploy markers. |
| Surface with no recorded deploys | Tile reads "no signal yet", never a guessed version. |
| Private-heavy day | Stories still exist from commits; footer count of sessions not shared. No placeholder ever reveals a hidden session's title. |
| Filter hides everything | "No stories match these filters," with a clear-filters button. |
| Viewer filters to a member whose sessions are hidden | Only commit-derived stories appear, by construction. |

## 10. Build breakdown

Tasks are ordered by dependency. Each owns its files; no two tasks edit the same file except where noted.

**T1. Schema and team day.** Depends on nothing.
Files: `convex/schema.ts`, `convex/admin_mergeUser.ts`, `convex/lib/teamDay.ts` (new).
Work: add `change_stories`, `change_story_inputs`, `change_dirty`; reshape `digests` (optional `user_id` and `events`, new fields, new index); add `teams.timezone` and `teams.features.changes` to the features validator; `teamDayFor(ctx, team_id, timestamp)` returning the YYYY-MM-DD and the day's bounds.
Accept: `cast check convex` green; `admin_mergeUser` test passes with a team digest row; `teamDay.test.ts` covers UTC fallback and DST boundaries.

**T2. Shared layer 0 logic.** Depends on nothing.
Files: `packages/shared/changes/{classify,dedupe,cluster,surfaces,risks,keys,headline}.ts` and tests, exported as `@codecast/shared/changes`.
Work: pure functions for the release regex and burst grouping, dedupe, area, conventional parse, clustering (a, b, c), release assignment, risk signals, `story_key` and `inputs_hash`.
Accept: unit tests on fixtures copied from the 10-02 codecast day (scrubbed): the two rebase pairs collapse; the three release commits form one burst with restamp folded in; the 5-area ci commit `e7d2da040` splits into area slices (the line-pages commit `0de614861` touches only `packages/web`); a Littlebird-shaped 760-commit fixture clusters in under 200ms.

**T3. Access gate.** Depends on T1.
Files: `convex/lib/changesAccess.ts`, `convex/lib/changesAccess.test.ts`, `convex/changesAccess.guard.test.ts`.
Work: `teamVisibleInputs()` with conversation visibility, membership level at session start, and insight team match; `ownerMembershipVisibilityAt()` reading `visibility_history`.
Accept: tests for private, auto-shared, `team_visibility: summary`, membership `hidden`, membership `activity`, and a level change mid-history; the guard test fails if any `changes*` module reads `session_insights` or `conversations` outside the helper.

**T4. buildDay and storage.** Depends on T1, T2, T3.
Files: `convex/changes.ts` (internal part), `convex/changesBuild.test.ts`.
Work: paged internal queries, `buildDay`, `writeStory` (upsert by `story_key`, write `change_story_inputs`), deletion of stories whose key disappeared, deterministic headline and dek, `private_session_count`.
Accept: convex-test with seeded commits, insights and one private session: rows written, private session absent from `conversation_ids` and `change_story_inputs`, rerun is idempotent, a late commit keeps the same `story_key`.

**T5. Dirty scheduler and hooks.** Depends on T4.
Files: `convex/lib/changesDirty.ts`, small call additions in `convex/githubWebhooks.ts`, `convex/repos.ts`, `convex/commits.ts`, `convex/sessionInsights.ts`, `convex/lib/access.ts` (`patchConversationVisibility`), the membership visibility writer in `convex/teamVisibility.ts`, `convex/crons.ts`.
Work: `markChangesDirty`, `rebuildDay`, `invalidateForConversation`, `invalidateForMember`, 6-hour reconcile cron, flag-on backfill. Every hook is a no-op when the flag is off.
Accept: 45 inserted commits schedule one rebuild; a visibility flip clears story prose in the same mutation; tests confirm hooks do nothing with the flag off.

**T6. Release and deploy signals.** Depends on T1.
Files: `convex/githubWebhooks.ts` (tag branch at ~1356), `convex/changesDeploy.ts` (`markDeploy`), `packages/cli/src/shipCommand.ts` (new) and its registration in `packages/cli/src/index.ts`, `packages/convex/deploy.sh`.
Work: tag pushes insert `release` events; `cast ship mark --surface --sha [--version]`; `deploy.sh` calls it after success and never fails the deploy on a mark failure.
Accept: webhook test with a tag payload; CLI test against the messaging harness; a dry deploy run prints the mark and its result.

**T7. Story and edition prose.** Depends on T4, T5.
Files: `convex/changesProse.ts`, `convex/changesProse.test.ts`.
Work: prompt builders reading only `teamVisibleInputs()` output, Haiku story calls with the skip path and settle rule, edition call with the Haiku/Sonnet split, JSON parsing with fallback to deterministic text, token and cost recording, the per-team daily cap.
Accept: unit tests with a stubbed `callModel` for parse failure, cap reached, and settle deferral; one manual run against the codecast day through `prompt-dry-run.ts --call` produces valid JSON.

**T8. Evals surfaces.** Depends on T7.
Files: `packages/evals/src/registry.ts`, `packages/evals/fixtures/changes-story/*`, `packages/evals/fixtures/changes-edition/*`.
Work: register both surfaces, five synthetic fixtures, code gates (JSON, lengths, em dash, why_source none, leak gate). Private freezes of the real day in `EVALS_HOME`.
Accept: `./evals check changes-story --reps 5` and `changes-edition --reps 5` run and record a baseline; all gates pass on the baseline or the failures are filed.

**T9. Public queries.** Depends on T4, T6.
Files: `convex/changesQueries.ts`, `convex/changesQueries.test.ts`.
Work: `listStories`, `listEditions` with stale flag, `liveStatus`, `storyEvidence` through `canAccessCommit`, `inTheWorks` through the gate.
Accept: a non-member gets nothing; a member of team A never sees team B rows; `inTheWorks` excludes a `hidden`-level member's blocked insight; every query reads under 1 MiB on the Littlebird fixture.

**T10. Store registrations and feeders.** Depends on T9.
Files: `packages/web/store/clientSyncRegistry.ts`, `packages/web/store/idbCache.ts`, `packages/web/hooks/useSyncChanges.ts`.
Work: four registrations, the extra `commits` feed, replication classification, cache version bump, feeder hook.
Accept: registry signature test and `registeredFeeds.guard.test.ts` pass; `cast check web` green.

**T11. Route and shell wiring.** Depends on nothing in the web code; land after T10 so the page has data.
Files: `packages/web/src/App.tsx`, `components/TabContent.tsx`, `lib/tabRoutes.ts`, `components/DashboardLayout.tsx`, `src/routes.manifest.ts`, `components/sidebar/SidebarNav.tsx`, `lib/pathLabel.ts` and its test, `components/CommandPalette.tsx`.
Work: `/changes` route, full-width flag, Work rail row "Changes" next to Feed (shown only with the flag), breadcrumbs "Changes, Thu 2 Oct", palette entries "Open Changes", "Changes: yesterday", "Changes: risks only".
Accept: `routes.manifest.test.ts` and the pathLabel test pass.

**T12. Page components.** Depends on T10, T11.
Files: `packages/web/components/changes/` (new): `ChangesPage.tsx`, `ChangesHeader.tsx`, `LiveStrip.tsx`, `EditionHead.tsx`, `LeadStory.tsx`, `SectionBlock.tsx`, `StoryRow.tsx`, `ReleaseStamp.tsx`, `InBrief.tsx`, `InTheWorks.tsx`, `EvidenceDrawer.tsx`, `ChangesFooter.tsx`, `areaColor.ts`, `useChangesUrlState.ts`, `useChangesKeys.ts`; keyframes appended to `app/globals.css`.
Work: everything in sections 4 to 6 and 9. Reuse `DiffStat`, `MetaDot`, `DottedRow`, `AuthorAvatar` (entityDisplay), `EntityIdPill`, `TextWithMentions`, `CommitLinks`, `Pill`, `PrStatusChip`, `EmptyState`, `KeyCap`, `useFlipAnimation`, `formatDateSmart`, `relTimeShort`. No new `relTime`, no `HEAT_COLOR` or `PROJECT_PALETTE`.
Accept: `cast check web` green; the theme grep test (T13) passes; keyboard, URL round trip and filters work in the browser.

**T13. Guard tests for the web page.** Depends on T12.
Files: `packages/web/components/changes/__tests__/theme.guard.test.ts`, `.../urlState.test.ts`, `.../readingOrder.test.tsx`.
Work: no hardcoded accent classes under `components/changes`; URL parse and serialize round trip; j/k order matches DOM order for a two-column section grid.
Accept: tests pass and fail when a `text-sol-blue` class is added.

**T14. Rollout.** Depends on all.
Files: none in code beyond a one-off internal mutation call.
Work: run `packages/convex/deploy.sh` before pushing web (new functions plus web callers in one change), turn the flag on for Ashot's teams, run the 14-day backfill, watch cost on the rows for 3 days, then evaluate Littlebird.
Accept: 14 days of codecast editions written; total cost under $5; the verification plan in section 11 passes.

## 11. Verification plan

**Unit and convex tests** (run per file with `bun test <file>`, not the whole suite):
- T2 layer 0 fixtures, T3 access matrix, T4 idempotence and key stability, T5 debounce and synchronous invalidation, T7 prose fallbacks and cap, T9 cross-team isolation.
- A leak test end to end in convex-test: a session with a distinctive phrase in its insight summary, made private after its story is written. After `patchConversationVisibility`, no `change_stories` or `digests` row for the team contains the phrase, and the next rebuild still excludes it. Repeat with the owner's membership level set to `hidden`.

**Against prod data** (read-only):
- Dump the 2026-10-02 codecast day and a Littlebird day with `npx convex data` into a scratch dir outside git. Run `buildDay`'s pure core over them locally: codecast yields 6 to 20 stories with the 3 release commits as one burst; Littlebird main yields under 120 stories and branch aggregates for the rest.
- After T14, compare the written edition against `git log` for the day: every story's shas exist on main, and no story cites a session that `teamVisibleInputs()` rejects (query script asserts this for 14 days).
- Freeze 5 real stories and 2 editions into `EVALS_HOME`; `./evals check` must pass all gates.

**Browser** (`cast browser` in the human's Chrome, own tab):
- Screenshots of `/changes` for 2026-10-02 in all four themes (Solarized light and dark, minimal light, graphite dark) at 1440px and 900px wide. Check: no hardcoded Solarized hex visible under minimal and graphite, headline and lead above the fold at 900px tall.
- States: cold cache (cleared IDB), prose pending (a story row with `prose_status: pending` stubbed through `__inboxStore`), quiet day, no-signal team, filter with zero matches.
- Keyboard: `[`, `]`, `j`, `k`, `e`, `o`, `u`, `r`, `b`, `Esc`, and a pasted `?story=` link opening the drawer at the right story.
- Reduced motion on: no animation runs.
- Uploaded with `cast image`; no local paths.

## 12. Out of scope, and later phases

**Phase 2 (next):**
- Week view and its standfirst.
- All-branches prose lines in In the works.
- Batch commit attribution through `file_changes` paths of team-visible sessions within the commit's window, shown as "attributed by edits". This needs a **team-scoped** resolver: `blame.resolveCommitSessions` and `matchFileLines` (blame.ts:134, 235) take a viewer and check access per viewer, so the build adds `resolveCommitSessionsForTeam` that only considers conversations passing `teamVisibleInputs()`.
- The same overlap join for trailer-less teams (Littlebird is at 1.5% `conversation_id` coverage): match `file_changes` paths and times to commits within 6 hours, accept at 60% file overlap, mark "likely".
- GitHub `release` and `deployment_status` webhooks, so Railway web deploys light the web tile. Needs a GitHub App permission update.
- `red_main` and `hotfix` risks from mirrored check data.
- Squash-merge landing: store `merge_commit_sha` from the `pull_request` closed payload (the schema has none today, and `head_sha` is the PR branch tip, not the merge commit).

**Later:**
- The Why box: `path` or `path:line` through `repos.getBlame`, the team-scoped resolver, landing on the story with its asks quoted.
- Short ids for stories (`cs-N`) so chat and tasks render them as live pills.
- A morning one-line post of the edition headline in the team channel, and a `cast changes` CLI command printing the edition.
- A personal edition for teamless users, with a `workspace` key.
- Redirect `/timeline` to `/changes?branches=all`; retire `day_timelines`.
- Public changelog export from stories marked user-facing, replacing the hand-written `changelogData.ts`.

**Open decisions for the founder:**
- Whether commit bodies from sessions not shared with the team should feed prose (current default: yes, matching commit access; subjects only is a one-line change).
- Whether Littlebird-scale days use Sonnet for the edition by default.

**Not doing:** per-person views, effort metrics, semantic zoom with pinch or wheel, client-side clustering of whole days, any LLM call triggered by a page view.

## 13. How each review flaw is resolved

| Flaw | Resolution |
|---|---|
| Release wire only knows cli, desktop, extension | Tag pushes and `cast ship mark` from `deploy.sh` (T6); live strip shows "no signal yet" instead of implying web is not live |
| Day unit cannot say what is live | Live strip with waiting counts on top of the edition |
| `HEAT_COLOR` and `PROJECT_PALETTE` are hardcoded classes | New `areaColor.ts` returning `var(--sol-*)`; a guard test bans accent classes |
| CSS columns plus hover dek jump and break j/k order | Grid of independent blocks; dek always rendered in reserved space |
| Edition on Sonnet every recompose, 30-minute sweep | Dirty-row debounce, Haiku by default, 60-minute recompose cap, $2 daily team cap |
| Member-level visibility ignored | `teamVisibleInputs()` applies membership level at session start; membership changes invalidate |
| `resolveCommitSessions` is viewer-scoped | Not used in MVP; phase 2 adds a team-scoped resolver |
| Pinch and wheel hijack browser zoom | No wheel or pinch handling |
| Ship-log visuals collapse for single-surface teams | Edition is the main view for every team; strip appears only with signals |
| Always-on marching dashes | No ambient motion; animate only on change |
| Squash-merge landing via `head_sha` | Deferred until `merge_commit_sha` is stored |
| Turns sent at `summary` visibility | Turns pass only at `full` or `detailed` |
| Private-session commit messages | Explicit decision recorded in 8.4 and 12, counted in the footer |
